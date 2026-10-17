import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import type {
  Agent,
  AgentAction,
  AgentInput,
  ConversationMessage,
  HistoryInput,
  HistoryPage,
  RoomInput,
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
