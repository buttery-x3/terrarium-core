import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, SqliteDialect, type Generated } from 'kysely';
import { defaultSettings, upgradeSavedSettings, type ConversationMessage } from '@terrarium/shared';

export interface DB {
  rooms: {
    id: string;
    name: string;
    description: string;
    is_food_source: Generated<number>;
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
    motivations: Generated<string>;
    intention: Generated<string>;
    energy: Generated<number>;
    timing_overrides: Generated<string>;
  };
  messages: {
    id: string;
    room_id: string;
    agent_id: string;
    created_at: string;
    content: string;
    speaker_name: string;
    type: Generated<ConversationMessage['type']>;
    reply_to_id: Generated<string | null>;
    conversation_id: Generated<string | null>;
  };
  reflections: {
    agent_id: string; reflected_at: string | null; reaction: string | null; intention: string | null;
    last_speech_at: string | null; last_emote_at: string | null;
    engagement_room_id: string | null; engagement_root_message_id: string | null; engagement_target_agent_id: string | null;
  };
  appraisals: {
    sequence: Generated<number>; id: string; observer_id: string; observer_name: string; target_agent_id: string; target_name: string;
    source_id: string; source: string; reaction: 'like' | 'dislike'; reason: string; created_at: string; score_after: number;
  };
  relationships: {
    observer_id: string; observer_name: string; target_agent_id: string; target_name: string; score: number; updated_at: string;
    latest_appraisal_sequence: number;
  };
  relationship_summaries: {
    id: string; observer_id: string; target_agent_id: string; version: number; summary: string; created_at: string;
    through_sequence: number; previous_summary_id: string | null; appraisal_ids: string;
  };
  observations: { sequence: Generated<number>; agent_id: string; message_id: string };
  schema_migrations: { version: number };
  settings: { id: number; version: number; value: string };
  decisions: {
    sequence: Generated<number>; id: string; turn_id: string; agent_id: string; agent_name: string; room_id: string;
    scheduled_at: string; due_at: string; started_at: string | null; ended_at: string | null;
    attempt: number; model: string; action: string | null; outcome: string; details: string;
    bytes: number; reserved_bytes: number;
    operation: Generated<string>; requested_at: Generated<string | null>;
  };
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
  if (!applied.some(row => row.version === 1)) {
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
  }
  if (!applied.some(row => row.version === 2)) {
    await db.schema.alterTable('rooms').addColumn('is_food_source', 'integer', column => column.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('agents').addColumn('motivations', 'text', column => column.notNull().defaultTo('')).execute();
    await db.schema.alterTable('agents').addColumn('intention', 'text', column => column.notNull().defaultTo('')).execute();
    await db.schema.alterTable('agents').addColumn('energy', 'real', column => column.notNull().defaultTo(100)).execute();
    await db.schema.createTable('settings').addColumn('id', 'integer', column => column.primaryKey())
      .addColumn('version', 'integer', column => column.notNull()).addColumn('value', 'text', column => column.notNull()).execute();
    await db.insertInto('settings').values({ id: 1, version: 1, value: JSON.stringify(defaultSettings) }).execute();
    await db.schema.createTable('decisions')
      .addColumn('sequence', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('id', 'text', column => column.notNull().unique())
      .addColumn('turn_id', 'text', column => column.notNull())
      .addColumn('agent_id', 'text', column => column.notNull())
      .addColumn('agent_name', 'text', column => column.notNull())
      .addColumn('room_id', 'text', column => column.notNull())
      .addColumn('scheduled_at', 'text', column => column.notNull())
      .addColumn('due_at', 'text', column => column.notNull())
      .addColumn('started_at', 'text').addColumn('ended_at', 'text')
      .addColumn('attempt', 'integer', column => column.notNull())
      .addColumn('model', 'text', column => column.notNull()).addColumn('action', 'text')
      .addColumn('outcome', 'text', column => column.notNull())
      .addColumn('details', 'text', column => column.notNull())
      .addColumn('bytes', 'integer', column => column.notNull())
      .addColumn('reserved_bytes', 'integer', column => column.notNull()).execute();
    await db.schema.createIndex('decisions_turn').on('decisions').columns(['turn_id', 'attempt']).execute();
    await db.schema.createIndex('decisions_filter').on('decisions').columns(['agent_id', 'room_id', 'sequence']).execute();
    await db.insertInto('schema_migrations').values({ version: 2 }).execute();
  }
  if (!applied.some(row => row.version === 3)) {
    await db.schema.alterTable('messages').addColumn('type', 'text', column => column.notNull().defaultTo('speak')).execute();
    await db.schema.createTable('observations')
      .addColumn('sequence', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('agent_id', 'text', column => column.notNull())
      .addColumn('message_id', 'text', column => column.notNull())
      .addUniqueConstraint('observations_agent_message', ['agent_id', 'message_id']).execute();
    await db.schema.createIndex('observations_agent_order').on('observations').columns(['agent_id', 'sequence']).execute();
    await db.schema.createIndex('observations_message').on('observations').column('message_id').execute();
    const saved = await db.selectFrom('settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    await db.updateTable('settings').set({ value: JSON.stringify(upgradeSavedSettings(JSON.parse(saved.value))), version: saved.version + 1 }).where('id', '=', 1).execute();
    // INVARIANT: existing archives do not establish personally witnessed observations.
    await db.insertInto('schema_migrations').values({ version: 3 }).execute();
  }
  if (!applied.some(row => row.version === 4)) {
    await db.schema.alterTable('agents').addColumn('timing_overrides', 'text', column => column.notNull().defaultTo('{}')).execute();
    await db.schema.alterTable('messages').addColumn('reply_to_id', 'text').execute();
    await db.schema.alterTable('messages').addColumn('conversation_id', 'text').execute();
    await db.schema.alterTable('decisions').addColumn('operation', 'text', column => column.notNull().defaultTo('action')).execute();
    await db.schema.alterTable('decisions').addColumn('requested_at', 'text').execute();
    await db.schema.createTable('reflections').addColumn('agent_id', 'text', column => column.primaryKey())
      .addColumn('reflected_at', 'text').addColumn('reaction', 'text').addColumn('intention', 'text')
      .addColumn('last_speech_at', 'text').addColumn('last_emote_at', 'text')
      .addColumn('engagement_room_id', 'text').addColumn('engagement_root_message_id', 'text')
      .addColumn('engagement_target_agent_id', 'text').execute();
    const saved = await db.selectFrom('settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    await db.updateTable('settings').set({ value: JSON.stringify(upgradeSavedSettings(JSON.parse(saved.value))), version: saved.version + 1 }).where('id', '=', 1).execute();
    await db.insertInto('schema_migrations').values({ version: 4 }).execute();
  }
  if (!applied.some(row => row.version === 5)) {
    await db.schema.createTable('appraisals').addColumn('sequence', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('id', 'text', column => column.notNull().unique())
      .addColumn('observer_id', 'text', column => column.notNull()).addColumn('observer_name', 'text', column => column.notNull())
      .addColumn('target_agent_id', 'text', column => column.notNull()).addColumn('target_name', 'text', column => column.notNull())
      .addColumn('source_id', 'text', column => column.notNull()).addColumn('source', 'text', column => column.notNull())
      .addColumn('reaction', 'text', column => column.notNull()).addColumn('reason', 'text', column => column.notNull())
      .addColumn('created_at', 'text', column => column.notNull()).addColumn('score_after', 'integer', column => column.notNull())
      .addUniqueConstraint('appraisal_observer_source', ['observer_id', 'source_id']).execute();
    await db.schema.createIndex('appraisal_pair_order').on('appraisals').columns(['observer_id', 'target_agent_id', 'sequence']).execute();
    await db.schema.createTable('relationships')
      .addColumn('observer_id', 'text', column => column.notNull()).addColumn('observer_name', 'text', column => column.notNull())
      .addColumn('target_agent_id', 'text', column => column.notNull()).addColumn('target_name', 'text', column => column.notNull())
      .addColumn('score', 'integer', column => column.notNull()).addColumn('updated_at', 'text', column => column.notNull())
      .addColumn('latest_appraisal_sequence', 'integer', column => column.notNull())
      .addPrimaryKeyConstraint('relationship_pair', ['observer_id', 'target_agent_id']).execute();
    await db.schema.createTable('relationship_summaries').addColumn('id', 'text', column => column.primaryKey())
      .addColumn('observer_id', 'text', column => column.notNull()).addColumn('target_agent_id', 'text', column => column.notNull())
      .addColumn('version', 'integer', column => column.notNull()).addColumn('summary', 'text', column => column.notNull())
      .addColumn('created_at', 'text', column => column.notNull()).addColumn('through_sequence', 'integer', column => column.notNull())
      .addColumn('previous_summary_id', 'text').addColumn('appraisal_ids', 'text', column => column.notNull())
      .addUniqueConstraint('relationship_summary_version', ['observer_id', 'target_agent_id', 'version']).execute();
    const saved = await db.selectFrom('settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    await db.updateTable('settings').set({ value: JSON.stringify(upgradeSavedSettings(JSON.parse(saved.value))), version: saved.version + 1 }).where('id', '=', 1).execute();
    await db.insertInto('schema_migrations').values({ version: 5 }).execute();
  }
  });
};

export * from './world.js';
export * from './legacy.js';
