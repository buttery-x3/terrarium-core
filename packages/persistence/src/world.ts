import { createHash, randomUUID } from 'node:crypto';
import { clearHistorySchema, configurationSchema, settingsSchema, diagnosticFilterSchema } from '@terrarium/shared';
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
        version: 2,
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
    const settings = configuration.version === 2 ? configuration.settings! : state.settings;
    const mergedRooms = new Map(state.rooms.map(room => [room.id, room]));
    for (const room of configuration.rooms) mergedRooms.set(room.id, { ...room, isFoodSource: room.isFoodSource ?? mergedRooms.get(room.id)?.isFoodSource ?? false });
    if (settings.energy.enabled && ![...mergedRooms.values()].some(room => room.isFoodSource))
      throw new Error('Configuration requires at least one food-source room while energy is enabled.');
    if (state.agents.some(agent => agent.energy > settings.energy.maximum))
      throw new Error('Configuration maximum energy cannot be below an agent\'s current energy.');
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
          energy: previous?.energy ?? (configuration.version === 2 ? configuration.settings! : state.settings).energy.initial,
        };
        await db
          .insertInto('agents')
          .values(values)
          .onConflict((conflict) =>
            conflict.column('id').doUpdateSet(values),
          )
          .execute();
      }
      if (configuration.version === 2) await db.updateTable('settings').set(({ eb }) => ({
        value: JSON.stringify(configuration.settings), version: eb('version', '+', 1),
      })).where('id', '=', 1).execute();
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
    const result = await this.db
      .deleteFrom('agents')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (!result.numDeletedRows) throw new Error('Agent does not exist.');
    return { id };
  }

  private async insertMessage(
    db: Kysely<DB>,
    roomId: string,
    agentId: string,
    speaker: string,
    content: string,
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
    };
    await db
      .insertInto('messages')
      .values({
        id: message.id,
        room_id: roomId,
        agent_id: agentId,
        speaker_name: speaker,
        content,
        created_at: createdAt,
      })
      .execute();
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
  ) {
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
      let message: ConversationMessage | undefined;
      if (action.type === 'speak')
        message = await this.insertMessage(
          db,
          row.room_id,
          row.id,
          row.name,
          action.message,
        );
      if (action.type === 'move') {
        if (
          !(await db
            .selectFrom('rooms')
            .select('id')
            .where('id', '=', action.roomId)
            .executeTakeFirst())
        )
          throw new ActionError('world-validation', 'Destination room does not exist.');
        await db
          .updateTable('agents')
          .set({ room_id: action.roomId, revision: row.revision + 1 })
          .where('id', '=', row.id)
          .execute();
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
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This attempt has already ended.');
        const details: AttemptDetails = JSON.parse(record.details);
        await new World(db).updateDiagnostic(attemptId, {
          sourceRoomId: row.room_id, destinationRoomId: action.type === 'move' ? action.roomId : row.room_id,
          moved, ...(message ? { messageId: message.id } : {}), energyBefore: row.energy, energyAfter,
          passiveDecay: Math.max(0, (details.energySeen ?? row.energy) - row.energy),
        }, action.type === 'move' && !moved ? 'applied-noop' : 'applied', action.type);
      }
      check();
      return { message, moved, energyBefore: row.energy, energyAfter };
    });
  }

  async diagnosticUsage(): Promise<DiagnosticUsage> {
    const totals = await this.db.selectFrom('decisions').select(({ fn }) => [
      fn.sum<number>('bytes').as('bytes'), fn.sum<number>('reserved_bytes').as('reserved'),
    ]).executeTakeFirstOrThrow();
    return { bytes: Number(totals.bytes ?? 0), reservedBytes: Number(totals.reserved ?? 0),
      limitBytes: (await this.settings()).value.diagnostics.maxPayloadMiB * 1024 * 1024, retention: 'manual' };
  }

  async scheduleTurn(agent: Agent, dueAt: number) {
    try {
      const id = randomUUID();
      const usage = await this.diagnosticUsage();
      if (usage.bytes + usage.reservedBytes + 4096 > usage.limitBytes) throw new Error('Diagnostic capacity reached. Export/clear diagnostics or increase the budget while stopped.');
      await this.db.insertInto('decisions').values({
        id, turn_id: id, agent_id: agent.id, agent_name: agent.name, room_id: agent.roomId,
        scheduled_at: new Date().toISOString(), due_at: new Date(dueAt).toISOString(), started_at: null, ended_at: null,
        attempt: 0, model: agent.model, action: null, outcome: 'scheduled', details: '{}', bytes: 1024, reserved_bytes: 0,
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
      'sequence', 'id', 'turn_id', 'agent_id', 'agent_name', 'room_id', 'scheduled_at', 'due_at', 'started_at', 'ended_at', 'attempt', 'model', 'action', 'outcome', 'details',
    ] : ['sequence', 'id', 'turn_id', 'agent_id', 'agent_name', 'room_id', 'scheduled_at', 'due_at', 'started_at', 'ended_at', 'attempt', 'model', 'action', 'outcome'])
      .orderBy('sequence', 'desc').limit(filter.limit + 1).execute();
    const records = rows.slice(0, filter.limit).map(row => this.diagnosticRecord(row));
    return { records, hasMore: rows.length > filter.limit, next: records.at(-1)?.sequence };
  }

  private diagnosticRecord(row: Omit<Selectable<DB['decisions']>, 'bytes' | 'reserved_bytes' | 'details'> & { details?: string }): DiagnosticRecord {
    return { sequence: row.sequence, id: row.id, turnId: row.turn_id, agentId: row.agent_id, agentName: row.agent_name,
      roomId: row.room_id, scheduledAt: row.scheduled_at, dueAt: row.due_at, startedAt: row.started_at, endedAt: row.ended_at,
      attempt: row.attempt, model: row.model, action: row.action, outcome: row.outcome,
      ...(row.details ? { details: JSON.parse(row.details) } : {}) };
  }

  async diagnostic(id: string) {
    return this.diagnosticRecord(await this.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  }

  async clearDiagnostics() {
    return this.db.deleteFrom('decisions').executeTakeFirstOrThrow().then(result => Number(result.numDeletedRows));
  }
}
