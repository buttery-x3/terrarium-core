import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World } from '@terrarium/persistence';
import { defaultSettings, type Agent, type AgentInput, type DecisionOpportunity } from '@terrarium/shared';
import { createChatGptPayload, type LmProvider } from '@terrarium/lm-providers';
import { performMediaVote, previewMediaVote, mediaVoteJsonSchema } from '../src/media.js';
import { performDecision, previewDecision } from '../src/reflection.js';
import { contextProjection } from '../src/turns.js';
import { Scheduler, type MediaHandlers } from '../src/scheduler.js';

let db: ReturnType<typeof createDb>, world: World;
const schedulers: Scheduler[] = [], releases: (() => void)[] = [];
const input: AgentInput = { name: 'Viewer', instructions: 'Enjoy thoughtful films.', roomId: 'room-1', provider: 'chatgpt', model: 'fake', enabled: true,
  minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 };
const opportunity: DecisionOpportunity = { reflection: true, speech: false, emote: false, requestedAt: 1000000, reason: 'cadence' };
const quiet = { reflection: null, speechPlan: null, requestEmote: false, engagement: null, appraisals: [] };
const providerFor = (content: string): LmProvider => ({ name: 'fake', complete: async () => ({ content }) });
const proposal = (title: string) => ({ type: 'propose-media' as const, title, description: `A remembered description of ${title}.` });
const propose = (agent: Agent, title: string) => world.applyAction(agent.id, agent.revision, proposal(title), () => true);
const openBallot = async (agent: Agent) => {
  await propose(agent, 'Current film'); await propose(agent, 'Proposed series');
  return (await world.mediaState()).activeBallot!;
};
const vote = (agent: Agent, ballotId: string, provider = providerFor('{"choice":"keep"}'), changed = async () => {}, attemptId?: string) =>
  performMediaVote(world, agent, ballotId, provider, new AbortController().signal, () => true, () => {}, changed, attemptId);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve); return { promise, resolve };
};
const createScheduler = (voteHandler: MediaHandlers['vote'], handler: ConstructorParameters<typeof Scheduler>[1] = async () => {},
  timeoutMs = 5000, news?: ConstructorParameters<typeof Scheduler>[5], changed: MediaHandlers['changed'] = async () => {}) => {
  const scheduler = new Scheduler(world, handler, () => {}, { concurrency: 4, timeoutMs, retries: 2, backoffMs: 1 }, undefined, news,
    { vote: voteHandler, changed });
  schedulers.push(scheduler); return scheduler;
};
const finished = (scheduler: Scheduler) => vi.waitFor(() => expect(scheduler.snapshot().agents.some(agent => agent.state === 'running')).toBe(false));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000000);
  db = createDb(':memory:'); await ensureTables(db); world = new World(db);
  await world.saveSettings({ ...defaultSettings, media: { ...defaultSettings.media, enabled: true, roomId: 'room-1' } });
});
afterEach(async () => {
  await Promise.all(schedulers.map(scheduler => scheduler.close()));
  for (const release of releases.splice(0)) release();
  await vi.waitFor(() => expect(schedulers.every(scheduler => !scheduler.hasActiveWork())).toBe(true));
  schedulers.splice(0); await db.destroy(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('media decisions and independent votes', () => {
  it('offers a proposal only locally and starts an idle screen without a ballot or speech', async () => {
    const agent = await world.saveAgent(input), remote = await world.saveAgent({ ...input, name: 'Remote', roomId: 'room-2' });
    const preview = await previewDecision(world, agent, opportunity), elsewhere = await previewDecision(world, remote, opportunity);
    expect(JSON.stringify(preview.payload)).toContain('propose-media');
    expect(preview.context.mediaDisplay).toMatchObject({ current: null });
    expect(elsewhere.context.mediaDisplay).toBeNull();
    const allowed = (preview.payload.text as { format: { schema: { properties: { action: { anyOf: unknown[] } } } } }).format.schema.properties.action.anyOf;
    expect(JSON.stringify(allowed)).toContain('propose-media');
    const remoteAllowed = (elsewhere.payload.text as { format: { schema: { properties: { action: { anyOf: unknown[] } } } } }).format.schema.properties.action.anyOf;
    expect(JSON.stringify(remoteAllowed)).not.toContain('propose-media');
    await performDecision(world, agent, providerFor(JSON.stringify({ ...quiet, action: proposal('The invented adventure') })),
      new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, opportunity);
    expect(await world.mediaState()).toMatchObject({ current: { title: 'The invented adventure', description: 'A remembered description of The invented adventure.' },
      remainingMs: 600000, activeBallot: null });
    expect((await world.memory(agent.id)).map(message => message.type)).toEqual(['media']);
    await expect(performDecision(world, remote, providerFor(JSON.stringify({ ...quiet, action: proposal('Remote proposal') })),
      new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, opportunity)).rejects.toMatchObject({ category: 'world-validation' });
  });

  it('shows an arrival the current title and description without inserting earlier display events into their memory', async () => {
    const agent = await world.saveAgent(input);
    await propose(agent, 'Current film');
    const arrival = await world.saveAgent({ ...input, name: 'Arrival' });
    const context = await contextProjection(world, arrival);
    expect(context.mediaDisplay).toMatchObject({ current: { title: 'Current film', description: 'A remembered description of Current film.' }, remainingMs: 600000 });
    expect(context.memory).toEqual([]);
  });

  it('records an actual proposer choice and exact private request diagnostics without revealing other votes', async () => {
    const agent = await world.saveAgent({ ...input, reasoningEffort: 'low' }), other = await world.saveAgent({ ...input, name: 'Other', instructions: 'OTHER PRIVATE PROFILE' });
    await world.saveReflection(other.id, other.revision, { reaction: 'OTHER PRIVATE REACTION' }, () => true);
    const ballot = await openBallot(agent);
    expect(ballot.votes.every(vote => vote.status === 'pending' && vote.choice === null)).toBe(true);
    await world.saveMediaVote(other.id, other.revision, ballot.id, 'change', () => true);
    const preview = (await previewMediaVote(world, agent, ballot.id))!, payload = JSON.stringify(preview.payload);
    expect(preview.payload).toMatchObject({ reasoning: { effort: 'low' } });
    expect(payload).not.toContain('OTHER PRIVATE PROFILE'); expect(payload).not.toContain('OTHER PRIVATE REACTION');
    expect(preview.context.vote).not.toHaveProperty('votes'); expect(preview.context.mediaDisplay).not.toHaveProperty('activeBallot');
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now(), 'media-vote'), 1, agent);
    await vote(agent, ballot.id, { name: 'fake', complete: async request => {
      expect(request.reasoningEffort).toBe('low');
      expect(request.responseFormat?.schema).toEqual(mediaVoteJsonSchema);
      await request.onRequest?.(createChatGptPayload(request));
      return { content: '{"choice":"keep"}', responseId: 'vote-response', requestId: 'vote-request' };
    } }, async () => {}, attempt);
    const state = await world.mediaState();
    expect(state.current?.title).toBe('Current film');
    expect(state.lastBallot).toMatchObject({ status: 'failed', requiredChangeVotes: 2, counts: { change: 1, keep: 1 } });
    expect(state.lastBallot?.votes.find(record => record.voterId === agent.id)).toMatchObject({ status: 'cast', choice: 'keep' });
    expect((await world.diagnostic(attempt)).details).toMatchObject({ payload: preview.payload, output: '{"choice":"keep"}',
      proposal: { choice: 'keep' }, requestId: 'vote-request', responseId: 'vote-response', mediaVote: { status: 'cast', choice: 'keep' } });
    expect(await previewMediaVote(world, agent, ballot.id)).toBeNull();
  });

  it.each(['not JSON', '{"choice":"yes"}', '{"choice":"change","action":{"type":"speak","message":"agree"}}'])
    ('records invalid output honestly without treating it as agreement: %s', async content => {
      const agent = await world.saveAgent(input), ballot = await openBallot(agent);
      const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now(), 'media-vote'), 1, agent);
      await vote(agent, ballot.id, providerFor(content), async () => {}, attempt);
      const state = await world.mediaState();
      expect(state.current?.title).toBe('Current film');
      expect(state.lastBallot?.votes[0]).toMatchObject({ status: 'invalid', choice: null });
      expect((await world.diagnostic(attempt)).outcome).toBe('vote-invalid');
      expect((await world.diagnostic(attempt)).details.output).toBe(content);
    });

  it('records provider failure as missing and makes no repeat request', async () => {
    const agent = await world.saveAgent(input), ballot = await openBallot(agent);
    const complete = vi.fn(async () => { throw new Error('Provider unavailable'); });
    const scheduler = createScheduler((actor, id, signal, current, applied, attempt) =>
      performMediaVote(world, actor, id, { name: 'fake', complete }, signal, current, applied, async () => {}, attempt));
    await scheduler.start(); await scheduler.tick(); await finished(scheduler); await scheduler.tick(); await finished(scheduler);
    expect(complete).toHaveBeenCalledOnce();
    expect((await world.mediaState()).lastBallot).toMatchObject({ id: ballot.id, status: 'failed', votes: [{ status: 'missing', choice: null }] });
  });

  it('excludes late arrivals and discards a response when its voter leaves during the request', async () => {
    const agent = await world.saveAgent(input), other = await world.saveAgent({ ...input, name: 'Other' }), ballot = await openBallot(agent);
    const arrival = await world.saveAgent({ ...input, name: 'Arrival' });
    expect(await previewMediaVote(world, arrival, ballot.id)).toBeNull();
    await expect(vote(other, ballot.id, { name: 'fake', complete: async () => {
      await world.applyAction(other.id, other.revision, { type: 'move', roomId: 'room-2' }, () => true);
      return { content: '{"choice":"change"}' };
    } })).rejects.toMatchObject({ category: 'stale' });
    await world.syncMedia();
    expect((await world.mediaState()).activeBallot).toMatchObject({ electorateCount: 2, requiredChangeVotes: 2,
      votes: expect.arrayContaining([expect.objectContaining({ voterId: other.id, status: 'withdrawn', choice: null })]) });
  });

  it('rejects a response arriving after the running-time deadline', async () => {
    const agent = await world.saveAgent(input), ballot = await openBallot(agent);
    await world.syncMedia(Date.now(), true);
    await expect(vote(agent, ballot.id, { name: 'fake', complete: async () => {
      vi.setSystemTime(1120000); await world.syncMedia();
      return { content: '{"choice":"change"}' };
    } })).rejects.toMatchObject({ category: 'stale' });
    expect((await world.mediaState()).lastBallot).toMatchObject({ status: 'failed', votes: [{ status: 'missing', choice: null }] });
    expect((await world.mediaState()).current?.title).toBe('Current film');
  });

  it('keeps an actual saved vote when notification fails', async () => {
    const agent = await world.saveAgent(input), ballot = await openBallot(agent);
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now(), 'media-vote'), 1, agent);
    await expect(vote(agent, ballot.id, providerFor('{"choice":"change"}'), async () => { throw new Error('Notification failed'); }, attempt))
      .rejects.toMatchObject({ category: 'applied-notification-failure' });
    expect((await world.mediaState()).current?.title).toBe('Proposed series');
    expect((await world.mediaState()).lastBallot?.votes[0]).toMatchObject({ status: 'cast', choice: 'change' });
    expect((await world.diagnostic(attempt)).outcome).toBe('applied-notification-failure');
  });
});

