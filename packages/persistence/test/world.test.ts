import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Configuration } from '@terrarium/shared';
import {
  createDb,
  ensureTables,
  preserveLegacyDatabase,
  World,
} from '../src/index.js';

const databases: ReturnType<typeof createDb>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.destroy();
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'terrarium-test-')))
      throw new Error('Unsafe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const db = createDb(':memory:');
  databases.push(db);
  await ensureTables(db);
  return new World(db);
};
const agentInput = {
  name: 'Test agent',
  instructions: 'Be curious.',
  roomId: 'room-1',
  provider: 'chatgpt' as const,
  model: 'gpt-6-luna',
  enabled: true,
  minIntervalMs: 1000,
  maxIntervalMs: 1000,
  contextMessageLimit: 50,
};

describe('persisted world', () => {
  it('round trips all room and agent settings without history or runtime revisions', async () => {
    const source = await fixture(),
      destination = await fixture();
    const room = await source.saveRoom({
      name: 'Quiet garden',
      description: 'A reflective room.',
    });
    const agent = await source.saveAgent({
      ...agentInput,
      name: 'Gardener',
      instructions: 'Ask careful questions.\nUse examples.',
      roomId: room.id,
      maxIntervalMs: 5000,
      contextMessageLimit: 12,
    });
    await source.speak(room.id, 'History stays here.');
    const configuration = await source.exportConfiguration();
    expect(Object.keys(configuration).sort()).toEqual([
      'agents',
      'format',
      'rooms',
      'version',
    ]);
    expect(configuration.agents[0]).not.toHaveProperty('revision');
    expect(JSON.stringify(configuration)).not.toContain(
      'History stays here.',
    );
    const preview = await destination.previewConfiguration(configuration);
    await destination.importConfiguration(
      JSON.parse(JSON.stringify(configuration)),
      preview.token,
    );
    expect(await destination.exportConfiguration()).toEqual(configuration);
    expect(await destination.agent(agent.id)).toMatchObject({
      enabled: true,
      revision: 0,
      roomId: room.id,
    });
    expect(
      (await destination.history({ roomId: room.id })).messages,
    ).toEqual([]);
  });
  it('merges by ID, preserves omitted records and history, and invalidates old agent revisions', async () => {
    const world = await fixture();
    const existing = await world.saveAgent(agentInput);
    const kept = await world.saveAgent({
      ...agentInput,
      name: 'Keep me',
      enabled: false,
    });
    const message = await world.speak('room-1', 'Keep this conversation.');
    const configuration: Configuration = {
      format: 'terrarium-config',
      version: 1,
      rooms: [
        { id: 'room-1', name: 'Renamed', description: 'Updated' },
        { id: 'new-room', name: 'New room', description: '' },
      ],
      agents: [
        {
          ...agentInput,
          id: existing.id,
          name: 'Updated',
          roomId: 'new-room',
          enabled: false,
        },
        { ...agentInput, id: 'new-agent', name: 'New agent' },
      ],
    };
    const preview = await world.previewConfiguration(configuration);
    expect(preview.rooms.map((room) => room.operation)).toEqual([
      'update',
      'add',
    ]);
    expect(preview.agents.map((agent) => agent.operation)).toEqual([
      'update',
      'add',
    ]);
    await world.importConfiguration(configuration, preview.token);
    expect(await world.agent(kept.id)).toEqual(kept);
    expect((await world.rooms()).map((room) => room.id)).toContain(
      'room-5',
    );
    expect(await world.agent(existing.id)).toMatchObject({
      name: 'Updated',
      enabled: false,
      roomId: 'new-room',
      revision: existing.revision + 1,
    });
    expect((await world.history({ roomId: 'room-1' })).messages).toEqual([
      message,
    ]);
    await expect(
      world.applyAction(
        existing.id,
        existing.revision,
        { type: 'wait' },
        () => true,
      ),
    ).rejects.toThrow('no longer current');
  });
  it('rejects unknown room references in both preview and import without writes', async () => {
    const world = await fixture(),
      before = await world.state();
    const configuration: Configuration = {
      format: 'terrarium-config',
      version: 1,
      rooms: [{ id: 'new-room', name: 'New', description: '' }],
      agents: [{ ...agentInput, id: 'new-agent', roomId: 'missing' }],
    };
    await expect(world.previewConfiguration(configuration)).rejects.toThrow(
      'unknown room',
    );
    await expect(
      world.importConfiguration(configuration, '0'.repeat(64)),
    ).rejects.toThrow('unknown room');
    expect(await world.state()).toEqual(before);
  });
  it('rejects a stale preview when either the file or saved configuration changes', async () => {
    const world = await fixture();
    const configuration = await world.exportConfiguration();
    const preview = await world.previewConfiguration(configuration);
    const altered = structuredClone(configuration);
    altered.rooms[0].name = 'Changed file';
    await expect(
      world.importConfiguration(altered, preview.token),
    ).rejects.toThrow('changed since preview');
    await world.saveRoom({
      ...configuration.rooms[0],
      name: 'Changed database',
    });
    await expect(
      world.importConfiguration(configuration, preview.token),
    ).rejects.toThrow('changed since preview');
    expect((await world.rooms())[0].name).toBe('Changed database');
  });
  it('rolls back room and earlier agent writes if a later insert fails', async () => {
    const world = await fixture();
    await world.saveAgent(agentInput);
    const before = await world.state();
    const configuration: Configuration = {
      format: 'terrarium-config',
      version: 1,
      rooms: [
        { id: 'room-1', name: 'Must roll back', description: '' },
        { id: 'new-room', name: 'Must disappear', description: '' },
      ],
      agents: [
        { ...agentInput, id: 'first-agent' },
        { ...agentInput, id: 'fail-agent' },
      ],
    };
    const preview = await world.previewConfiguration(configuration);
    await sql`CREATE TRIGGER reject_import BEFORE INSERT ON agents WHEN NEW.id = 'fail-agent' BEGIN SELECT RAISE(ABORT, 'Injected import failure'); END`.execute(
      world.db,
    );
    await expect(
      world.importConfiguration(configuration, preview.token),
    ).rejects.toThrow('Injected import failure');
    expect(await world.state()).toEqual(before);
  });
  it('initializes once and preserves a legacy database and existing messages', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-test-'));
    directories.push(directory);
    const legacy = join(directory, 'old.db'),
      destination = join(directory, 'new.db');
    const raw = new Database(legacy);
    raw.exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, min_interval_ms INTEGER NOT NULL, max_interval_ms INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL);
      INSERT INTO messages VALUES ('old-message','old-room','config-ui','2026-10-01T00:00:00.000Z','Saved before migration');
      INSERT INTO agents VALUES ('old-agent','old-room',1000,2000);`);
    raw.close();
    await preserveLegacyDatabase(legacy, destination);
    const db = createDb(destination);
    databases.push(db);
    await ensureTables(db);
    await ensureTables(db);
    const world = new World(db);
    expect((await world.rooms()).map((room) => room.id)).toContain('old-room');
    expect((await world.agents())[0]).toMatchObject({
      id: 'old-agent',
      name: 'old-agent',
      enabled: false,
    });
    expect(
      (await world.history({ roomId: 'old-room' })).messages[0],
    ).toMatchObject({
      id: 'old-message',
      content: 'Saved before migration',
      speaker: 'Human',
    });
    expect(
      await db.selectFrom('schema_migrations').selectAll().execute(),
    ).toEqual([{ version: 1 }]);
    const unchanged = new Database(legacy, { readonly: true });
    expect(unchanged.prepare('PRAGMA table_info(agents)').all()).toHaveLength(
      4,
    );
    unchanged.close();
    await preserveLegacyDatabase(legacy, destination);
  });

  it('paginates reconnect history without losing or duplicating fast messages', async () => {
    const world = await fixture();
    const first = await world.speak('room-1', 'First');
    for (let index = 0; index < 205; index++)
      await world.speak('room-1', `Message ${index}`);
    const newest = await world.history({ roomId: 'room-1' });
    expect(newest.messages).toHaveLength(100);
    expect(newest.hasMore).toBe(true);
    const collected = [];
    let after = { id: first.id, createdAt: first.createdAt };
    while (true) {
      const page = await world.history({ roomId: 'room-1', after });
      collected.push(...page.messages);
      if (!page.hasMore) break;
      const last = page.messages[page.messages.length - 1];
      after = { id: last.id, createdAt: last.createdAt };
    }
    expect(collected).toHaveLength(205);
    expect(new Set(collected.map((message) => message.id)).size).toBe(205);
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([]);
    const before = newest.messages[0];
    expect(
      (await world.history({ roomId: 'room-1', before })).messages,
    ).toHaveLength(100);
  });

  it('rejects invalid destinations and stale actions without mutation', async () => {
    const world = await fixture();
    const agent = await world.saveAgent(agentInput);
    await expect(
      world.applyAction(
        agent.id,
        agent.revision,
        { type: 'move', roomId: 'missing' },
        () => true,
      ),
    ).rejects.toThrow('Destination');
    await expect(
      world.applyAction(
        agent.id,
        agent.revision,
        { type: 'speak', message: 'Late' },
        () => false,
      ),
    ).rejects.toThrow('no longer current');
    await world.saveAgent({ ...agentInput, id: agent.id, roomId: 'room-2' });
    await expect(
      world.applyAction(
        agent.id,
        agent.revision,
        { type: 'speak', message: 'Old room' },
        () => true,
      ),
    ).rejects.toThrow('no longer current');
    expect((await world.history({ roomId: 'room-1' })).messages).toEqual([]);
    const current = await world.agent(agent.id);
    await world.applyAction(
      agent.id,
      current!.revision,
      { type: 'wait' },
      () => true,
    );
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([]);
  });
});
