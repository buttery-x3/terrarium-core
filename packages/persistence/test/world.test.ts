import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { defaultSettings, type Configuration } from '@terrarium/shared';
import {
  createDb,
  ensureTables,
  preserveLegacyDatabase,
  World,
} from '../src/index.js';

const databases: ReturnType<typeof createDb>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  it('recovers interrupted attempts and energy after reopening the database without changing applied evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-test-'));
    directories.push(directory);
    const path = join(directory, 'diagnostic-restart.db'), firstDb = createDb(path);
    await ensureTables(firstDb);
    const first = new World(firstDb), agent = await first.saveAgent(agentInput);
    await firstDb.updateTable('agents').set({ energy: 42 }).where('id', '=', agent.id).execute();
    const turn = await first.scheduleTurn(agent, Date.now()), attempt = await first.startAttempt(turn, 1, agent);
    await first.updateDiagnostic(attempt, { payload: { instructions: 'Exact saved input' } });
    await firstDb.destroy();
    const reopened = createDb(path); databases.push(reopened);
    await ensureTables(reopened);
    const world = new World(reopened);
    await world.interruptUnfinished();
    expect(await world.diagnostic(attempt)).toMatchObject({ outcome: 'interrupted', details: { payload: { instructions: 'Exact saved input' } } });
    expect((await world.diagnosticUsage()).reservedBytes).toBe(0);
    await world.syncEnergy(Date.now() + 86400000);
    expect((await world.agent(agent.id))?.energy).toBe(42);
  });
  it('reserves capacity before requests and preserves terminal cancellation against late writes', async () => {
    const world = await fixture(), agent = await world.saveAgent(agentInput);
    await world.saveSettings({ ...defaultSettings, diagnostics: { retention: 'manual', maxPayloadMiB: 32 } });
    const turn = await world.scheduleTurn(agent, Date.now());
    const attempts = [];
    for (let index = 1; index <= 3; index++) attempts.push(await world.startAttempt(turn, index, agent));
    await expect(world.startAttempt(turn, 4, agent)).rejects.toThrow('capacity');
    await world.updateDiagnostic(attempts[0], { error: 'Cancelled' }, 'cancelled');
    await world.updateDiagnostic(attempts[0], { output: 'late reply' }, 'applied');
    expect(await world.diagnostic(attempts[0])).toMatchObject({ outcome: 'cancelled', details: { error: 'Cancelled' } });
    expect((await world.diagnostic(attempts[0])).details).not.toHaveProperty('output');
    await expect(world.startAttempt(turn, 4, agent)).resolves.toBeTypeOf('string');
  });
  it('drains elapsed running time independently of turns, freezes disabled agents and preserves restart energy', async () => {
    const world = await fixture();
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await world.saveRoom({ id: 'room-2', name: 'Orchard', description: '', isFoodSource: true });
    await world.saveSettings({ ...defaultSettings, energy: { ...defaultSettings.energy, enabled: true } });
    const fast = await world.saveAgent(agentInput);
    const slow = await world.saveAgent({ ...agentInput, minIntervalMs: 60000, maxIntervalMs: 60000 });
    const disabled = await world.saveAgent({ ...agentInput, enabled: false });
    await world.syncEnergy(now, true);
    now = 60000;
    await world.syncEnergy();
    await world.syncEnergy();
    await world.applyAction(fast.id, fast.revision, { type: 'emote', message: 'Test agent watches quietly.' }, () => true);
    expect((await world.agent(fast.id))?.energy).toBe(95);
    expect((await world.agent(slow.id))?.energy).toBe(95);
    expect((await world.agent(disabled.id))?.energy).toBe(100);
    expect((await world.agent(fast.id))?.revision).toBe(fast.revision);
    now = 120000;
    await world.syncEnergy(now, false);
    now = 900000;
    await world.syncEnergy();
    expect((await world.agent(fast.id))?.energy).toBe(90);
    const restarted = new World(world.db);
    await restarted.syncEnergy(now + 86400000);
    expect((await restarted.agent(fast.id))?.energy).toBe(90);
    await world.syncEnergy(now, true);
    now += 9999999;
    await world.syncEnergy();
    expect((await world.agent(fast.id))?.energy).toBe(0);
    await world.applyAction(fast.id, fast.revision, { type: 'speak', message: 'Still able to speak.' }, () => true);
  });

  it('uses room capability for two sources, validates meals and records atomic move/eat evidence', async () => {
    const world = await fixture();
    await world.saveRoom({ id: 'room-1', name: 'Canteen', description: '' });
    const food = await world.saveRoom({ name: 'Arbitrary food location', description: '', isFoodSource: true });
    await world.saveRoom({ id: 'room-2', name: 'Another', description: '', isFoodSource: true });
    await world.saveRoom({ ...food, name: 'Renamed' });
    await world.saveSettings({ ...defaultSettings, energy: { ...defaultSettings.energy, enabled: true, initial: 10 } });
    let agent = await world.saveAgent(agentInput);
    await expect(world.applyAction(agent.id, agent.revision, { type: 'eat' }, () => true)).rejects.toThrow('food-source');
    const turn = await world.scheduleTurn(agent, Date.now()), attempt = await world.startAttempt(turn, 1, agent);
    await world.updateDiagnostic(attempt, { energySeen: 10 });
    await world.applyAction(agent.id, agent.revision, { type: 'move', roomId: food.id }, () => true, attempt);
    expect((await world.diagnostic(attempt)).details).toMatchObject({ moved: true, sourceRoomId: 'room-1', destinationRoomId: food.id });
    agent = (await world.agent(agent.id))!;
    const eat = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    await world.applyAction(agent.id, agent.revision, { type: 'eat' }, () => true, eat);
    expect((await world.diagnostic(eat)).details).toMatchObject({ energyBefore: 10, energyAfter: 100 });
    expect((await world.history({ roomId: food.id })).messages.map(item => item.type)).toEqual(['arrival']);
    await world.applyAction(agent.id, agent.revision, { type: 'move', roomId: 'room-2' }, () => true);
    agent = (await world.agent(agent.id))!;
    await world.applyAction(agent.id, agent.revision, { type: 'eat' }, () => true);
    expect((await world.agent(agent.id))?.energy).toBe(100);
    await expect(world.applyAction(agent.id, agent.revision, { type: 'eat' }, () => false)).rejects.toThrow('no longer current');
  });

  it('rolls back a world mutation if its diagnostic evidence cannot be saved', async () => {
    const world = await fixture(), agent = await world.saveAgent(agentInput);
    const id = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    await sql`CREATE TRIGGER reject_evidence BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'Evidence failed'); END`.execute(world.db);
    await expect(world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Must roll back' }, () => true, id)).rejects.toThrow('Evidence failed');
    expect((await world.history({ roomId: agent.roomId })).messages).toHaveLength(0);
    expect((await world.diagnostic(id)).outcome).toBe('running');
  });

  it('rejects enabling without food, removing the last source and lowering maximum below current energy', async () => {
    const world = await fixture();
    const enabled = { ...defaultSettings, energy: { ...defaultSettings.energy, enabled: true } };
    await expect(world.saveSettings(enabled)).rejects.toThrow('food-source');
    const room = await world.saveRoom({ name: 'Source', description: '', isFoodSource: true });
    await world.saveSettings(enabled);
    await world.saveAgent(agentInput);
    await expect(world.saveRoom({ ...room, isFoodSource: false })).rejects.toThrow('last food-source');
    await expect(world.saveSettings({ ...enabled, energy: { ...enabled.energy, initial: 20, maximum: 50 } })).rejects.toThrow('current energy');
    const configuration = await world.exportConfiguration();
    configuration.rooms.forEach(room => { room.isFoodSource = false; });
    await expect(world.previewConfiguration(configuration)).rejects.toThrow('food-source');
  });

  it('preserves newer settings and runtime energy on version-1 imports and round trips profiles in version 2', async () => {
    const world = await fixture();
    const room = await world.saveRoom({ name: 'Food', description: '', isFoodSource: true });
    const agent = await world.saveAgent({ ...agentInput, motivations: 'Enjoy quiet', intention: 'Visit the orchard' });
    await world.db.updateTable('agents').set({ energy: 31 }).where('id', '=', agent.id).execute();
    const v1: Configuration = { format: 'terrarium-config', version: 1, rooms: [{ id: room.id, name: 'Renamed', description: '' }], agents: [{ ...agentInput, id: agent.id }] };
    const preview = await world.previewConfiguration(v1);
    expect(preview.defaults.join(' ')).toContain('preserved');
    await world.importConfiguration(v1, preview.token);
    expect(await world.agent(agent.id)).toMatchObject({ energy: 31, motivations: 'Enjoy quiet', intention: 'Visit the orchard', instructions: agent.instructions });
    expect((await world.rooms()).find(item => item.id === room.id)?.isFoodSource).toBe(true);
    const olderWithSettings: Configuration = { ...v1,
      settings: { ...defaultSettings, energy: { ...defaultSettings.energy, initial: 7 } },
      agents: [{ ...agentInput, id: 'new-older-agent' }],
    };
    const olderPreview = await world.previewConfiguration(olderWithSettings);
    expect(olderPreview.defaults.join(' ')).toContain('initial energy 100');
    await world.importConfiguration(olderWithSettings, olderPreview.token);
    expect((await world.agent('new-older-agent'))?.energy).toBe(100);
    expect((await world.settings()).value).toEqual(defaultSettings);
    const v2 = await world.exportConfiguration();
    expect(v2.agents[0]).not.toHaveProperty('energy');
    const destination = await fixture();
    await destination.importConfiguration(v2, (await destination.previewConfiguration(v2)).token);
    expect(await destination.exportConfiguration()).toEqual(v2);
  });

  it('retains attributed diagnostics after deletion/clearing and paginates without inline payloads', async () => {
    const world = await fixture(), agent = await world.saveAgent(agentInput);
    const turn = await world.scheduleTurn(agent, Date.now()), id = await world.startAttempt(turn, 1, agent);
    await world.updateDiagnostic(id, { payload: { input: 'saved conversation snapshot' } }, 'provider');
    await world.deleteAgent(agent.id);
    await world.clearHistory({ scope: 'all' });
    const page = await world.diagnostics({ agentId: agent.id, limit: 1 });
    expect(page.records[0]).toMatchObject({ agentName: agent.name, attempt: 1 });
    expect(page.records[0]).not.toHaveProperty('details');
    expect(page.hasMore).toBe(true);
    expect((await world.diagnostics({ before: page.next })).records[0].attempt).toBe(0);
    expect((await world.diagnostics({ outcome: 'provider' }, true)).records[0].details?.payload).toEqual({ input: 'saved conversation snapshot' });
    await world.interruptUnfinished();
    expect((await world.diagnostic(turn)).outcome).toBe('interrupted');
    expect((await world.diagnostic(id)).outcome).toBe('provider');
  });
  it('exports every room and all ordered messages, including a deleted agent and older pages', async () => {
    const world = await fixture();
    await world.db.insertInto('messages').values(['tie-b', 'tie-a'].map(id => ({
      id, room_id: 'room-1', agent_id: 'legacy', speaker_name: 'Legacy speaker',
      created_at: '2026-01-01T00:00:00.000Z', content: id,
    }))).execute();
    for (let index = 0; index < 205; index++) await world.speak('room-1', `Message ${index}`);
    const agent = await world.saveAgent(agentInput);
    const accepted = await world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Keep the full text.\nSecond line.' }, () => true);
    await world.deleteAgent(agent.id);
    const other = await world.speak('room-2', 'Other room conversation');
    const state = await world.state();
    const snapshot = await world.exportConversations();
    expect(Number.isFinite(Date.parse(snapshot.exportedAt))).toBe(true);
    expect(snapshot.rooms.map(room => room.id)).toEqual(state.rooms.map(room => room.id));
    expect(snapshot.rooms[0].messages).toHaveLength(208);
    expect(snapshot.rooms[0].messages.slice(0, 2).map(message => message.id)).toEqual(['tie-a', 'tie-b']);
    expect(snapshot.rooms[0].messages[2].content).toBe('Message 0');
    expect(snapshot.rooms[0].messages[207]).toEqual(accepted.message);
    expect(snapshot.rooms[1].messages).toEqual([other]);
    expect(snapshot.rooms.slice(2).every(room => room.messages.length === 0)).toBe(true);
    expect(snapshot.rooms[0]).not.toHaveProperty('description');
    expect(snapshot).not.toHaveProperty('agents');
    expect(await world.state()).toEqual(state);
    expect((await world.history({ roomId: 'room-1' })).messages).toHaveLength(100);
  });
  it('keeps room names and messages in one snapshot during a concurrent database write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-test-'));
    directories.push(directory);
    const path = join(directory, 'export-snapshot.db');
    const writer = new Database(path);
    writer.pragma('journal_mode = WAL');
    const db = createDb(path);
    databases.push(db);
    try {
      await ensureTables(db);
      const world = new World(db);
      await world.saveRoom({ id: 'room-1', name: 'Before export', description: '' });
      const before = await world.speak('room-1', 'Before export message');
      let changed = false;
      const snapshotDb = db.withPlugin({
        transformQuery: args => args.node,
        async transformResult(args) {
          if (!changed && args.result.rows.some(row => row.name === 'Before export')) {
            changed = true;
            writer.transaction(() => {
              writer.prepare('UPDATE rooms SET name = ? WHERE id = ?').run('After export', 'room-1');
              writer.prepare('INSERT INTO messages (id, room_id, agent_id, speaker_name, created_at, content) VALUES (?, ?, ?, ?, ?, ?)')
                .run('later-message', 'room-1', 'config-ui', 'Human', '2026-12-01T00:00:00.000Z', 'After export message');
            })();
          }
          return args.result;
        },
      });
      const snapshot = await new World(snapshotDb).exportConversations();
      expect(changed).toBe(true);
      expect(snapshot.rooms[0]).toMatchObject({ name: 'Before export', messages: [before] });
      expect((await world.rooms())[0].name).toBe('After export');
      expect((await world.history({ roomId: 'room-1' })).messages).toHaveLength(2);
    } finally {
      writer.close();
    }
  });
  it('permanently deletes one agent while keeping its named messages and other configuration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-test-'));
    directories.push(directory);
    const path = join(directory, 'delete-agent.db');
    const db = createDb(path);
    let deletedId: string;
    let preserved: Awaited<ReturnType<World['state']>>;
    let history: Awaited<ReturnType<World['history']>>;
    try {
      await ensureTables(db);
      const world = new World(db);
      const agent = await world.saveAgent(agentInput);
      deletedId = agent.id;
      const other = await world.saveAgent({ ...agentInput, name: 'Keep agent' });
      await world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Keep my words.' }, () => true);
      await world.speak('room-1', 'Keep human words.');
      history = await world.history({ roomId: 'room-1' });
      preserved = { ...(await world.state()), agents: [other] };
      expect(await world.deleteAgent(agent.id)).toEqual({ id: agent.id });
      expect(await world.state()).toEqual(preserved);
      expect(await world.history({ roomId: 'room-1' })).toEqual(history);
      await expect(world.deleteAgent(agent.id)).rejects.toThrow('Agent does not exist');
      await expect(world.saveAgent({ ...agentInput, id: agent.id })).rejects.toThrow('Agent does not exist');
      await expect(world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Late' }, () => true)).rejects.toThrow();
      expect((await world.exportConfiguration()).agents.map(item => item.id)).toEqual([other.id]);
    } finally {
      await db.destroy();
    }
    const reopened = createDb(path);
    databases.push(reopened);
    await ensureTables(reopened);
    const world = new World(reopened);
    expect(await world.agent(deletedId)).toBeUndefined();
    expect(await world.state()).toEqual(preserved);
    expect(await world.history({ roomId: 'room-1' })).toEqual(history);
    expect(history.messages[0].speaker).toBe(agentInput.name);
  });
  it('preserves an agent and its history when deletion fails', async () => {
    const world = await fixture();
    const agent = await world.saveAgent(agentInput);
    await world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Keep' }, () => true);
    const state = await world.state(), history = await world.history({ roomId: 'room-1' });
    await sql`CREATE TRIGGER reject_agent_delete AFTER DELETE ON agents BEGIN SELECT RAISE(ABORT, 'Injected delete failure'); END`.execute(world.db);
    await expect(world.deleteAgent(agent.id)).rejects.toThrow('Injected delete failure');
    expect(await world.state()).toEqual(state);
    expect(await world.history({ roomId: 'room-1' })).toEqual(history);
  });
  it('clears only the selected room while preserving other history and all configuration', async () => {
    const world = await fixture();
    const agent = await world.saveAgent(agentInput);
    await world.speak('room-1', 'Human message');
    await world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Agent message' }, () => true);
    const kept = await world.speak('room-2', 'Keep this room');
    const state = await world.state();
    expect(await world.clearHistory({ scope: 'room', roomId: 'room-1' })).toEqual({ roomIds: ['room-1'], deletedMessages: 2 });
    expect(await world.history({ roomId: 'room-1' })).toEqual({ messages: [], hasMore: false });
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([kept]);
    expect(await world.state()).toEqual(state);
    await expect(world.clearHistory({ scope: 'room', roomId: 'missing' })).rejects.toThrow('Room does not exist');
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([kept]);
  });
  it('keeps all-room clearing after reopening the database and accepts new conversations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-test-'));
    directories.push(directory);
    const path = join(directory, 'clear.db');
    const db = createDb(path);
    await ensureTables(db);
    const world = new World(db);
    await world.saveAgent(agentInput);
    await world.speak('room-1', 'First room');
    await world.speak('room-2', 'Second room');
    const state = await world.state();
    expect((await world.clearHistory({ scope: 'all' })).deletedMessages).toBe(2);
    await db.destroy();
    const reopened = createDb(path);
    databases.push(reopened);
    await ensureTables(reopened);
    const saved = new World(reopened);
    expect(await saved.state()).toEqual(state);
    expect(await reopened.selectFrom('messages').selectAll().execute()).toEqual([]);
    expect((await saved.clearHistory({ scope: 'all' })).deletedMessages).toBe(0);
    const message = await saved.speak('room-1', 'Fresh conversation');
    expect((await saved.history({ roomId: 'room-1' })).messages).toEqual([message]);
  });
  it('rolls back the entire clear if deletion fails', async () => {
    const world = await fixture();
    const first = await world.speak('room-1', 'Keep first');
    const second = await world.speak('room-2', 'Keep second');
    await sql`CREATE TRIGGER reject_clear BEFORE DELETE ON messages WHEN OLD.room_id = 'room-2' BEGIN SELECT RAISE(ABORT, 'Injected clear failure'); END`.execute(world.db);
    await expect(world.clearHistory({ scope: 'all' })).rejects.toThrow('Injected clear failure');
    expect((await world.history({ roomId: 'room-1' })).messages).toEqual([first]);
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([second]);
  });
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
      'settings',
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
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await world.memory('old-agent')).toEqual([]);
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
    await world.saveSettings({ ...defaultSettings, activity: { ...defaultSettings.activity, emotesEnabled: false } });
    await world.applyAction(
      agent.id,
      current!.revision,
      { type: 'wait' },
      () => true,
    );
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([]);
  });
});