describe('media scheduling and running clocks', () => {
  it('requests votes independently of ordinary cadence and allows only one operation per resident', async () => {
    const agent = await world.saveAgent(input), pending = deferred();
    const ordinary = vi.fn(async () => { await pending.promise; });
    const voting = vi.fn(async (actor, id, _signal, current, applied) => { await world.saveMediaVote(actor.id, actor.revision, id, 'keep', current); applied(); });
    const scheduler = createScheduler(voting, ordinary);
    await scheduler.start(); await scheduler.tick(); await vi.waitFor(() => expect(ordinary).toHaveBeenCalledOnce());
    await openBallot(agent); await scheduler.tick(); expect(voting).not.toHaveBeenCalled();
    pending.resolve(); await finished(scheduler);
    await scheduler.tick(); await finished(scheduler);
    expect(voting).toHaveBeenCalledOnce(); expect(ordinary).toHaveBeenCalledOnce();
    expect(scheduler.snapshot().agents[0].nextReflectionAt).toBeGreaterThan(Date.now());
  });

  it('shares four slots across news, votes and ordinary work', async () => {
    await world.saveSettings({ ...(await world.settings()).value, news: { ...defaultSettings.news, enabled: true } });
    const agents = [];
    for (let index = 0; index < 5; index++) agents.push(await world.saveAgent({ ...input, name: `Viewer ${index}` }));
    await openBallot(agents[0]);
    const active = new Set<string>(), pending = deferred(); let peak = 0;
    const begin = async (id: string) => { expect(active.has(id)).toBe(false); active.add(id); peak = Math.max(peak, active.size); await pending.promise; active.delete(id); };
    const scheduler = createScheduler(agent => begin(agent.id), agent => begin(agent.id), 5000, () => begin('news'));
    await scheduler.start(); await scheduler.tick(); await vi.waitFor(() => expect(active.size).toBe(4));
    expect(active.has('news')).toBe(true); expect(peak).toBe(4);
    await scheduler.tick(); expect(active.size).toBe(4); expect(peak).toBe(4);
    pending.resolve(); await finished(scheduler);
  });

  it('marks a timeout missing, never retries it, and holds its occupied slot until the handler settles', async () => {
    const agent = await world.saveAgent(input); await openBallot(agent);
    const pending = deferred(), complete = vi.fn(async () => { await pending.promise; return { content: '{"choice":"change"}' }; });
    const ordinary = vi.fn(async () => {});
    const scheduler = createScheduler((actor, id, signal, current, applied, attempt) =>
      performMediaVote(world, actor, id, { name: 'fake', complete }, signal, current, applied, async () => {}, attempt), ordinary, 10);
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(async () => expect((await world.mediaState()).lastBallot?.votes[0]).toMatchObject({ status: 'missing', choice: null }));
    await finished(scheduler); await scheduler.tick();
    expect(complete).toHaveBeenCalledOnce(); expect(ordinary).not.toHaveBeenCalled(); expect(scheduler.hasActiveWork()).toBe(true);
    const record = (await world.diagnostics()).records.find(record => record.action === 'media-vote')!;
    expect((await world.diagnostic(record.id)).details.mediaVote).toMatchObject({ status: 'missing', choice: null });
    pending.resolve(); await vi.waitFor(() => expect(scheduler.hasActiveWork()).toBe(false));
    await scheduler.tick(); await finished(scheduler); expect(ordinary).toHaveBeenCalledOnce();
    expect((await world.mediaState()).current?.title).toBe('Current film');
  });

  it('freezes programme and ballot clocks during Pause and cancels only the ballot on Stop', async () => {
    const agent = await world.saveAgent(input); await openBallot(agent);
    const pending = deferred(), scheduler = createScheduler(async () => { await pending.promise; });
    await scheduler.start(); await scheduler.tick();
    vi.setSystemTime(1030000); scheduler.pause();
    await vi.waitFor(async () => expect((await world.mediaState()).remainingMs).toBe(570000));
    vi.setSystemTime(2030000); await world.syncMedia();
    expect(await world.mediaState()).toMatchObject({ remainingMs: 570000, activeBallot: { remainingMs: 90000 } });
    await scheduler.start(); vi.setSystemTime(2040000); await scheduler.tick();
    expect(await world.mediaState()).toMatchObject({ remainingMs: 560000, activeBallot: { remainingMs: 80000 } });
    await scheduler.stop();
    expect(await world.mediaState()).toMatchObject({ current: { title: 'Current film' }, remainingMs: 560000, activeBallot: null,
      lastBallot: { status: 'cancelled', votes: [{ status: 'cancelled', choice: null }] } });
    vi.setSystemTime(4040000); await scheduler.start();
    expect((await world.mediaState()).remainingMs).toBe(560000);
    pending.resolve(); await vi.waitFor(() => expect(scheduler.hasActiveWork()).toBe(false));
  });

  it('keeps the missing vote in diagnostics when a provider immediately rejects an abort', async () => {
    const agent = await world.saveAgent(input); await openBallot(agent);
    const complete = vi.fn(async request => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    }));
    const scheduler = createScheduler((actor, id, signal, current, applied, attempt) =>
      performMediaVote(world, actor, id, { name: 'fake', complete }, signal, current, applied, async () => {}, attempt), async () => {}, 10);
    await scheduler.start(); await scheduler.tick(); await finished(scheduler);
    expect(complete).toHaveBeenCalledOnce();
    const records = await world.diagnostics({ action: 'media-vote' });
    expect(records.records).toHaveLength(1);
    expect(await world.diagnostic(records.records[0].id)).toMatchObject({ outcome: 'vote-missing',
      details: { mediaVote: { status: 'missing', choice: null, error: 'The model request timed out.' } } });
  });

  it('expires a programme to an idle display and emits its transition once', async () => {
    const agent = await world.saveAgent(input); await propose(agent, 'Current film');
    const changed = vi.fn(async () => {}), scheduler = createScheduler(async () => {}, async () => {}, 5000, undefined, changed);
    await scheduler.start(); vi.setSystemTime(1599000); await scheduler.tick(); await finished(scheduler);
    expect((await world.mediaState()).remainingMs).toBe(1000);
    vi.setSystemTime(1600000); await scheduler.tick(); await finished(scheduler);
    expect(await world.mediaDisplay('room-1')).toMatchObject({ current: null, remainingMs: 0 });
    expect(changed).toHaveBeenCalledOnce(); expect(changed.mock.calls[0][0][0].content).toBe('Nothing is currently playing.');
    await scheduler.tick(); expect(changed).toHaveBeenCalledOnce();
    await propose(agent, 'A new film'); expect((await world.mediaState()).activeBallot).toBeNull();
  });
});
