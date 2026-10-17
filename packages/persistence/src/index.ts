import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, SqliteDialect } from 'kysely';

export interface DB {
  rooms: {
    id: string;
    name: string;
    description: string;
  };
  agents: {
    id: string;
    room_id: string;
    min_interval_ms: number;
    max_interval_ms: number;
    name: string;
    instructions: string;
    provider: string;
    model: string;
    enabled: number;
    context_message_limit: number;
    revision: number;
  };
  messages: {
    id: string;
    room_id: string;
    agent_id: string;
    created_at: string;
    content: string;
    speaker_name: string;
  };
  schema_migrations: { version: number };
}

export const defaultDatabasePath = fileURLToPath(new URL('../../../data/terrarium.db', import.meta.url));

export const createDb = (filePath = defaultDatabasePath) => {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
};

export const ensureTables = async (db: Kysely<DB>) => {
  await db.transaction().execute(async (transaction) => {
  const db = transaction;
  await db.schema.createTable('schema_migrations').ifNotExists()
    .addColumn('version', 'integer', column => column.primaryKey()).execute();
  const applied = await db.selectFrom('schema_migrations').selectAll().execute();
  if (applied.some(row => row.version === 1)) return;
  await db.schema
    .createTable('rooms')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('agents')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('room_id', 'text', (col) => col.notNull())
    .addColumn('min_interval_ms', 'integer', (col) => col.notNull())
    .addColumn('max_interval_ms', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('messages')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('room_id', 'text', (col) => col.notNull())
    .addColumn('agent_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .execute();
  await db.schema.alterTable('rooms').addColumn('description', 'text', column => column.notNull().defaultTo('')).execute();
  const additions = [
    ['name', 'text', ''], ['instructions', 'text', ''], ['provider', 'text', 'chatgpt'],
    ['model', 'text', 'gpt-6-luna'], ['enabled', 'integer', 0],
    ['context_message_limit', 'integer', 50], ['revision', 'integer', 0],
  ] as const;
  for (const [name, type, value] of additions) {
    await db.schema.alterTable('agents').addColumn(name, type, column => column.notNull().defaultTo(value)).execute();
  }
  await db.schema.alterTable('messages').addColumn('speaker_name', 'text', column => column.notNull().defaultTo('')).execute();
  await db.updateTable('agents').set(({ ref }) => ({ name: ref('id') })).execute();
  await db.updateTable('messages').set(({ ref }) => ({ speaker_name: ref('agent_id') })).execute();
  await db.updateTable('messages').set({ speaker_name: 'Human' }).where('agent_id', '=', 'config-ui').execute();
  const references = await db.selectFrom('messages').select('room_id').union(db.selectFrom('agents').select('room_id')).execute();
  const ids = new Set([...Array.from({ length: 5 }, (_, index) => `room-${index + 1}`), ...references.map(row => row.room_id)]);
  for (const id of ids) {
    await db.insertInto('rooms').values({ id, name: id, description: '' }).onConflict(conflict => conflict.column('id').doNothing()).execute();
  }
  await db.schema.createIndex('messages_room_order').ifNotExists().on('messages').columns(['room_id', 'created_at', 'id']).execute();
  await db.insertInto('schema_migrations').values({ version: 1 }).execute();
  });
};

export * from './world.js';
export * from './legacy.js';
