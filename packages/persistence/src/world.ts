import { createHash, randomUUID } from 'node:crypto';
import { actionSchema, clearHistorySchema, configurationSchema, settingsSchema, diagnosticFilterSchema, resolveScheduling, timingOverridesSchema } from '@terrarium/shared';
import type { Kysely, Selectable } from 'kysely';
import type {
  Agent,
  AgentAction,
  AgentInput,
  ConversationMessage,
  ConversationExport,
  Configuration,
  ConfigurationPreview,
  ClearHistoryInput,
  HistoryCleared,
  HistoryInput,
  HistoryPage,
  RoomInput,
  WorldState,
  Settings, AttemptDetails, DiagnosticFilter, DiagnosticRecord, DiagnosticPage, DiagnosticUsage,
  ReflectionState,
} from '@terrarium/shared';
import type { DB } from './index.js';

export class DiagnosticError extends Error {}
export class ActionError extends Error {
  constructor(readonly category: 'stale' | 'world-validation' | 'persistence', message: string) { super(message); }
}

const agentRecord = (row: Selectable<DB['agents']>): Agent => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  roomId: row.room_id,
  provider: 'chatgpt',
  model: row.model,
  enabled: Boolean(row.enabled),
  minIntervalMs: row.min_interval_ms,
  maxIntervalMs: row.max_interval_ms,
  contextMessageLimit: row.context_message_limit,
  revision: row.revision,
  motivations: row.motivations,
  intention: row.intention,
  energy: row.energy,
  ...(row.timing_overrides !== '{}' ? { timingOverrides: timingOverridesSchema.parse(JSON.parse(row.timing_overrides)) } : {}),
});
const messageRecord = (
  row: Selectable<DB['messages']>,
): ConversationMessage => ({
  id: row.id,
  roomId: row.room_id,
  agentId: row.agent_id,
  speaker: row.speaker_name,
  createdAt: row.created_at,
  content: row.content,
  type: row.type,
  ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
  ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
});
export type ReflectionUpdate = { reaction?: string | null; intention?: string | null; engagement?: ReflectionState['engagement'] };
export type DecisionUpdate = {
  sourceIds?: readonly string[]; reflection?: { reaction: string | null; intention: string | null } | null;
  engagement?: ReflectionState['engagement']; targetAgentId?: string | null;
};
const emptyReflection = (agentId: string): ReflectionState => ({ agentId, reflectedAt: null, reaction: null, intention: null,
  lastSpeechAt: null, lastEmoteAt: null, engagement: null });
const reflectionRecord = (row: Selectable<DB['reflections']>): ReflectionState => ({ agentId: row.agent_id,
  reflectedAt: row.reflected_at, reaction: row.reaction, intention: row.intention,
  lastSpeechAt: row.last_speech_at, lastEmoteAt: row.last_emote_at,
  engagement: row.engagement_room_id && row.engagement_root_message_id && row.engagement_target_agent_id ? {
    roomId: row.engagement_room_id, rootMessageId: row.engagement_root_message_id, targetAgentId: row.engagement_target_agent_id,
  } : null,
});

export class World {
  private energyClock: number | undefined;
  constructor(readonly db: Kysely<DB>) {}

  async rooms() {
    return (await this.db.selectFrom('rooms').selectAll().orderBy('id').execute())
      .map(({ is_food_source, ...room }) => ({ ...room, isFoodSource: Boolean(is_food_source) }));
  }
  async agents() {
    return (
      await this.db.selectFrom('agents').selectAll().orderBy('id').execute()
    ).map(agentRecord);
  }
  async agent(id: string) {
    const row = await this.db
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? agentRecord(row) : undefined;
  }
  async state() {
    const settings = await this.settings();
    return { rooms: await this.rooms(), agents: await this.agents(), settings: settings.value, settingsVersion: settings.version };
  }

