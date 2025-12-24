import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, SqliteDialect } from 'kysely';

export interface DB {
  rooms: {
    id: string;
    name: string;
  };
  agents: {
    id: string;
    room_id: string;
    min_interval_ms: number;
    max_interval_ms: number;
  };
  messages: {
    id: string;
    room_id: string;
    agent_id: string;
    created_at: string;
    content: string;
  };
}

export const createDb = (filePath = 'data/terrarium.db') => {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
};

export const ensureTables = async (db: Kysely<DB>) => {
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
};
