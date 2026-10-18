import { createHash, randomUUID } from 'node:crypto';
import { clearHistorySchema, configurationSchema } from '@terrarium/shared';
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
} from '@terrarium/shared';
import type { DB } from './index.js';

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
  constructor(readonly db: Kysely<DB>) {}

  async rooms() {
    return this.db.selectFrom('rooms').selectAll().orderBy('id').execute();
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
    return { rooms: await this.rooms(), agents: await this.agents() };
  }

  async exportConfiguration(): Promise<Configuration> {
    return this.db.transaction().execute(async (db) => {
      const state = await new World(db).state();
      return configurationSchema.parse({
        format: 'terrarium-config',
        version: 1,
        rooms: state.rooms,
        agents: state.agents.map(({ revision, ...agent }) => agent),
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
    return {
      token: createHash('sha256')
        .update(JSON.stringify({ configuration, state }))
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
        await db
          .insertInto('rooms')
          .values(room)
          .onConflict((conflict) =>
            conflict
              .column('id')
              .doUpdateSet({
                name: room.name,
                description: room.description,
              }),
          )
          .execute();
      }
      const revisions = new Map(
        state.agents.map((agent) => [agent.id, agent.revision]),
      );
      for (const agent of configuration.agents) {
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
        };
        await db
          .insertInto('agents')
          .values(values)
          .onConflict((conflict) =>
            conflict.column('id').doUpdateSet(values),
          )
          .execute();
      }
      return preview;
    });
  }

  async saveRoom(input: RoomInput) {
    const id = input.id ?? randomUUID();
    if (input.id) {
      const found = await this.db
        .updateTable('rooms')
        .set({ name: input.name, description: input.description })
        .where('id', '=', id)
        .executeTakeFirst();
      if (!found.numUpdatedRows) throw new Error('Room does not exist.');
    } else {
      await this.db
        .insertInto('rooms')
        .values({ id, name: input.name, description: input.description })
        .execute();
    }
    return { id, name: input.name, description: input.description };
  }

  async saveAgent(input: AgentInput) {
    return this.db.transaction().execute(async (db) => {
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
          .values({ ...values, id, revision: 0 })
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
  ) {
    return this.db.transaction().execute(async (db) => {
      const row = await db
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', agentId)
        .executeTakeFirstOrThrow();
      const check = () => {
        if (!stillCurrent() || !row.enabled || row.revision !== revision)
          throw new Error('This turn is no longer current.');
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
          throw new Error('Destination room does not exist.');
        await db
          .updateTable('agents')
          .set({ room_id: action.roomId, revision: row.revision + 1 })
          .where('id', '=', row.id)
          .execute();
      }
      check();
      return { message, moved: action.type === 'move' };
    });
  }
}
