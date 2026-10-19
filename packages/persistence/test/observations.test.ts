import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { defaultSettings, conversationMessageSchema, type AgentAction } from '@terrarium/shared';
import { createDb, ensureTables, World } from '../src/index.js';

let db: ReturnType<typeof createDb>, world: World;
const directories: string[] = [];
const input = { name: 'A', instructions: 'Observe', provider: 'chatgpt' as const, model: 'fake', enabled: true,
  roomId: 'room-1', minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 30 };
beforeEach(async () => { db = createDb(':memory:'); await ensureTables(db); world = new World(db); });
afterEach(async () => {
  await db.destroy();
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'terrarium-observations-'))) throw new Error('Unsafe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
const act = async (id: string, action: AgentAction) => {
  const agent = (await world.agent(id))!;
  return world.applyAction(id, agent.revision, action, () => true);
};

describe('personal observations', () => {
  it('records at event time for local residents, including disabled agents and the actor, without arrival backfill', async () => {
    const a = await world.saveAgent(input);
    const local = await world.saveAgent({ ...input, name: 'Local', enabled: false });
    const b = await world.saveAgent({ ...input, name: 'B', roomId: 'room-2' });
    const remote = await world.saveAgent({ ...input, name: 'Remote', roomId: 'room-3' });
    const earlier = await world.speak('room-1', 'Earlier exchange');
    await world.speak('room-2', 'B alone');
    const move = await act(b.id, { type: 'move', roomId: 'room-1' });
    const first = await world.speak('room-1', 'One between turns');
    const second = await world.speak('room-1', 'Two between turns');
    const emote = (await act(a.id, { type: 'emote', message: 'A watches the doorway.' })).message!;
    expect(move.events.map(item => [item.type, item.roomId])).toEqual([['departure', 'room-2'], ['arrival', 'room-1']]);
    expect(await world.memory(a.id)).toEqual([earlier, move.events[1], first, second, emote]);
    expect(await world.memory(local.id)).toEqual(await world.memory(a.id));
    expect((await world.memory(b.id)).map(item => item.content)).not.toContain('Earlier exchange');
    expect((await world.memory(b.id)).slice(-5)).toEqual([...move.events, first, second, emote]);
    expect(await world.memory(remote.id)).toEqual([]);
    const exit = await act(a.id, { type: 'move', roomId: 'room-3' });
    expect((await world.memory(a.id))[0]).toEqual(earlier);
    expect(await world.memory(remote.id)).toEqual([exit.events[1]]);
    expect((await world.memory(b.id)).at(-1)).toEqual(exit.events[0]);
    for (const record of [...move.events, emote, ...exit.events]) expect(conversationMessageSchema.parse(record)).toEqual(record);
  });

  it('evicts a single FIFO across rooms and types, trims on edit/import, and never restores evicted archive items', async () => {
    const a = await world.saveAgent({ ...input, contextMessageLimit: 3 });
    await world.speak('room-1', 'Old');
    await act(a.id, { type: 'emote', message: 'A stands quietly.' });
    const moved = await act(a.id, { type: 'move', roomId: 'room-2' });
    const speech = await world.speak('room-2', 'New');
    expect(await world.memory(a.id)).toEqual([...moved.events, speech]);
    const current = (await world.agent(a.id))!;
    await world.saveAgent({ ...input, id: a.id, roomId: current.roomId, contextMessageLimit: 2 });
    expect(await world.memory(a.id)).toEqual([moved.events[1], speech]);
    const configuration = await world.exportConfiguration();
    configuration.agents[0].contextMessageLimit = 1;
    await world.importConfiguration(configuration, (await world.previewConfiguration(configuration)).token);
    expect(await world.memory(a.id)).toEqual([speech]);
    await world.saveAgent({ ...input, id: a.id, roomId: current.roomId, contextMessageLimit: 50 });
    expect(await world.memory(a.id)).toEqual([speech]);
    expect((await world.exportConversations()).rooms.flatMap(room => room.messages)).toHaveLength(5);
  });

  it('rolls back movement, both local deliveries and eviction on stale completion or observation/diagnostic failure', async () => {
    const a = await world.saveAgent({ ...input, contextMessageLimit: 1 });
    const resident = await world.saveAgent({ ...input, roomId: 'room-2' });
    const saved = await world.speak('room-1', 'Preserve me');
    let checks = 0;
    await expect(world.applyAction(a.id, a.revision, { type: 'move', roomId: 'room-2' }, () => ++checks === 1)).rejects.toThrow('no longer current');
    await sql`CREATE TRIGGER reject_observation BEFORE INSERT ON observations WHEN (SELECT type FROM messages WHERE id = NEW.message_id) = 'arrival' BEGIN SELECT RAISE(ABORT, 'Observation failure'); END`.execute(db);
    await expect(act(a.id, { type: 'move', roomId: 'room-2' })).rejects.toThrow('Observation failure');
    await sql`DROP TRIGGER reject_observation`.execute(db);
    await expect(world.applyAction(a.id, a.revision, { type: 'move', roomId: 'room-2' }, () => true, 'missing-attempt')).rejects.toThrow();
    expect(await world.agent(a.id)).toEqual(a);
    expect(await world.memory(a.id)).toEqual([saved]);
    expect(await world.memory(resident.id)).toEqual([]);
    expect((await world.exportConversations()).rooms.flatMap(room => room.messages)).toEqual([saved]);
    await expect(act(a.id, { type: 'move', roomId: 'missing' })).rejects.toThrow('Destination');
    expect((await act(a.id, { type: 'move', roomId: 'room-1' })).events).toEqual([]);
  });

  it('enforces emote/wait configuration and does not apply unsupported state changes from emote text', async () => {
    const a = await world.saveAgent(input);
    await expect(act(a.id, { type: 'wait' })).rejects.toThrow('Emotes are enabled');
    for (const action of [{ type: 'emote', message: '' }, { type: 'emote', message: 'x'.repeat(241) },
      { type: 'emote', message: 'A eats.', energy: 100 }, { type: 'emote', message: 'A moves.', roomId: 'room-2' },
      { type: 'arrival', message: 'A arrives.' }])
      await expect(act(a.id, action as AgentAction)).rejects.toThrow();
    await act(a.id, { type: 'emote', message: 'A builds a machine and eats.' });
    expect(await world.agent(a.id)).toEqual(a);
    expect((await world.memory(a.id))[0].type).toBe('emote');
    await world.saveSettings({ ...defaultSettings, activity: { emotesEnabled: false, roomEventsEnabled: false } });
    await expect(act(a.id, { type: 'emote', message: 'A watches.' })).rejects.toThrow('Emotes are disabled');
    await act(a.id, { type: 'wait' });
    expect((await act(a.id, { type: 'move', roomId: 'room-2' })).events).toEqual([]);
    expect(await world.memory(a.id)).toHaveLength(1);
    await world.speak('room-2', 'Still observed');
    expect(await world.memory(a.id)).toHaveLength(2);
  });

  it('clears references by room and deletes only the removed agent memory while preserving others and diagnostics', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent(input);
    await world.speak('room-1', 'Clear');
    await act(a.id, { type: 'move', roomId: 'room-2' });
    const keep = await world.speak('room-2', 'Keep');
    const turn = await world.scheduleTurn(a, Date.now());
    await world.clearHistory({ scope: 'room', roomId: 'room-1' });
    expect((await world.memory(a.id)).map(item => item.type)).toEqual(['arrival', 'speak']);
    expect(await world.memory(b.id)).toEqual([]);
    await world.deleteAgent(b.id);
    expect(await world.memory(a.id)).toContainEqual(keep);
    await world.clearHistory({ scope: 'all' });
    expect(await world.memory(a.id)).toEqual([]);
    expect((await world.diagnostic(turn)).agentId).toBe(a.id);
  });

  it('migrates version 2 without backfill, preserves custom settings/diagnostics, and retains individual memories after reopen', async () => {
    await db.destroy();
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-observations-')); directories.push(directory);
    const path = join(directory, 'restart.db');
    db = createDb(path); await ensureTables(db); world = new World(db);
    const a = await world.saveAgent({ ...input, contextMessageLimit: 2 });
    const b = await world.saveAgent({ ...input, roomId: 'room-2' });
    await world.speak('room-1', 'Historical archive');
    const turn = await world.scheduleTurn(a, Date.now());
    const { activity, prompts: { observations, emotes, ...prompts }, ...settings } = defaultSettings;
    prompts.actionSelection = 'CUSTOM ACTION RULE';
    await db.updateTable('settings').set({ value: JSON.stringify({ ...settings, prompts }) }).execute();
    await db.schema.dropTable('observations').execute();
    await sql`ALTER TABLE messages DROP COLUMN type`.execute(db);
    await db.deleteFrom('schema_migrations').where('version', '=', 3).execute();
    await ensureTables(db); await ensureTables(db);
    expect(await world.memory(a.id)).toEqual([]);
    expect((await world.history({ roomId: 'room-1' })).messages[0]).toMatchObject({ content: 'Historical archive', type: 'speak' });
    expect((await world.settings()).value).toMatchObject({ activity: defaultSettings.activity, prompts: { actionSelection: 'CUSTOM ACTION RULE', observations: defaultSettings.prompts.observations } });
    expect((await world.diagnostic(turn)).agentId).toBe(a.id);
    await world.speak('room-2', 'B witnessed this alone');
    await act(a.id, { type: 'move', roomId: 'room-2' });
    await world.speak('room-2', 'After migration');
    const memories = [await world.memory(a.id), await world.memory(b.id)];
    const configuration = await world.exportConfiguration();
    expect(configuration.version).toBe(3);
    expect(JSON.stringify(configuration)).not.toContain('After migration');
    await db.destroy(); db = createDb(path); await ensureTables(db); world = new World(db);
    expect([await world.memory(a.id), await world.memory(b.id)]).toEqual(memories);
    expect((await world.agent(a.id))?.contextMessageLimit).toBe(2);
  });
});