  async settings() {
    const row = await this.db.selectFrom('settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    return { value: settingsSchema.parse(JSON.parse(row.value)), version: row.version };
  }

  async validateSettings(value: Settings) {
    const settings = settingsSchema.parse(value);
    for (const agent of await this.agents()) resolveScheduling(settings, agent);
    if (settings.energy.enabled && !(await this.rooms()).some(room => room.isFoodSource))
      throw new Error('Configuration requires at least one food-source room before energy can be enabled.');
    if ((await this.agents()).some(agent => agent.energy > settings.energy.maximum))
      throw new Error('Configuration maximum energy cannot be below an agent\'s current energy.');
    return settings;
  }

  async saveSettings(value: Settings) {
    return this.db.transaction().execute(async db => {
      const settings = await new World(db).validateSettings(value);
      await db.updateTable('settings').set(({ eb }) => ({ value: JSON.stringify(settings), version: eb('version', '+', 1) })).where('id', '=', 1).execute();
      if (!settings.scheduling.engagementEnabled) await new World(db).clearEngagements();
      return new World(db).settings();
    });
  }

  async syncEnergy(now = Date.now(), running = this.energyClock !== undefined) {
    const elapsed = this.energyClock === undefined ? 0 : Math.max(0, now - this.energyClock);
    this.energyClock = running ? now : undefined;
    if (!elapsed) return;
    await this.db.transaction().execute(async db => {
      const { energy } = (await new World(db).settings()).value;
      if (!energy.enabled) return;
      const depletion = elapsed / 60000 * energy.depletionPerMinute;
      await db.updateTable('agents').set(({ eb, fn }) => ({ energy: fn<number>('max', [eb('energy', '-', depletion), eb.val(0)]) }))
        .where('enabled', '=', 1).execute();
    });
  }

  async exportConfiguration(): Promise<Configuration> {
    return this.db.transaction().execute(async (db) => {
      const state = await new World(db).state();
      return configurationSchema.parse({
        format: 'terrarium-config',
        version: 4,
        settings: state.settings,
        rooms: state.rooms,
        agents: state.agents.map(({ revision, energy, ...agent }) => agent),
      });
    });
  }

  async exportConversations(): Promise<ConversationExport> {
    return this.db.transaction().execute(async (db) => {
      const rooms = await db.selectFrom('rooms')
        .select(['id', 'name']).orderBy('id').execute();
      const rows = await db.selectFrom('messages').selectAll()
        .orderBy('room_id').orderBy('created_at').orderBy('id').execute();
      const messages = new Map<string, ConversationMessage[]>();
      for (const row of rows) {
        const roomMessages = messages.get(row.room_id) ?? [];
        roomMessages.push(messageRecord(row));
        messages.set(row.room_id, roomMessages);
      }
      return {
        exportedAt: new Date().toISOString(),
        rooms: rooms.map(room => ({ ...room, messages: messages.get(room.id) ?? [] })),
      };
    });
  }

  private configurationPreview(
    configuration: Configuration,
    state: WorldState,
  ): ConfigurationPreview {
    const roomIds = new Set(
      [...state.rooms, ...configuration.rooms].map((room) => room.id),
    );
    for (const agent of configuration.agents) {
      if (!roomIds.has(agent.roomId))
        throw new Error(
          `Configuration agent ${JSON.stringify(agent.name)} refers to an unknown room: ${JSON.stringify(agent.roomId)}.`,
        );
    }
    const rooms = new Set(state.rooms.map((room) => room.id));
    const agents = new Set(state.agents.map((agent) => agent.id));
    const defaults: string[] = [];
    if (configuration.version === 1) {
      defaults.push('Shared settings and existing newer profile/food fields are preserved.');
      for (const room of configuration.rooms)
        if (!rooms.has(room.id)) defaults.push(`Room ${room.id}: food source = false.`);
      for (const agent of configuration.agents)
        if (!agents.has(agent.id)) defaults.push(`Agent ${agent.id}: empty motivations/intention; initial energy ${state.settings.energy.initial}.`);
    }
    if (configuration.version === 2) defaults.push('Older settings include default observable-event and emote guidance when absent. Personal memories are not imported.');
    if (configuration.version < 4) defaults.push('Older settings use shared reflection, speech and emote timing defaults when absent. Private reflections are not imported.');
    const settings = configuration.version >= 2 ? configuration.settings! : state.settings;
    const mergedRooms = new Map(state.rooms.map(room => [room.id, room]));
    for (const room of configuration.rooms) mergedRooms.set(room.id, { ...room, isFoodSource: room.isFoodSource ?? mergedRooms.get(room.id)?.isFoodSource ?? false });
    if (settings.energy.enabled && ![...mergedRooms.values()].some(room => room.isFoodSource))
      throw new Error('Configuration requires at least one food-source room while energy is enabled.');
    if (state.agents.some(agent => agent.energy > settings.energy.maximum))
      throw new Error('Configuration maximum energy cannot be below an agent\'s current energy.');
    const mergedAgents = new Map(state.agents.map(agent => [agent.id, agent]));
    for (const agent of configuration.agents) mergedAgents.set(agent.id, { ...mergedAgents.get(agent.id), ...agent } as Agent);
    for (const agent of mergedAgents.values()) resolveScheduling(settings, agent);
    return {
      token: createHash('sha256')
        .update(JSON.stringify({ configuration, state: { ...state, agents: state.agents.map(({ energy, ...agent }) => agent) } }))
        .digest('hex'),
      rooms: configuration.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        operation: rooms.has(room.id) ? 'update' : 'add',
      })),
      agents: configuration.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        operation: agents.has(agent.id) ? 'update' : 'add',
      })),
      defaults,
      settingsChanged: JSON.stringify(settings) !== JSON.stringify(state.settings),
    };
  }

  async previewConfiguration(
    input: Configuration,
  ): Promise<ConfigurationPreview> {
    const configuration = configurationSchema.parse(input);
    return this.db
      .transaction()
      .execute(async (db) =>
        this.configurationPreview(
          configuration,
          await new World(db).state(),
        ),
      );
  }

  async importConfiguration(
    input: Configuration,
    previewToken: string,
  ): Promise<ConfigurationPreview> {
    const configuration = configurationSchema.parse(input);
    return this.db.transaction().execute(async (db) => {
      const state = await new World(db).state();
      const preview = this.configurationPreview(configuration, state);
      if (preview.token !== previewToken)
        throw new Error(
          'Configuration changed since preview. Preview the file again before importing.',
        );
      // INVARIANT: the preview covers both the submitted file and the current saved configuration.
      for (const room of configuration.rooms) {
        const values = { id: room.id, name: room.name, description: room.description,
          is_food_source: Number(room.isFoodSource ?? state.rooms.find(saved => saved.id === room.id)?.isFoodSource ?? false) };
        await db
          .insertInto('rooms')
          .values(values)
          .onConflict((conflict) =>
            conflict
              .column('id')
              .doUpdateSet({
                name: room.name,
                description: room.description,
                is_food_source: values.is_food_source,
              }),
          )
          .execute();
      }
      const revisions = new Map(
        state.agents.map((agent) => [agent.id, agent.revision]),
      );
      for (const agent of configuration.agents) {
        const previous = state.agents.find(saved => saved.id === agent.id);
        const values = {
          id: agent.id,
          name: agent.name,
          instructions: agent.instructions,
          room_id: agent.roomId,
          provider: agent.provider,
          model: agent.model,
          enabled: Number(agent.enabled),
          min_interval_ms: agent.minIntervalMs,
          max_interval_ms: agent.maxIntervalMs,
          context_message_limit: agent.contextMessageLimit,
          revision: (revisions.get(agent.id) ?? -1) + 1,
          motivations: agent.motivations ?? previous?.motivations ?? '',
          intention: agent.intention ?? previous?.intention ?? '',
          energy: previous?.energy ?? (configuration.version >= 2 ? configuration.settings! : state.settings).energy.initial,
          timing_overrides: JSON.stringify(agent.timingOverrides ?? previous?.timingOverrides ?? {}),
        };
        await db
          .insertInto('agents')
          .values(values)
          .onConflict((conflict) =>
            conflict.column('id').doUpdateSet(values),
          )
          .execute();
        await new World(db).trimMemory(agent.id, agent.contextMessageLimit);
        if (previous && (previous.roomId !== agent.roomId || !agent.enabled)) await new World(db).clearEngagements(agent.id);
      }
      if (configuration.version >= 2) await db.updateTable('settings').set(({ eb }) => ({
        value: JSON.stringify(configuration.settings), version: eb('version', '+', 1),
      })).where('id', '=', 1).execute();
      if (configuration.settings && configuration.version >= 2 && !configuration.settings.scheduling.engagementEnabled)
        await new World(db).clearEngagements();
      return preview;
    });
  }

  async saveRoom(input: RoomInput) {
    return this.db.transaction().execute(async db => {
    const world = new World(db);
    const rooms = await world.rooms();
    const isFoodSource = input.isFoodSource ?? rooms.find(room => room.id === input.id)?.isFoodSource ?? false;
    if (!isFoodSource && (await world.settings()).value.energy.enabled && !rooms.some(room => room.id !== input.id && room.isFoodSource))
      throw new Error('Configuration cannot remove the last food-source room while energy is enabled.');
    const id = input.id ?? randomUUID();
    if (input.id) {
      const found = await db
        .updateTable('rooms')
        .set({ name: input.name, description: input.description, is_food_source: Number(isFoodSource) })
        .where('id', '=', id)
        .executeTakeFirst();
      if (!found.numUpdatedRows) throw new Error('Room does not exist.');
    } else {
      await db
        .insertInto('rooms')
        .values({ id, name: input.name, description: input.description, is_food_source: Number(isFoodSource) })
        .execute();
    }
    return { id, name: input.name, description: input.description, isFoodSource };
    });
  }

  async saveAgent(input: AgentInput) {
    await this.syncEnergy();
    return this.db.transaction().execute(async (db) => {
      const previous = input.id ? await new World(db).agent(input.id) : undefined;
      const timingOverrides = input.timingOverrides ?? previous?.timingOverrides;
      resolveScheduling((await new World(db).settings()).value, { timingOverrides });
      if (
        !(await db
          .selectFrom('rooms')
          .select('id')
          .where('id', '=', input.roomId)
          .executeTakeFirst())
      )
        throw new Error('Room does not exist.');
      const id = input.id ?? randomUUID();
      const values = {
        name: input.name,
        instructions: input.instructions,
        room_id: input.roomId,
        provider: input.provider,
        model: input.model,
        enabled: Number(input.enabled),
        min_interval_ms: input.minIntervalMs,
        max_interval_ms: input.maxIntervalMs,
        context_message_limit: input.contextMessageLimit,
        motivations: input.motivations ?? previous?.motivations ?? '',
        intention: input.intention ?? previous?.intention ?? '',
        timing_overrides: JSON.stringify(timingOverrides ?? {}),
      };
      if (input.id) {
        const updated = await db
          .updateTable('agents')
          .set(({ eb }) => ({ ...values, revision: eb('revision', '+', 1) }))
          .where('id', '=', id)
          .executeTakeFirst();
        if (!updated.numUpdatedRows) throw new Error('Agent does not exist.');
      } else {
        await db
          .insertInto('agents')
          .values({ ...values, id, revision: 0, energy: (await new World(db).settings()).value.energy.initial })
          .execute();
      }
      await new World(db).trimMemory(id, input.contextMessageLimit);
      if (previous && (previous.roomId !== input.roomId || !input.enabled)) await new World(db).clearEngagements(id);
      return agentRecord(
        await db
          .selectFrom('agents')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      );
    });
  }

  async deleteAgent(id: string) {
    return this.db.transaction().execute(async db => {
      const result = await db
        .deleteFrom('agents')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (!result.numDeletedRows) throw new Error('Agent does not exist.');
      await db.deleteFrom('observations').where('agent_id', '=', id).execute();
      await new World(db).clearEngagements(id);
      await db.deleteFrom('reflections').where('agent_id', '=', id).execute();
      return { id };
    });
  }

  private async trimMemory(agentId: string, limit: number) {
    await this.db.deleteFrom('observations').where('agent_id', '=', agentId)
      .where('sequence', 'not in', this.db.selectFrom('observations').select('sequence')
        .where('agent_id', '=', agentId).orderBy('sequence', 'desc').limit(limit)).execute();
  }

  async memory(agentId: string): Promise<ConversationMessage[]> {
    return (await this.db.selectFrom('observations').innerJoin('messages', 'messages.id', 'observations.message_id')
      .selectAll('messages').where('observations.agent_id', '=', agentId)
      .orderBy('observations.sequence', 'asc').execute()).map(messageRecord);
  }

  async reflection(agentId: string): Promise<ReflectionState> {
    const row = await this.db.selectFrom('reflections').selectAll().where('agent_id', '=', agentId).executeTakeFirst();
    return row ? reflectionRecord(row) : emptyReflection(agentId);
  }

  async reflections(): Promise<ReflectionState[]> {
    const rows = new Map((await this.db.selectFrom('reflections').selectAll().execute()).map(row => [row.agent_id, reflectionRecord(row)]));
    return (await this.agents()).map(agent => rows.get(agent.id) ?? emptyReflection(agent.id));
  }

  async clearEngagements(agentId?: string) {
    let query = this.db.updateTable('reflections').set({ engagement_room_id: null, engagement_root_message_id: null, engagement_target_agent_id: null });
    if (agentId) query = query.where(eb => eb.or([eb('agent_id', '=', agentId), eb('engagement_target_agent_id', '=', agentId)]));
    await query.execute();
  }

  async validateReply(agentId: string, replyToId: string, sourceIds?: readonly string[]): Promise<ConversationMessage> {
    const actor = await this.agent(agentId);
    const source = await this.db.selectFrom('messages').selectAll().where('id', '=', replyToId).executeTakeFirst();
    // INVARIANT: supplied source IDs come from the server-owned observation snapshot before the request.
    const witnessed = sourceIds ? sourceIds.includes(replyToId) : Boolean(await this.db.selectFrom('observations').select('sequence')
      .where('agent_id', '=', agentId).where('message_id', '=', replyToId).executeTakeFirst());
    const author = source ? await this.agent(source.agent_id) : undefined;
    if (!actor || !source || source.type !== 'speak' || !witnessed || source.room_id !== actor.roomId ||
      !author || !author.enabled || author.id === agentId || author.roomId !== actor.roomId)
      throw new ActionError('world-validation', 'A reply requires witnessed speech from another agent still in this room.');
    return { ...messageRecord(source), conversationId: source.conversation_id ?? source.id };
  }

  private async writeReflection(agentId: string, update: ReflectionUpdate, sourceIds?: readonly string[], publicAction?: { type: 'speak' | 'emote'; createdAt: string }) {
    for (const [key, limit] of [['reaction', 1000], ['intention', 240]] as const) {
      const value = update[key];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > limit))
        throw new ActionError('world-validation', `Private ${key} exceeds its allowed length.`);
    }
    if (update.engagement) {
      const actor = await this.agent(agentId), target = await this.agent(update.engagement.targetAgentId);
      const sources = sourceIds ? await this.db.selectFrom('messages').selectAll().where('id', 'in', [...sourceIds]).execute().then(rows => rows.map(messageRecord)) : await this.memory(agentId);
      if (!(await this.settings()).value.scheduling.engagementEnabled || !actor || !target || !target.enabled || actor.id === target.id ||
        actor.roomId !== update.engagement.roomId || target.roomId !== actor.roomId ||
        !sources.some(source => source.type === 'speak' && source.roomId === actor.roomId && source.agentId === target.id &&
          (source.conversationId ?? source.id) === update.engagement!.rootMessageId))
        throw new ActionError('world-validation', 'Engagement requires a witnessed local exchange and a present interlocutor.');
    }
    const state = await this.reflection(agentId);
    if (update.reaction !== undefined || update.intention !== undefined) state.reflectedAt = new Date().toISOString();
    if (update.reaction !== undefined) state.reaction = update.reaction;
    if (update.intention !== undefined) state.intention = update.intention;
    if (update.engagement !== undefined) state.engagement = update.engagement;
    if (publicAction?.type === 'speak') state.lastSpeechAt = publicAction.createdAt;
    if (publicAction?.type === 'emote') state.lastEmoteAt = publicAction.createdAt;
    const values = { agent_id: agentId, reflected_at: state.reflectedAt, reaction: state.reaction, intention: state.intention,
      last_speech_at: state.lastSpeechAt, last_emote_at: state.lastEmoteAt, engagement_room_id: state.engagement?.roomId ?? null,
      engagement_root_message_id: state.engagement?.rootMessageId ?? null, engagement_target_agent_id: state.engagement?.targetAgentId ?? null };
    await this.db.insertInto('reflections').values(values).onConflict(conflict => conflict.column('agent_id').doUpdateSet(values)).execute();
    return state;
  }

  async saveReflection(agentId: string, revision: number, update: ReflectionUpdate, stillCurrent: () => boolean, attemptId?: string) {
    return this.db.transaction().execute(async db => {
      const world = new World(db), agent = await world.agent(agentId);
      const check = () => {
        if (!agent || !agent.enabled || agent.revision !== revision || !stillCurrent()) throw new ActionError('stale', 'This reflection is no longer current.');
      };
      check();
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This attempt has already ended.');
      }
      const reflection = await world.writeReflection(agentId, update);
      if (attemptId) await world.updateDiagnostic(attemptId, { reflection }, 'applied', 'reflect');
      check();
      return reflection;
    });
  }

  private async insertMessage(
    db: Kysely<DB>,
    roomId: string,
    agentId: string,
    speaker: string,
    content: string,
    type: ConversationMessage['type'] = 'speak',
    reply?: ConversationMessage,
  ) {
    if (
      !(await db
        .selectFrom('rooms')
        .select('id')
        .where('id', '=', roomId)
        .executeTakeFirst())
    )
      throw new Error('Room does not exist.');
    const last = await db
      .selectFrom('messages')
      .select('created_at')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const previousTime = last ? Date.parse(last.created_at) : 0;
    // INVARIANT: new timestamps advance so reconnect cursors cannot miss same-millisecond inserts.
    const createdAt = new Date(
      Math.max(
        Date.now(),
        Number.isFinite(previousTime) ? previousTime + 1 : 0,
      ),
    ).toISOString();
    const message: ConversationMessage = {
      id: randomUUID(),
      roomId,
      agentId,
      speaker,
      content,
      createdAt,
      type,
    };
    if (type === 'speak') message.conversationId = reply?.conversationId ?? reply?.id ?? message.id;
    if (reply) message.replyToId = reply.id;
    await db
      .insertInto('messages')
      .values({
        id: message.id,
        room_id: roomId,
        agent_id: agentId,
        speaker_name: speaker,
        content,
        created_at: createdAt,
        type,
        reply_to_id: message.replyToId ?? null,
        conversation_id: message.conversationId ?? null,
      })
      .execute();
    const observers = await db.selectFrom('agents').select(['id', 'context_message_limit']).where('room_id', '=', roomId).execute();
    for (const observer of observers) {
      await db.insertInto('observations').values({ agent_id: observer.id, message_id: message.id }).execute();
      await new World(db).trimMemory(observer.id, observer.context_message_limit);
    }
    return message;
  }

  async speak(roomId: string, content: string) {
    return this.db
      .transaction()
      .execute((db) =>
        this.insertMessage(db, roomId, 'config-ui', 'Human', content),
      );
  }

  async clearHistory(input: ClearHistoryInput): Promise<HistoryCleared> {
    const selection = clearHistorySchema.parse(input);
    return this.db.transaction().execute(async (db) => {
      let rooms = db.selectFrom('rooms').select('id');
      if (selection.scope === 'room')
        rooms = rooms.where('id', '=', selection.roomId);
      const roomIds = (await rooms.execute()).map((room) => room.id);
      if (selection.scope === 'room' && !roomIds.length)
        throw new Error('Room does not exist.');
      let observedMessages = db.selectFrom('messages').select('id');
      if (selection.scope === 'room') observedMessages = observedMessages.where('room_id', '=', selection.roomId);
      await db.deleteFrom('observations').where('message_id', 'in', observedMessages).execute();
      await db.updateTable('reflections').set({ engagement_room_id: null, engagement_root_message_id: null, engagement_target_agent_id: null })
        .where('engagement_room_id', 'in', roomIds).execute();
      let query = db.deleteFrom('messages');
      if (selection.scope === 'room')
        query = query.where('room_id', '=', selection.roomId);
      const result = await query.executeTakeFirstOrThrow();
      return { roomIds, deletedMessages: Number(result.numDeletedRows) };
    });
  }

  async history(input: HistoryInput, limit = 100): Promise<HistoryPage> {
    if (
      !(await this.db
        .selectFrom('rooms')
        .select('id')
        .where('id', '=', input.roomId)
        .executeTakeFirst())
    )
      throw new Error('Room does not exist.');
    let query = this.db
      .selectFrom('messages')
      .selectAll()
      .where('room_id', '=', input.roomId);
    const cursor = input.before ?? input.after;
    if (cursor) {
      const operator = input.after ? '>' : '<';
      query = query.where((eb) =>
        eb.or([
          eb('created_at', operator, cursor.createdAt),
          eb.and([
            eb('created_at', '=', cursor.createdAt),
            eb('id', operator, cursor.id),
          ]),
        ]),
      );
    }
    const direction = input.after ? 'asc' : 'desc';
    const rows = await query
      .orderBy('created_at', direction)
      .orderBy('id', direction)
      .limit(limit + 1)
      .execute();
    const messages = rows.slice(0, limit).map(messageRecord);
    return {
      messages: input.after ? messages : messages.reverse(),
      hasMore: rows.length > limit,
    };
  }

  async applyAction(
    agentId: string,
    revision: number,
    action: AgentAction,
    stillCurrent: () => boolean,
    attemptId?: string,
    decision?: DecisionUpdate,
  ) {
    action = actionSchema.parse(action);
    await this.syncEnergy();
    return this.db.transaction().execute(async (db) => {
      const row = await db
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', agentId)
        .executeTakeFirst();
      if (!row) throw new ActionError('stale', 'This agent has been deleted.');
      const check = () => {
        if (!stillCurrent() || !row.enabled || row.revision !== revision)
          throw new ActionError('stale', 'This turn is no longer current.');
      };
      check();
      const world = new World(db);
      const settings = (await world.settings()).value;
      if (action.type === 'emote' && !settings.activity.emotesEnabled)
        throw new ActionError('world-validation', 'Emotes are disabled; use wait for a quiet turn.');
      if (decision?.targetAgentId) {
        const target = await world.agent(decision.targetAgentId);
        if (!target || !target.enabled || target.id === agentId || target.roomId !== row.room_id)
          throw new ActionError('stale', 'The intended interlocutor is no longer in this room.');
      }
      const reply = action.type === 'speak' && action.replyToId ? await world.validateReply(agentId, action.replyToId, decision?.sourceIds) : undefined;
      if (decision?.reflection || decision?.engagement !== undefined) await world.writeReflection(agentId, {
        ...decision.reflection, ...(decision.engagement !== undefined ? { engagement: decision.engagement } : {}),
      }, decision.sourceIds);
      let message: ConversationMessage | undefined;
      const events: ConversationMessage[] = [];
      if (action.type === 'speak' || action.type === 'emote')
        message = await this.insertMessage(
          db,
          row.room_id,
          row.id,
          row.name,
          action.message,
          action.type,
          reply,
        );
      if (action.type === 'move') {
        const destination = await db
          .selectFrom('rooms')
          .selectAll()
          .where('id', '=', action.roomId)
          .executeTakeFirst();
        if (!destination)
          throw new ActionError('world-validation', 'Destination room does not exist.');
        const observableMove = action.roomId !== row.room_id && settings.activity.roomEventsEnabled;
        if (observableMove) {
          const origin = await db.selectFrom('rooms').selectAll().where('id', '=', row.room_id).executeTakeFirstOrThrow();
          events.push(await this.insertMessage(db, row.room_id, row.id, row.name, `${row.name} leaves ${origin.name}.`, 'departure'));
        }
        await db
          .updateTable('agents')
          .set({ room_id: action.roomId, revision: row.revision + 1 })
          .where('id', '=', row.id)
          .execute();
        if (action.roomId !== row.room_id) await world.clearEngagements(row.id);
        if (observableMove)
          events.push(await this.insertMessage(db, action.roomId, row.id, row.name, `${row.name} enters ${destination.name}.`, 'arrival'));
      }
      let energyAfter = row.energy;
      if (action.type === 'eat') {
        const energy = (await new World(db).settings()).value.energy;
        const room = await db.selectFrom('rooms').selectAll().where('id', '=', row.room_id).executeTakeFirst();
        if (!energy.enabled) throw new ActionError('world-validation', 'Energy is disabled; eating is unavailable.');
        if (!room?.is_food_source) throw new ActionError('world-validation', 'Eating requires a food-source room.');
        energyAfter = energy.maximum;
        await db.updateTable('agents').set({ energy: energyAfter }).where('id', '=', row.id).execute();
      }
      const moved = action.type === 'move' && action.roomId !== row.room_id;
      const reflection = message ? await world.writeReflection(agentId, {}, undefined, { type: action.type as 'speak' | 'emote', createdAt: message.createdAt }) : await world.reflection(agentId);
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This attempt has already ended.');
        const details: AttemptDetails = JSON.parse(record.details);
        await new World(db).updateDiagnostic(attemptId, {
          sourceRoomId: row.room_id, destinationRoomId: action.type === 'move' ? action.roomId : row.room_id,
          moved, ...(message ? { messageId: message.id } : {}), eventIds: events.map(event => event.id), energyBefore: row.energy, energyAfter,
          passiveDecay: Math.max(0, (details.energySeen ?? row.energy) - row.energy),
          reflection,
        }, action.type === 'move' && !moved ? 'applied-noop' : 'applied', action.type);
      }
      check();
      return { message, events, moved, energyBefore: row.energy, energyAfter, reflection };
    });
  }

  async diagnosticUsage(): Promise<DiagnosticUsage> {
    const totals = await this.db.selectFrom('decisions').select(({ fn }) => [
      fn.sum<number>('bytes').as('bytes'), fn.sum<number>('reserved_bytes').as('reserved'),
    ]).executeTakeFirstOrThrow();
    return { bytes: Number(totals.bytes ?? 0), reservedBytes: Number(totals.reserved ?? 0),
      limitBytes: (await this.settings()).value.diagnostics.maxPayloadMiB * 1024 * 1024, retention: 'manual' };
  }

  async scheduleTurn(agent: Agent, dueAt: number, operation = 'action', requestedAt = Date.now()) {
    try {
      const id = randomUUID();
      const usage = await this.diagnosticUsage();
      if (usage.bytes + usage.reservedBytes + 4096 > usage.limitBytes) throw new Error('Diagnostic capacity reached. Export/clear diagnostics or increase the budget while stopped.');
      await this.db.insertInto('decisions').values({
        id, turn_id: id, agent_id: agent.id, agent_name: agent.name, room_id: agent.roomId,
        scheduled_at: new Date().toISOString(), due_at: new Date(dueAt).toISOString(), started_at: null, ended_at: null,
        attempt: 0, model: agent.model, action: null, outcome: 'scheduled', details: '{}', bytes: 1024, reserved_bytes: 0,
        operation, requested_at: new Date(requestedAt).toISOString(),
      }).execute();
      return id;
    } catch (error) { throw new DiagnosticError(`Diagnostics could not schedule a turn: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async startAttempt(turnId: string, number: number, agent: Agent) {
    try {
      return await this.db.transaction().execute(async db => {
        const world = new World(db);
        const usage = await world.diagnosticUsage();
        const reserved = 8 * 1024 * 1024;
        if (usage.bytes + usage.reservedBytes + reserved > usage.limitBytes)
          throw new Error('Diagnostic capacity reached. Export/clear diagnostics or increase the budget while stopped.');
        const turn = await db.selectFrom('decisions').selectAll().where('id', '=', turnId).executeTakeFirstOrThrow();
        const id = randomUUID(), started = new Date().toISOString();
        await db.insertInto('decisions').values({ ...turn, sequence: undefined, id, room_id: agent.roomId,
          started_at: started, ended_at: null, attempt: number, outcome: 'running', reserved_bytes: reserved }).execute();
        await db.updateTable('decisions').set({ started_at: turn.started_at ?? started, outcome: 'running' }).where('id', '=', turnId).execute();
        return id;
      });
    } catch (error) { throw new DiagnosticError(`Diagnostics could not start an attempt: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async updateDiagnostic(id: string, additions: AttemptDetails, outcome?: string, action?: string) {
    try {
      const row = await this.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      // INVARIANT: late completion cannot replace a terminal cancellation or an applied action.
      if (row.ended_at && !(row.outcome.startsWith('applied') && outcome === 'applied-notification-failure')) return;
      const details = JSON.stringify({ ...JSON.parse(row.details), ...additions });
      const bytes = Buffer.byteLength(details) + 1024;
      if (row.reserved_bytes && bytes > row.reserved_bytes)
        throw new Error('Attempt exceeded its reserved diagnostic capacity; request was not submitted/applied.');
      await this.db.updateTable('decisions').set({ details, bytes,
        ...(action ? { action } : {}),
        ...(outcome ? { outcome, ended_at: new Date().toISOString(), reserved_bytes: 0 } : {}),
      }).where('id', '=', id).where('outcome', '=', row.outcome)
        .where('ended_at', row.ended_at === null ? 'is' : '=', row.ended_at).execute();
    } catch (error) { throw new DiagnosticError(`Diagnostics could not be saved: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async endTurn(turnId: string, outcome: string) {
    try {
      await this.db.updateTable('decisions').set({ outcome, ended_at: new Date().toISOString() })
        .where('id', '=', turnId).where('ended_at', 'is', null).execute();
    } catch { throw new DiagnosticError('Diagnostics could not finish the turn.'); }
  }

  async interruptUnfinished() {
    await this.db.updateTable('decisions').set({ outcome: 'interrupted', ended_at: new Date().toISOString(), reserved_bytes: 0 })
      .where('ended_at', 'is', null).execute();
    await this.clearEngagements();
  }

  async diagnostics(input: DiagnosticFilter = {}, details = false): Promise<DiagnosticPage> {
    const filter = diagnosticFilterSchema.parse(input);
    let query = this.db.selectFrom('decisions');
    if (filter.agentId) query = query.where('agent_id', '=', filter.agentId);
    if (filter.roomId) query = query.where('room_id', '=', filter.roomId);
    if (filter.action) query = query.where('action', '=', filter.action);
    if (filter.outcome) query = query.where('outcome', '=', filter.outcome);
    if (filter.from) query = query.where('scheduled_at', '>=', filter.from);
    if (filter.to) query = query.where('scheduled_at', '<=', filter.to);
    if (filter.before) query = query.where('sequence', '<', filter.before);
    const rows = await query.select(details ? [
      'sequence', 'id', 'turn_id', 'agent_id', 'agent_name', 'room_id', 'scheduled_at', 'due_at', 'started_at', 'ended_at', 'attempt', 'model', 'action', 'outcome', 'details', 'operation', 'requested_at',
    ] : ['sequence', 'id', 'turn_id', 'agent_id', 'agent_name', 'room_id', 'scheduled_at', 'due_at', 'started_at', 'ended_at', 'attempt', 'model', 'action', 'outcome', 'operation', 'requested_at'])
      .orderBy('sequence', 'desc').limit(filter.limit + 1).execute();
    const records = rows.slice(0, filter.limit).map(row => this.diagnosticRecord(row));
    return { records, hasMore: rows.length > filter.limit, next: records.at(-1)?.sequence };
  }

  private diagnosticRecord(row: Omit<Selectable<DB['decisions']>, 'bytes' | 'reserved_bytes' | 'details'> & { details?: string }): DiagnosticRecord {
    return { sequence: row.sequence, id: row.id, turnId: row.turn_id, agentId: row.agent_id, agentName: row.agent_name,
      roomId: row.room_id, scheduledAt: row.scheduled_at, dueAt: row.due_at, startedAt: row.started_at, endedAt: row.ended_at,
      attempt: row.attempt, model: row.model, action: row.action, outcome: row.outcome,
      operation: row.operation, ...(row.requested_at ? { requestedAt: row.requested_at } : {}),
      ...(row.details ? { details: JSON.parse(row.details) } : {}) };
  }

  async diagnostic(id: string) {
    return this.diagnosticRecord(await this.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  }

  async clearDiagnostics() {
    return this.db.deleteFrom('decisions').executeTakeFirstOrThrow().then(result => Number(result.numDeletedRows));
  }
}
