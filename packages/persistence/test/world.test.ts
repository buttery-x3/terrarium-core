import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
