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

describe('private reflection and local exchanges', () => {
  it('saves private state with an action atomically and keeps inactivity private and authored profiles intact', async () => {
    const agent = await world.saveAgent({ ...input, intention: 'Authored profile intention' });
    expect(await world.reflection(agent.id)).toMatchObject({ reflectedAt: null, reaction: null, intention: null });
    const turn = await world.scheduleTurn(agent, Date.now(), 'reflection', 1000);
    const attempt = await world.startAttempt(turn, 1, agent);
    const decision = { reflection: { reaction: 'Quietly interested', intention: 'Listen for now' } };
    await sql`CREATE TRIGGER reject_reflection BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'Evidence failed'); END`.execute(db);
    await expect(world.applyAction(agent.id, agent.revision, { type: 'wait' }, () => true, attempt, decision)).rejects.toThrow('Evidence failed');
    expect((await world.reflection(agent.id)).reflectedAt).toBeNull();
    await sql`DROP TRIGGER reject_reflection`.execute(db);
    await world.applyAction(agent.id, agent.revision, { type: 'wait' }, () => true, attempt, decision);
    const saved = await world.reflection(agent.id);
    expect(saved).toMatchObject({ ...decision.reflection, reflectedAt: expect.any(String), lastSpeechAt: null, lastEmoteAt: null });
    expect(await world.memory(agent.id)).toEqual([]);
    expect((await world.agent(agent.id))?.intention).toBe('Authored profile intention');
    expect(await world.diagnostic(attempt)).toMatchObject({ operation: 'reflection', requestedAt: '1970-01-01T00:00:01.000Z', details: { reflection: saved } });
    await expect(world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'A duplicate' }, () => true, attempt, decision)).rejects.toThrow('already ended');
    expect(await world.memory(agent.id)).toEqual([]);
    await world.applyAction(agent.id, agent.revision, { type: 'wait' }, () => true, undefined, { reflection: null, engagement: null });
    expect(await world.reflection(agent.id)).toEqual(saved);
    expect(JSON.stringify(await world.exportConfiguration())).not.toContain('Quietly interested');
    expect(JSON.stringify(await world.state())).not.toContain('Listen for now');
    let checks = 0;
    await expect(world.saveReflection(agent.id, agent.revision, { reaction: 'Stale result' }, () => ++checks === 1)).rejects.toThrow('no longer current');
    expect(await world.reflection(agent.id)).toEqual(saved);
  });

  it('derives conversation roots and rejects unwitnessed, non-speech, self and departed reply sources', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' });
    const elsewhere = await world.saveAgent({ ...input, roomId: 'room-2' });
    const first = (await act(a.id, { type: 'speak', message: 'The first topic' })).message!;
    const reply = (await act(b.id, { type: 'speak', message: 'A response', replyToId: first.id })).message!;
    const next = (await act(a.id, { type: 'speak', message: 'Continuing', replyToId: reply.id })).message!;
    expect(first.conversationId).toBe(first.id);
    expect(reply).toMatchObject({ replyToId: first.id, conversationId: first.id });
    expect(next).toMatchObject({ replyToId: reply.id, conversationId: first.id });
    await expect(act(elsewhere.id, { type: 'speak', message: 'Not witnessed', replyToId: first.id })).rejects.toThrow('witnessed');
    await expect(act(a.id, { type: 'speak', message: 'Self reply', replyToId: first.id })).rejects.toThrow('witnessed');
    const emote = (await act(a.id, { type: 'emote', message: 'A watches.' })).message!;
    await expect(act(b.id, { type: 'speak', message: 'Invalid source', replyToId: emote.id })).rejects.toThrow('witnessed');
    expect((await world.reflection(a.id)).lastSpeechAt).toBe(next.createdAt);
    expect((await world.reflection(a.id)).lastEmoteAt).toBe(emote.createdAt);
    await act(a.id, { type: 'move', roomId: 'room-2' });
    await expect(act(b.id, { type: 'speak', message: 'Too late', replyToId: first.id })).rejects.toThrow('witnessed');
    await expect(world.applyAction(b.id, b.revision, { type: 'speak', message: 'Target departed' }, () => true, undefined, { targetAgentId: a.id })).rejects.toThrow('interlocutor');
  });

  it('accepts the original witnessed snapshot after FIFO eviction and clears local engagement on departure or deletion', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, contextMessageLimit: 1 });
    const source = (await act(a.id, { type: 'speak', message: 'A topic' })).message!;
    const sourceIds = (await world.memory(b.id)).map(item => item.id);
    await act(a.id, { type: 'emote', message: 'A sits.' });
    await expect(world.validateReply(b.id, source.id)).rejects.toThrow('witnessed');
    const engagement = { roomId: b.roomId, rootMessageId: source.id, targetAgentId: a.id };
    await world.applyAction(b.id, b.revision, { type: 'speak', message: 'Still replying', replyToId: source.id }, () => true, undefined, { sourceIds, engagement });
    expect((await world.reflection(b.id)).engagement).toEqual(engagement);
    await world.saveSettings({ ...defaultSettings, activity: { ...defaultSettings.activity, roomEventsEnabled: false } });
    await act(a.id, { type: 'move', roomId: 'room-2' });
    expect((await world.reflection(b.id)).engagement).toBeNull();
    await act(a.id, { type: 'move', roomId: 'room-1' });
    const fresh = (await act(a.id, { type: 'speak', message: 'A fresh topic' })).message!;
    await world.saveReflection(b.id, b.revision, { engagement: { ...engagement, rootMessageId: fresh.id } }, () => true);
    expect((await world.reflection(b.id)).reflectedAt).toBeNull();
    await world.deleteAgent(a.id);
    expect((await world.reflection(b.id)).engagement).toBeNull();
    expect(await world.reflections()).toHaveLength(1);
  });

  it('validates persisted timing overrides against new shared settings and configuration imports', async () => {
    const a = await world.saveAgent({ ...input, timingOverrides: { speechMinDelayMs: 30000 } });
    expect(a.timingOverrides).toEqual({ speechMinDelayMs: 30000 });
    await expect(world.saveSettings({ ...defaultSettings, scheduling: { ...defaultSettings.scheduling, speechMaxDelayMs: 20000 } })).rejects.toThrow('Maximum');
    await expect(world.saveAgent({ ...input, timingOverrides: { emoteMaxIntervalMs: 1 } })).rejects.toThrow('Maximum');
    const configuration = await world.exportConfiguration();
    configuration.agents[0].timingOverrides = { speechMinDelayMs: 200000 };
    await expect(world.previewConfiguration(configuration)).rejects.toThrow('Maximum');
    expect((await world.agent(a.id))?.timingOverrides).toEqual({ speechMinDelayMs: 30000 });
  });

  it('clears saved engagement when disabled by settings or import and rejects disabled targets at apply time', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' });
    const source = (await act(a.id, { type: 'speak', message: 'A local topic' })).message!;
    const engagement = { roomId: b.roomId, rootMessageId: source.id, targetAgentId: a.id };
    await world.saveReflection(b.id, b.revision, { engagement }, () => true);
    await world.saveSettings({ ...defaultSettings, scheduling: { ...defaultSettings.scheduling, engagementEnabled: false } });
    expect((await world.reflection(b.id)).engagement).toBeNull();
    await world.saveSettings(defaultSettings);
    await world.saveReflection(b.id, b.revision, { engagement }, () => true);
    const configuration = await world.exportConfiguration();
    configuration.settings!.scheduling.engagementEnabled = false;
    await world.importConfiguration(configuration, (await world.previewConfiguration(configuration)).token);
    expect((await world.reflection(b.id)).engagement).toBeNull();
    await world.saveAgent({ ...input, id: a.id, enabled: false });
    const currentB = (await world.agent(b.id))!;
    await expect(world.applyAction(b.id, currentB.revision, { type: 'speak', message: 'Too late' }, () => true, undefined, { targetAgentId: a.id })).rejects.toThrow('interlocutor');
    await expect(world.applyAction(b.id, currentB.revision, { type: 'speak', message: 'Invalid reply', replyToId: source.id }, () => true)).rejects.toThrow('witnessed');
  });

  it('migrates version 3 without modifying observations, energy or authored profiles and resets only engagement on restart', async () => {
    const a = await world.saveAgent({ ...input, intention: 'Authored', motivations: 'Stay curious' });
    const b = await world.saveAgent({ ...input, name: 'B' });
    const source = (await act(b.id, { type: 'speak', message: 'Preserved evidence' })).message!;
    const { scheduling, relationships, prompts: { reflection, appraisals, relationshipSummary, ...prompts }, ...settings } = defaultSettings;
    await db.updateTable('settings').set({ value: JSON.stringify({ ...settings, prompts: { ...prompts, actionSelection: 'Custom action guidance' } }) }).execute();
    await db.updateTable('agents').set({ energy: 42 }).where('id', '=', a.id).execute();
    await db.schema.dropTable('reflections').execute();
    await sql`ALTER TABLE agents DROP COLUMN timing_overrides`.execute(db);
    await sql`ALTER TABLE messages DROP COLUMN reply_to_id`.execute(db);
    await sql`ALTER TABLE messages DROP COLUMN conversation_id`.execute(db);
    await sql`ALTER TABLE decisions DROP COLUMN operation`.execute(db);
    await sql`ALTER TABLE decisions DROP COLUMN requested_at`.execute(db);
    await db.deleteFrom('schema_migrations').where('version', '=', 4).execute();
    await ensureTables(db); await ensureTables(db);
    expect((await world.agent(a.id))).toMatchObject({ intention: 'Authored', motivations: 'Stay curious', energy: 42 });
    expect((await world.memory(a.id))[0]).toMatchObject({ id: source.id, content: 'Preserved evidence' });
    expect((await world.settings()).value).toMatchObject({ scheduling, prompts: { actionSelection: 'Custom action guidance', reflection } });
    await world.saveReflection(a.id, a.revision, { reaction: 'Interested', intention: 'Reply later', engagement: { roomId: a.roomId, rootMessageId: source.id, targetAgentId: b.id } }, () => true);
    const saved = await world.reflection(a.id);
    const restarted = new World(db);
    await restarted.interruptUnfinished();
    expect(await restarted.reflection(a.id)).toEqual({ ...saved, engagement: null });
    expect((await world.exportConfiguration()).version).toBe(5);
  });
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
    expect((await act(a.id, { type: 'wait' })).message).toBeUndefined();
    expect(await world.memory(a.id)).toEqual([]);
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
    const { activity, scheduling, relationships, prompts: { observations, emotes, reflection, appraisals, relationshipSummary, ...prompts }, ...settings } = defaultSettings;
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
    expect(configuration.version).toBe(5);
    expect(JSON.stringify(configuration)).not.toContain('After migration');
    await db.destroy(); db = createDb(path); await ensureTables(db); world = new World(db);
    expect([await world.memory(a.id), await world.memory(b.id)]).toEqual(memories);
    expect((await world.agent(a.id))?.contextMessageLimit).toBe(2);
  });
});
