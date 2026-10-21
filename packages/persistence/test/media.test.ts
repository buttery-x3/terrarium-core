import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { defaultSettings, actionSchema, conversationMessageSchema, type Agent } from '@terrarium/shared';
import { createDb, ensureTables, World } from '../src/index.js';

let db: ReturnType<typeof createDb>, world: World;
const directories: string[] = [];
const input = { name: 'Resident', instructions: 'Be curious.', roomId: 'room-1', provider: 'chatgpt' as const,
  model: 'fake', enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-19T00:00:00.000Z');
  db = createDb(':memory:'); await ensureTables(db); world = new World(db);
});
afterEach(async () => {
  await db.destroy(); vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'terrarium-media-'))) throw new Error('Unsafe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
const enableMedia = async (overrides: Partial<typeof defaultSettings.media> = {}) => {
  await world.saveSettings({ ...defaultSettings, media: { ...defaultSettings.media, enabled: true, roomId: 'room-1', ...overrides } });
  await world.syncMedia(Date.now(), true);
};
const propose = async (agent: Agent, title = 'A film', description = 'A short description recalled by the resident.') =>
  world.applyAction(agent.id, agent.revision, { type: 'propose-media', title, description }, () => true);
const advance = async (milliseconds: number, running = true) => { vi.setSystemTime(Date.now() + milliseconds); return world.syncMedia(Date.now(), running); };

describe('shared media programme and required votes', () => {
  it('starts an idle screen immediately, bounds supported proposals and gives arrivals only the current programme', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'Remote', roomId: 'room-2' });
    const disabled = await world.saveAgent({ ...input, enabled: false });
    await expect(propose(a)).rejects.toThrow('enabled media room');
    await enableMedia();
    await expect(propose(b)).rejects.toThrow('enabled media room');
    expect(actionSchema.safeParse({ type: 'propose-media', title: '', description: 'Something' }).success).toBe(false);
    const started = await propose(a, 'The Princess Bride', 'A remembered adventure with invented details allowed.');
    const state = await world.mediaState();
    expect(state.current).toMatchObject({ title: 'The Princess Bride', description: 'A remembered adventure with invented details allowed.', proposerId: a.id });
    expect(state.remainingMs).toBe(600000); expect(state.activeBallot).toBeNull(); expect(await world.voteCandidates()).toEqual([]);
    expect(started.events).toHaveLength(1); expect(conversationMessageSchema.parse(started.events[0]).type).toBe('media');
    expect((await world.memory(disabled.id))[0]).toEqual(started.events[0]); expect(await world.memory(b.id)).toEqual([]);
    await world.applyAction(b.id, b.revision, { type: 'move', roomId: 'room-1' }, () => true);
    expect((await world.mediaDisplay('room-1'))?.current).toEqual(state.current);
    expect((await world.memory(b.id)).some(event => event.id === started.events[0].id)).toBe(false);
    expect(await world.mediaDisplay('room-2')).toBeNull();
    await expect(world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, undefined,
      { appraisals: [{ sourceId: started.events[0].id, reaction: 'like', reason: 'Enjoyable programme' }] })).rejects.toThrow('Appraisals require');
  });

  it('snapshots the original enabled local electorate and requires a real author vote before a majority replaces playback once', async () => {
    const a = await world.saveAgent({ ...input, name: 'A' }), b = await world.saveAgent({ ...input, name: 'B' }), c = await world.saveAgent({ ...input, name: 'C' });
    await world.saveAgent({ ...input, enabled: false }); await world.saveAgent({ ...input, roomId: 'room-2' });
    await enableMedia(); await propose(a, 'Original'); await advance(10000); await propose(b, 'Replacement');
    const ballot = (await world.mediaState()).activeBallot!;
    expect(ballot).toMatchObject({ electorateCount: 3, requiredChangeVotes: 2, counts: { pending: 3, change: 0 } });
    expect(ballot.votes.find(vote => vote.voterId === b.id)?.status).toBe('pending');
    expect(await world.voteCandidates()).toHaveLength(3);
    const voteInput = await world.voteInput(a.id, ballot.id);
    expect(voteInput).toMatchObject({ voterId: a.id, current: { title: 'Original' }, ballot: { title: 'Replacement' } });
    expect(JSON.stringify(voteInput)).not.toContain('votes'); expect(JSON.stringify(voteInput)).not.toContain('counts');
    await world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => true);
    await world.saveMediaVote(b.id, b.revision, ballot.id, 'change', () => true);
    expect((await world.mediaState()).current?.title).toBe('Original');
    expect((await world.mediaState()).activeBallot?.status).toBe('open');
    const result = await world.saveMediaVote(c.id, c.revision, ballot.id, 'keep', () => true);
    expect(result.ballot).toMatchObject({ status: 'passed', counts: { change: 2, keep: 1, pending: 0 } });
    expect(result.events).toHaveLength(1); expect(result.events[0].content).toContain('2 change, 1 keep');
    const state = await world.mediaState(); expect(state.current?.title).toBe('Replacement'); expect(state.remainingMs).toBe(600000);
    const currentId = state.current!.id;
    await expect(world.saveMediaVote(c.id, c.revision, ballot.id, 'change', () => true)).rejects.toThrow('already');
    expect((await world.mediaState()).current?.id).toBe(currentId); expect(await world.voteCandidates()).toEqual([]);
    expect((await world.mediaBallots()).ballots[0]).not.toHaveProperty('votes');
    expect((await world.mediaBallot(ballot.id))?.votes).toHaveLength(3);
  });

  it('keeps the programme on a failed majority, enforces one ballot and cooldown, but never blocks starting an idle screen', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' });
    await enableMedia({ programmeDurationMs: 1000, ballotDurationMs: 500, proposalCooldownMs: 5000 });
    await propose(a, 'Original'); await propose(b, 'Replacement');
    const ballot = (await world.mediaState()).activeBallot!;
    await expect(propose(a, 'Competing proposal')).rejects.toThrow('already has');
    await world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => true);
    await world.saveMediaVote(b.id, b.revision, ballot.id, 'abstain', () => true);
    expect((await world.mediaState()).lastBallot?.status).toBe('failed'); expect((await world.mediaState()).current?.title).toBe('Original');
    await expect(propose(a)).rejects.toThrow('cooling down');
    const expired = await advance(1000);
    expect(expired.some(event => event.content === 'Nothing is currently playing.')).toBe(true);
    expect((await world.mediaState()).cooldownRemainingMs).toBe(4000);
    await propose(a, 'Idle starts immediately');
    expect((await world.mediaState()).current?.title).toBe('Idle starts immediately'); expect((await world.mediaState()).activeBallot).toBeNull();
  });

  it('retains cast votes after departures, withdraws uncast departures and excludes arrivals without reducing the majority denominator', async () => {
    const agents = await Promise.all(['A', 'B', 'C', 'D'].map(name => world.saveAgent({ ...input, name })));
    const newcomer = await world.saveAgent({ ...input, name: 'Newcomer', roomId: 'room-2' });
    await enableMedia(); await propose(agents[0], 'Original'); await propose(agents[1], 'Replacement');
    const ballot = (await world.mediaState()).activeBallot!;
    await world.saveMediaVote(agents[0].id, agents[0].revision, ballot.id, 'change', () => true);
    for (const agent of agents.slice(0, 2)) await world.applyAction(agent.id, agent.revision, { type: 'move', roomId: 'room-2' }, () => true);
    await world.applyAction(newcomer.id, newcomer.revision, { type: 'move', roomId: 'room-1' }, () => true);
    expect(await world.voteInput(newcomer.id, ballot.id)).toBeNull();
    const updated = (await world.mediaBallot(ballot.id))!;
    expect(updated).toMatchObject({ electorateCount: 4, requiredChangeVotes: 3, counts: { change: 1, withdrawn: 1, pending: 2 } });
    expect(updated.votes.find(vote => vote.voterId === agents[0].id)?.status).toBe('cast');
    await world.saveMediaVote(agents[2].id, agents[2].revision, ballot.id, 'keep', () => true);
    await world.saveMediaVote(agents[3].id, agents[3].revision, ballot.id, 'change', () => true);
    expect((await world.mediaState()).lastBallot).toMatchObject({ status: 'failed', counts: { change: 2, keep: 1, withdrawn: 1 } });
  });

  it('records invalid and missing responses honestly and rejects a late response before the next timer tick', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' }), c = await world.saveAgent({ ...input, name: 'C' });
    await enableMedia({ ballotDurationMs: 1000 }); await propose(a, 'Original'); await propose(b, 'Replacement');
    const ballot = (await world.mediaState()).activeBallot!;
    await world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => true);
    const attempt = await world.startAttempt(await world.scheduleTurn(b, Date.now(), 'media-vote'), 1, b);
    await world.recordMediaVoteFailure(b.id, b.revision, ballot.id, 'invalid', 'Invalid structured response', () => true, attempt);
    expect((await world.diagnostic(attempt))).toMatchObject({ outcome: 'vote-invalid', details: { mediaVote: { status: 'invalid', choice: null } } });
    vi.setSystemTime(Date.now() + 1000);
    await expect(world.saveMediaVote(c.id, c.revision, ballot.id, 'change', () => true)).rejects.toThrow('already ended');
    await world.syncMedia();
    const result = (await world.mediaState()).lastBallot!;
    expect(result).toMatchObject({ status: 'failed', counts: { change: 1, invalid: 1, missing: 1 } });
    expect(result.votes.find(vote => vote.voterId === c.id)).toMatchObject({ status: 'missing', choice: null });
  });

  it('cancels an unresolved ballot when its programme expires instead of starting the proposal automatically', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' });
    await enableMedia({ programmeDurationMs: 1000, ballotDurationMs: 2000 }); await propose(a, 'Original'); await advance(800); await propose(b, 'Replacement');
    const ballot = (await world.mediaState()).activeBallot!;
    await world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => true);
    const events = await advance(200);
    expect((await world.mediaState())).toMatchObject({ current: null, remainingMs: 0, activeBallot: null, lastBallot: { status: 'cancelled', counts: { change: 1, cancelled: 1 } } });
    expect(events).toHaveLength(2);
    await propose(b, 'A fresh idle choice'); expect((await world.mediaState()).current?.title).toBe('A fresh idle choice');
  });

  it('freezes programme and ballot time on pause, cancels on Stop and restart, and preserves programme remainder without catch-up', async () => {
    await db.destroy(); const directory = mkdtempSync(join(tmpdir(), 'terrarium-media-')); directories.push(directory);
    const path = join(directory, 'restart.db'); db = createDb(path); await ensureTables(db); world = new World(db);
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' });
    await enableMedia(); await propose(a, 'Original'); await propose(b, 'Replacement'); await advance(1000, false);
    const paused = await world.mediaState(); expect(paused.remainingMs).toBe(599000); expect(paused.activeBallot?.remainingMs).toBe(119000);
    await advance(86400000, false); expect((await world.mediaState()).remainingMs).toBe(599000); expect((await world.mediaState()).activeBallot?.remainingMs).toBe(119000);
    await world.syncMedia(Date.now(), true); await advance(1000); await world.cancelMediaBallots('Stopped');
    expect((await world.mediaState())).toMatchObject({ remainingMs: 598000, activeBallot: null, lastBallot: { status: 'cancelled' } });
    await advance(86400000, false); expect((await world.mediaState()).remainingMs).toBe(598000);
    await world.syncMedia(Date.now(), true); await advance(300000); await propose(b, 'Pending at restart');
    const before = await world.mediaState(); await db.destroy(); vi.setSystemTime(Date.now() + 86400000);
    db = createDb(path); await ensureTables(db); world = new World(db); await world.interruptUnfinished();
    expect((await world.mediaState())).toMatchObject({ current: before.current, remainingMs: before.remainingMs, activeBallot: null, lastBallot: { status: 'cancelled' } });
    await world.syncMedia(Date.now(), false); expect((await world.mediaState()).remainingMs).toBe(before.remainingMs);
    await world.syncMedia(Date.now(), true); await advance(1000); expect((await world.mediaState()).remainingMs).toBe(before.remainingMs - 1000);
  });

  it('rolls back programme, ballots, votes and public results when diagnostics or current-operation checks fail', async () => {
    const a = await world.saveAgent(input); await enableMedia();
    const attempt = await world.startAttempt(await world.scheduleTurn(a, Date.now()), 1, a);
    await sql`CREATE TRIGGER reject_media_evidence BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'Media evidence failed'); END`.execute(db);
    await expect(world.applyAction(a.id, a.revision, { type: 'propose-media', title: 'Original', description: 'Description' }, () => true, attempt)).rejects.toThrow('Media evidence failed');
    expect((await world.mediaState()).current).toBeNull(); expect(await world.memory(a.id)).toEqual([]);
    await sql`DROP TRIGGER reject_media_evidence`.execute(db); await propose(a, 'Original'); await propose(a, 'Replacement');
    const ballot = (await world.mediaState()).activeBallot!;
    await sql`CREATE TRIGGER reject_vote_evidence BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'Vote evidence failed'); END`.execute(db);
    await expect(world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => true, attempt)).rejects.toThrow('Vote evidence failed');
    expect((await world.mediaState()).current?.title).toBe('Original'); expect((await world.mediaBallot(ballot.id))?.votes[0].status).toBe('pending');
    await sql`DROP TRIGGER reject_vote_evidence`.execute(db);
    let checks = 0;
    await expect(world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => ++checks === 1, attempt)).rejects.toThrow('no longer current');
    expect((await world.mediaBallot(ballot.id))?.votes[0].status).toBe('pending');
    const accepted = await world.saveMediaVote(a.id, a.revision, ballot.id, 'change', () => true, attempt);
    expect(accepted.ballot.status).toBe('passed'); expect((await world.diagnostic(attempt)).details?.mediaVote?.choice).toBe('change');
    expect((await world.memory(a.id)).filter(event => event.content.includes('Vote passed'))).toHaveLength(1);
  });

  it('migrates version 6 with media disabled, preserves existing settings and profiles, and requires explicit room creation', async () => {
    const a = await world.saveAgent({ ...input, intention: 'Authored intention' });
    await world.saveReflection(a.id, a.revision, { reaction: 'Private state' }, () => true);
    const { media, prompts: { mediaParticipation, mediaVote, ...prompts }, ...settings } = defaultSettings;
    await db.updateTable('settings').set({ value: JSON.stringify({ ...settings, news: { ...settings.news, intervalMs: 123000 }, prompts: { ...prompts, newsSelection: 'Custom news selection' } }) }).execute();
    for (const table of ['media_state', 'media_ballots', 'media_votes'] as const) await db.schema.dropTable(table).execute();
    await db.deleteFrom('schema_migrations').where('version', '=', 7).execute(); await ensureTables(db); await ensureTables(db);
    expect((await world.settings()).value).toMatchObject({ media, news: { intervalMs: 123000 }, prompts: { newsSelection: 'Custom news selection', mediaParticipation, mediaVote } });
    expect((await world.rooms()).some(room => room.id === 'media-room')).toBe(false);
    expect((await world.reflection(a.id)).reaction).toBe('Private state'); expect((await world.agent(a.id))?.intention).toBe('Authored intention');
    await expect(world.saveSettings({ ...(await world.settings()).value, media: { ...media, enabled: true } })).rejects.toThrow('existing assigned room');
    const configuration = await world.exportConfiguration(); expect(configuration.version).toBe(8);
    configuration.settings!.media.enabled = true;
    configuration.rooms.push({ id: 'media-room', name: 'Media Room', description: 'Movie and television choices', isFoodSource: false });
    await world.importConfiguration(configuration, (await world.previewConfiguration(configuration)).token);
    expect(await world.mediaDisplay('media-room')).toMatchObject({ current: null, remainingMs: 0, ballot: null });
  });
});
