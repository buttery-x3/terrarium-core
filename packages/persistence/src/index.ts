import Database from 'better-sqlite3';
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
  const sqlite = new Database(filePath);
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
};
