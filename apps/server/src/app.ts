import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import pino from 'pino';
import { z } from 'zod';
import { World, type createDb } from '@terrarium/persistence';
import {
  agentInputSchema,
  historyInputSchema,
  messageInputSchema,
  roomInputSchema,
  runCommandSchema,
  type ConversationMessage,
  type Result,
} from '@terrarium/shared';
import {
  listChatGptModels,
  type ChatGptAuth,
  type LmProvider,
} from '@terrarium/lm-providers';
import { Scheduler } from './scheduler.js';
import { performTurn } from './turns.js';

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
  const publishMessage = (message: ConversationMessage) => {
    config.emit('conversation:message', message);
    terrain.emit('conversation:message', message);
  };
  const publishWorld = async () => {
    const state = await world.state();
    config.emit('world:state', state);
    terrain.emit(
      'rooms:list',
      state.rooms.map((room) => room.id),
    );
  };
  const scheduler = new Scheduler(
    world,
    (agent, signal, current, applied) =>
      performTurn(
        world,
        agent,
        options.provider,
        signal,
        current,
        publishMessage,
        publishWorld,
        applied,
      ),
    (state) => config.emit('run:state', state),
  );
  scheduler.watch();

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
                  /^(Room|Agent|Destination|ChatGPT|Connect ChatGPT|Reconnect|A ChatGPT)/.test(
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
      const message = await world.speak(input.roomId, input.message);
      publishMessage(message);
      return message;
    });
    command('history:get', historyInputSchema, (input) => world.history(input));
    command('rooms:save', roomInputSchema, async (input) => {
      const room = await world.saveRoom(input);
      await publishWorld();
      return room;
    });
    command('agents:save', agentInputSchema, async (input) => {
      const agent = await world.saveAgent(input);
      await scheduler.changed();
      await publishWorld();
      return agent;
    });
    command('run:control', runCommandSchema, async (input) => {
      if (
        input === 'start' &&
        options.auth &&
        (!options.auth.status().connected || options.auth.status().pending)
      )
        throw new Error('Connect ChatGPT before starting agents.');
      if (input === 'start') await scheduler.start();
      else if (input === 'pause') scheduler.pause();
      else scheduler.stop();
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
    scheduler.close();
    options.auth?.close();
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
  return { app, io, world, scheduler, publishMessage };
}
