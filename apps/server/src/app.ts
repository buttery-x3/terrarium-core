import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import pino from 'pino';
import { z } from 'zod';
import { World, type createDb } from '@terrarium/persistence';
import {
  agentInputSchema,
  deleteAgentSchema,
  configurationSchema,
  configurationImportSchema,
  clearHistorySchema,
  historyInputSchema,
  messageInputSchema,
  roomInputSchema,
  runCommandSchema,
  settingsSchema,
  diagnosticFilterSchema,
  relationshipFilterSchema,
  type ConversationMessage,
  type ConversationExport,
  type Result,
} from '@terrarium/shared';
import {
  listChatGptModels,
  type ChatGptAuth,
  type LmProvider,
} from '@terrarium/lm-providers';
import { Scheduler } from './scheduler.js';
import { performDecision, previewDecision } from './reflection.js';
import { performRelationshipSummary, previewRelationshipSummary } from './relationships.js';
import { performNews, previewNews } from './news.js';
import { performMediaVote, previewMediaVote } from './media.js';

function conversationMarkdown(snapshot: ConversationExport) {
  const label = (value: string) => value
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
  const lines = ['# Terrarium conversations', '', `Exported: ${snapshot.exportedAt}`, ''];
  for (const room of snapshot.rooms) {
    lines.push(`## ${label(room.name)}`, '');
    if (!room.messages.length) lines.push('_No messages._', '');
    for (const message of room.messages) {
      if (message.type !== 'speak') {
        lines.push(`*${label(message.content)}* — ${label(message.speaker)} · ${message.type} · ${label(message.createdAt)} · ${label(message.id)}`, '');
        continue;
      }
      lines.push(`**${label(message.speaker)}** — ${label(message.createdAt)}`, '');
      lines.push(message.content.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n'), '');
    }
  }
  return lines.join('\n');
}

export async function createApplication(options: {
  db: ReturnType<typeof createDb>;
  origins: string[];
  provider: LmProvider;
  auth?: ChatGptAuth;
  quiet?: boolean;
}) {
  const logger = pino({
    level: options.quiet ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  });
  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, { origin: options.origins });
  app.get('/health', async () => ({ status: 'ok' }));
  const io = new Server(app.server, {
    cors: { origin: options.origins },
    allowRequest(request, callback) {
      let hostAllowed = false;
      try {
        hostAllowed = ['127.0.0.1', 'localhost'].includes(
          new URL(`http://${request.headers.host}`).hostname,
        );
      } catch {}
      callback(
        null,
        hostAllowed &&
          typeof request.headers.origin === 'string' &&
          options.origins.includes(request.headers.origin),
      );
    },
  });
  const config = io.of('/config'),
    terrain = io.of('/terrain');
  const world = new World(options.db);
  await world.interruptUnfinished();
  let clearingHistory = false;
  const checkHistoryWrite = () => {
    if (clearingHistory)
      throw new Error('Conversation clearing is in progress. Try again when it finishes.');
  };
  let importingConfiguration = false;
  const checkConfigurationWrite = () => {
    if (importingConfiguration)
      throw new Error('Configuration import is in progress. Try again when it finishes.');
  };
  const publishMessage = (message: ConversationMessage) => {
    scheduler.observe(message);
    config.emit('conversation:message', message);
    terrain.emit('conversation:message', message);
    config.emit('reflection:changed');
    config.emit('news:changed');
  };
  const publishWorld = async () => {
    const state = await world.state();
    config.emit('world:state', state);
    config.emit('reflection:changed');
    config.emit('news:changed');
    config.emit('media:changed');
    terrain.emit(
      'rooms:list',
      state.rooms.map((room) => room.id),
    );
  };
  const scheduler = new Scheduler(
    world,
    async (agent, signal, current, applied, attemptId, opportunity) => {
      const result = await performDecision(
        world,
        agent,
        options.provider,
        signal,
        current,
        publishMessage,
        publishWorld,
        applied,
        attemptId,
        opportunity!,
      );
      config.emit('reflection:changed');
      config.emit('relationships:changed');
      config.emit('media:changed');
      return result;
    },
    (state) => { config.emit('run:state', state); config.emit('diagnostics:changed'); },
    undefined,
    async (agent, targetAgentId, signal, current, applied, attemptId) => {
      await performRelationshipSummary(world, agent, targetAgentId, options.provider, signal, current, applied, attemptId);
      config.emit('relationships:changed');
    },
    async (signal, current, applied, dueAt, requestedAt) => {
      try { await performNews(world, options.provider, signal, current, applied, publishMessage, dueAt, requestedAt); }
      finally { config.emit('news:changed'); }
    },
    {
      vote: async (agent, ballotId, signal, current, applied, attemptId) => {
        try { await performMediaVote(world, agent, ballotId, options.provider, signal, current, applied,
          async events => { events.forEach(publishMessage); config.emit('media:changed'); }, attemptId); }
        finally { config.emit('media:changed'); }
      },
      changed: async events => {
        events.forEach(publishMessage);
        config.emit('media:changed');
      },
    },
  );
  scheduler.watch();
  const energyUpdates = setInterval(() => {
    void world.agents().then(agents => config.emit('energy:state', agents.map(({ id, energy }) => ({ id, energy }))))
      .catch(() => config.emit('operation:error', 'Could not read current energy.'));
    void world.mediaState().then(state => config.emit('media:state', state))
      .catch(() => config.emit('operation:error', 'Could not read current media activity.'));
  }, 1000);

  config.on('connection', (socket) => {
    const sendInitial = async () => {
      socket.emit('world:state', await world.state());
      socket.emit('run:state', scheduler.snapshot());
      socket.emit(
        'auth:state',
        options.auth?.status() ?? { connected: false, pending: false },
      );
    };
    void sendInitial().catch((error) => {
      logger.error({ error }, 'initial state failed');
      socket.emit('operation:error', 'Could not load world state.');
    });
    const command = <Schema extends z.ZodTypeAny, Output>(
      name: string,
      schema: Schema,
      action: (value: z.output<Schema>) => Promise<Output>,
    ) => {
      socket.on(name, async (payload: unknown, acknowledge: unknown) => {
        let result: Result<Output>;
        try {
          result = { ok: true, value: await action(schema.parse(payload)) };
        } catch (error) {
          logger.error({ error, command: name }, 'command failed');
          const message =
            error instanceof z.ZodError
              ? error.issues
                  .map(
                    (issue) =>
                      `${issue.path.join('.') || 'Input'}: ${issue.message}`,
                  )
                  .join('; ')
              : error instanceof Error &&
                  /^(Room|Agent|Destination|ChatGPT|Connect ChatGPT|Reconnect|A ChatGPT|Configuration|Conversation|Diagnostics)/.test(
                    error.message,
                  )
                ? error.message
                : 'The operation could not be saved or completed. Try again.';
          result = { ok: false, error: message };
        }
        if (typeof acknowledge === 'function') acknowledge(result);
        else if (!result.ok) socket.emit('operation:error', result.error);
      });
    };
    command('config:message', messageInputSchema, async (input) => {
      checkHistoryWrite();
      const message = await world.speak(input.roomId, input.message);
      publishMessage(message);
      return message;
    });
    command('history:get', historyInputSchema, (input) => world.history(input));
    command('history:export', z.object({}).strict(), async () =>
      conversationMarkdown(await world.exportConversations()),
    );
    command('history:clear', clearHistorySchema, async (input) => {
      checkHistoryWrite();
      if (scheduler.snapshot().state !== 'stopped')
        throw new Error('Conversation clearing requires a stopped run. Choose Stop first.');
      clearingHistory = true;
      try {
        const result = await world.clearHistory(input);
        config.emit('conversation:cleared', result);
        config.emit('reflection:changed');
        terrain.emit('conversation:cleared', result);
        return result;
      } finally {
        clearingHistory = false;
      }
    });
    command('rooms:save', roomInputSchema, async (input) => {
      checkConfigurationWrite();
      const room = await world.saveRoom(input);
      await publishWorld();
      return room;
    });
    command('agents:save', agentInputSchema, async (input) => {
      checkConfigurationWrite();
      const agent = await world.saveAgent(input);
      await scheduler.changed();
      await publishWorld();
      return agent;
    });
    command('agents:delete', deleteAgentSchema, async (input) => {
      checkConfigurationWrite();
      const deleted = await world.deleteAgent(input.id);
      await scheduler.changed();
      await publishWorld();
      return deleted;
    });
    command('config:export', z.object({}).strict(), () =>
      world.exportConfiguration(),
    );
    command('settings:save', settingsSchema, async input => {
      checkConfigurationWrite();
      if (scheduler.snapshot().state !== 'stopped') throw new Error('Configuration settings require a stopped run. Choose Stop first.');
      importingConfiguration = true;
      try { const saved = await world.saveSettings(input); await publishWorld(); return saved; }
      finally { importingConfiguration = false; }
    });
    command('reflection:list', z.object({}).strict(), () => world.reflections());
    command('news:state', z.object({}).strict(), () => world.newsState());
    command('news:history', z.object({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
      input => world.newsHistory(input));
    command('news:preview', z.object({}).strict(), () => previewNews(world));
    command('media:state', z.object({}).strict(), () => world.mediaState());
    command('media:ballots', z.object({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
      input => world.mediaBallots(input));
    command('media:ballot', z.object({ id: z.string().min(1) }).strict(), input => world.mediaBallot(input.id));
    command('media:preview', z.object({ agentId: z.string().min(1), ballotId: z.string().min(1) }).strict(), async input => {
      const agent = await world.agent(input.agentId);
      if (!agent) throw new Error('Agent does not exist.');
      return previewMediaVote(world, agent, input.ballotId);
    });
    command('relationships:list', relationshipFilterSchema, input => world.relationshipPage(input));
    command('relationships:appraisals', relationshipFilterSchema, input => world.appraisals(input));
    command('relationships:appraisal', z.object({ id: z.string().min(1) }).strict(), input => world.appraisal(input.id));
    command('relationships:summaries', z.object({ observerId: z.string().min(1), targetAgentId: z.string().min(1),
      beforeVersion: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
      input => world.relationshipSummaries(input.observerId, input.targetAgentId, input.beforeVersion, input.limit));
    command('relationships:preview', z.object({ observerId: z.string().min(1), targetAgentId: z.string().min(1) }).strict(), async input => {
      const agent = await world.agent(input.observerId);
      if (!agent) throw new Error('Agent does not exist.');
      return previewRelationshipSummary(world, agent, input.targetAgentId);
    });
    command('relationships:reset', z.object({ confirm: z.literal(true) }).strict(), async () => {
      checkConfigurationWrite(); checkHistoryWrite();
      if (scheduler.snapshot().state !== 'stopped') throw new Error('Configuration relationship reset requires a stopped run. Choose Stop first.');
      if (scheduler.hasActiveWork()) throw new Error('Configuration relationship reset must wait for cancelled requests to finish.');
      importingConfiguration = true;
      try {
        const result = await world.resetRelationshipMemory();
        config.emit('relationships:changed'); config.emit('reflection:changed');
        return result;
      } finally { importingConfiguration = false; }
    });
    command('prompt:preview', z.object({ agentId: z.string().min(1), operation: z.enum(['reflection', 'speech', 'emote']).optional() }).strict(), async input => {
      const agent = await world.agent(input.agentId);
      if (!agent) throw new Error('Agent does not exist.');
      const operation = input.operation ?? 'reflection';
      return previewDecision(world, agent, { reflection: operation === 'reflection', speech: operation === 'speech', emote: operation === 'emote', requestedAt: Date.now(), reason: 'cadence' });
    });
    command('diagnostics:list', diagnosticFilterSchema, input => world.diagnostics(input));
    command('diagnostics:export', diagnosticFilterSchema, input => world.diagnostics(input, true));
    command('diagnostics:get', z.object({ id: z.string().min(1) }).strict(), input => world.diagnostic(input.id));
    command('diagnostics:usage', z.object({}).strict(), () => world.diagnosticUsage());
    command('diagnostics:clear', z.object({ confirm: z.literal(true) }).strict(), async () => {
      checkConfigurationWrite();
      if (scheduler.snapshot().state !== 'stopped') throw new Error('Diagnostics clearing requires a stopped run. Choose Stop first.');
      if (scheduler.hasActiveWork()) throw new Error('Diagnostics clearing must wait for cancelled attempts to finish. Try again shortly.');
      importingConfiguration = true;
      try { const deleted = await world.clearDiagnostics(); config.emit('diagnostics:changed'); return deleted; }
      finally { importingConfiguration = false; }
    });
    command('config:preview', configurationSchema, (input) =>
      world.previewConfiguration(input),
    );
    command('config:import', configurationImportSchema, async (input) => {
      checkConfigurationWrite();
      if (scheduler.snapshot().state !== 'stopped')
        throw new Error('Configuration import requires a stopped run. Choose Stop first.');
      importingConfiguration = true;
      try {
        const result = await world.importConfiguration(
          input.configuration, input.previewToken,
        );
        await scheduler.changed();
        await publishWorld();
        return result;
      } finally {
        importingConfiguration = false;
      }
    });
    command('run:control', runCommandSchema, async (input) => {
      if (input === 'start') checkHistoryWrite();
      if (input === 'start') checkConfigurationWrite();
      if (
        input === 'start' &&
        options.auth &&
        (!options.auth.status().connected || options.auth.status().pending)
      )
        throw new Error('Connect ChatGPT before starting agents.');
      if (input === 'start') await scheduler.start();
      else if (input === 'pause') scheduler.pause();
      else { await scheduler.stop(); config.emit('reflection:changed'); }
      return scheduler.snapshot();
    });
    command('auth:models', z.object({}).strict(), async () => {
      if (!options.auth) throw new Error('ChatGPT connection is unavailable.');
      return listChatGptModels(options.auth);
    });
    command('auth:login', z.object({}).strict(), async () => {
      if (!options.auth) throw new Error('ChatGPT connection is unavailable.');
      const login = await options.auth.beginSignIn();
      config.emit('auth:state', options.auth.status());
      void login.completion
        .catch(() => {})
        .finally(() => config.emit('auth:state', options.auth!.status()));
      return { url: login.url };
    });
  });
  terrain.on('connection', (socket) => {
    socket.on('history:get', async (input: unknown, acknowledge: unknown) => {
      if (typeof acknowledge !== 'function') return;
      try { acknowledge({ ok: true, value: await world.history(historyInputSchema.parse(input)) }); }
      catch { acknowledge({ ok: false, error: 'Could not load room activity.' }); }
    });
    void world
      .rooms()
      .then((rooms) =>
        socket.emit(
          'rooms:list',
          rooms.map((room) => room.id),
        ),
      )
      .catch((error) => logger.error({ error }, 'terrain state failed'));
  });
  app.addHook('preClose', async () => {
    clearInterval(energyUpdates);
    await scheduler.close();
    options.auth?.close();
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
  return { app, io, world, scheduler, publishMessage };
}
