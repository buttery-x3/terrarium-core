import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World } from '@terrarium/persistence';
import { defaultSettings, type Agent, type AgentInput } from '@terrarium/shared';
import { createChatGptPayload, type LmProvider } from '@terrarium/lm-providers';
import { performDecision, previewDecision } from '../src/reflection.js';
import { performRelationshipSummary, previewRelationshipSummary } from '../src/relationships.js';
import { Scheduler } from '../src/scheduler.js';

let db: ReturnType<typeof createDb>, world: World;
const schedulers: Scheduler[] = [];
const input: AgentInput = { name: 'Observer', instructions: 'Enjoy quiet conversation.', roomId: 'room-1', provider: 'chatgpt', model: 'fake',
  enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 };
const opportunity = { reflection: true, speech: false, emote: false, requestedAt: 1000, reason: 'cadence' as const };
const quiet = { reflection: null, speechPlan: null, requestEmote: false, engagement: null, appraisals: [], action: { type: 'wait' } };
const providerFor = (value: unknown): LmProvider => ({ name: 'fake', complete: async () => ({ content: JSON.stringify(value) }) });
const reflect = (agent: Agent, value: unknown) => performDecision(world, agent, providerFor(value), new AbortController().signal,
  () => true, () => {}, async () => {}, () => {}, undefined, opportunity);
const appraise = async (observer: Agent, target: Agent, message = 'A considerate contribution.') => {
  const source = (await world.applyAction(target.id, target.revision, { type: 'speak', message }, () => true)).message!;
  const accepted = await world.applyAction(observer.id, observer.revision, { type: 'wait' }, () => true, undefined,
    { sourceIds: [source.id], appraisals: [{ sourceId: source.id, reaction: 'like', reason: 'Considerate.' }] });
  return accepted.acceptedAppraisals[0];
};
const summarize = (observer: Agent, target: Agent, provider: LmProvider, signal = new AbortController().signal) =>
  performRelationshipSummary(world, observer, target.id, provider, signal, () => true, () => {});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(async () => { db = createDb(':memory:'); await ensureTables(db); world = new World(db); });
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.close()));
  await db.destroy(); vi.restoreAllMocks();
});

describe('reflection appraisals and relationship summaries', () => {
  it('accepts optional appraisals once and leaves outward activity unchanged', async () => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(target.id, target.revision, { type: 'emote', message: 'Companion offers a patient smile.' }, () => true)).message!;
    const response = { ...quiet, appraisals: [{ sourceId: source.id, reaction: 'like', reason: 'The patient gesture is welcoming.' }] };
    await reflect(observer, response); await reflect(observer, response);
    expect((await world.appraisals({ observerId: observer.id })).appraisals).toHaveLength(1);
    expect((await world.relationshipPage({ observerId: observer.id })).relationships[0].score).toBe(1);
    expect(await world.memory(observer.id)).toEqual([source]);
    await reflect(observer, quiet);
    expect((await world.relationshipPage({ observerId: observer.id })).relationships[0].score).toBe(1);
  });

  it('enforces the configured appraisal capacity in both the prompt schema and accepted response', async () => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(target.id, target.revision, { type: 'speak', message: 'A contribution.' }, () => true)).message!;
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, maxAppraisalsPerReflection: 0 } });
    const preview = await previewDecision(world, observer, opportunity);
    expect(JSON.stringify(preview.payload)).toContain('"maxItems":0');
    await expect(reflect(observer, { ...quiet, appraisals: [{ sourceId: source.id, reaction: 'like', reason: 'Interested.' }] }))
      .rejects.toMatchObject({ category: 'schema' });
    expect((await world.appraisals({ observerId: observer.id })).appraisals).toEqual([]);
  });

  it('rejects appraisals for evidence absent from the actual request snapshot atomically', async () => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    await expect(performDecision(world, observer, { name: 'fake', complete: async () => {
      const source = (await world.applyAction(target.id, target.revision, { type: 'speak', message: 'Arrived during the request.' }, () => true)).message!;
      return { content: JSON.stringify({ ...quiet, reflection: { reaction: 'Must not be saved.', intention: null },
        appraisals: [{ sourceId: source.id, reaction: 'like', reason: 'Interested.' }] }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, opportunity))
      .rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.reflection(observer.id)).reaction).toBeNull();
    expect((await world.appraisals({ observerId: observer.id })).appraisals).toEqual([]);
  });

  it('keeps relationship context bounded and directional without exposing another observer’s impressions', async () => {
    const observer = await world.saveAgent(input), targets: Agent[] = [];
    for (let index = 0; index < 9; index++) {
      const target = await world.saveAgent({ ...input, name: `Companion ${index}` });
      targets.push(target); await appraise(observer, target);
    }
    await appraise(targets[0], observer, 'Public speech only.');
    const privateEvidence = (await world.appraisals({ observerId: targets[0].id })).appraisals[0];
    await summarize(targets[0], observer, providerFor({ summary: 'OTHER OBSERVER PRIVATE SUMMARY', appraisalIds: [privateEvidence.id] }));
    const preview = await previewDecision(world, observer, opportunity);
    expect(preview.context.relationships).toHaveLength(8);
    expect(preview.context.relationships.every(relationship => relationship.targetAgentId !== observer.id)).toBe(true);
    expect(JSON.stringify(preview.payload)).not.toContain('OTHER OBSERVER PRIVATE SUMMARY');
  });

  it('stores an evidence-linked private summary and captures the exact preview request', async () => {
    const observer = await world.saveAgent({ ...input, reasoningEffort: 'high' }), target = await world.saveAgent({ ...input, name: 'Companion', instructions: 'SECRET TARGET PROFILE' });
    const evidence = await appraise(observer, target);
    await world.saveSettings({ ...defaultSettings, prompts: { ...defaultSettings.prompts, relationshipSummary: 'CUSTOM SUMMARY PROMPT' } });
    const preview = await previewRelationshipSummary(world, observer, target.id);
    expect(preview!.payload).toMatchObject({ reasoning: { effort: 'high' } });
    const attempt = await world.startAttempt(await world.scheduleTurn(observer, Date.now(), 'relationship-summary'), 1, observer);
    const complete = vi.fn(async request => {
      expect(request.reasoningEffort).toBe('high');
      expect(request.messages[0].content).toContain('CUSTOM SUMMARY PROMPT');
      expect(JSON.stringify(request.messages)).not.toContain('SECRET TARGET PROFILE');
      await request.onRequest?.(createChatGptPayload(request));
      return { content: JSON.stringify({ summary: 'Their considerate contribution felt welcoming.', appraisalIds: [evidence.id] }), requestId: 'summary-request' };
    });
    const saved = await performRelationshipSummary(world, observer, target.id, { name: 'fake', complete },
      new AbortController().signal, () => true, () => {}, attempt);
    expect(saved).toMatchObject({ observerId: observer.id, targetAgentId: target.id, version: 1, appraisalIds: [evidence.id] });
    expect((await world.diagnostic(attempt)).details).toMatchObject({ payload: preview!.payload, requestId: 'summary-request', relationshipSummary: saved });
    await summarize(observer, target, { name: 'fake', complete });
    expect(complete).toHaveBeenCalledOnce();
    expect(await previewRelationshipSummary(world, observer, target.id)).toBeNull();
    expect((await world.memory(observer.id)).map(message => message.id)).toEqual([evidence.source.id]);
  });

  it('rejects unsupported summary evidence without changing the saved impression', async () => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    await appraise(observer, target);
    await expect(summarize(observer, target, providerFor({ summary: 'Invented support.', appraisalIds: ['unseen-evidence'] })))
      .rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.relationshipSummaries(observer.id, target.id)).summaries).toEqual([]);
    expect(await world.summaryInput(observer.id, target.id)).not.toBeNull();
  });

  it('summarises bounded batches and leaves evidence arriving during a request pending', async () => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, summaryBatchSize: 1 } });
    const first = await appraise(observer, target, 'First contribution.');
    let secondId = '';
    await summarize(observer, target, { name: 'fake', complete: async request => {
      const context = JSON.parse(request.messages[1].content);
      expect(context.appraisals.map((item: { id: string }) => item.id)).toEqual([first.id]);
      secondId = (await appraise(observer, target, 'A later contribution.')).id;
      return { content: JSON.stringify({ summary: 'A welcoming first impression.', appraisalIds: [first.id] }) };
    } });
    const next = await previewRelationshipSummary(world, observer, target.id);
    expect(next!.context.relationship.previous?.version).toBe(1);
    expect(next!.context.relationship.appraisals.map(item => item.id)).toEqual([secondId]);
    await summarize(observer, target, providerFor({ summary: 'Their contributions have both been welcoming.', appraisalIds: [first.id, secondId] }));
    const summaries = (await world.relationshipSummaries(observer.id, target.id)).summaries;
    expect(summaries.map(summary => summary.version)).toEqual([2, 1]);
    expect(summaries[0].previousSummaryId).toBe(summaries[1].id);
    expect(await world.summaryInput(observer.id, target.id)).toBeNull();
  });

  it.each(['cancelled', 'superseded'] as const)('discards %s summary output', async kind => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    const evidence = await appraise(observer, target), controller = new AbortController();
    await expect(summarize(observer, target, { name: 'fake', complete: async () => {
      if (kind === 'cancelled') controller.abort();
      else await world.saveRelationshipSummary(observer.id, observer.revision, { targetAgentId: target.id, previousVersion: 0,
        throughSequence: evidence.sequence, summary: 'Already saved.', appraisalIds: [evidence.id] }, () => true);
      return { content: JSON.stringify({ summary: 'Late replacement.', appraisalIds: [evidence.id] }) };
    } }, controller.signal)).rejects.toMatchObject({ category: kind === 'cancelled' ? 'cancelled' : 'stale' });
    expect((await world.relationshipSummaries(observer.id, target.id)).summaries.map(summary => summary.summary))
      .toEqual(kind === 'cancelled' ? [] : ['Already saved.']);
  });

  it('permits an operator summary preview for a disabled observer but does not execute it', async () => {
    const observer = await world.saveAgent(input), target = await world.saveAgent({ ...input, name: 'Companion' });
    await appraise(observer, target);
    const disabled = await world.saveAgent({ ...input, id: observer.id, enabled: false });
    expect(await previewRelationshipSummary(world, disabled, target.id)).not.toBeNull();
    await expect(summarize(disabled, target, providerFor({}))).rejects.toMatchObject({ category: 'stale' });
  });
});

describe('relationship summary scheduling', () => {
  const timingOverrides = { reflectionIntervalMs: 2000, emoteMinIntervalMs: 2000000, emoteMaxIntervalMs: 2000000 };
  const finished = async (scheduler: Scheduler) => {
    await vi.waitFor(() => expect(scheduler.snapshot().agents.some(agent => agent.state === 'running')).toBe(false));
  };

  it('shares four slots with ordinary decisions and runs different pairs for one observer serially', async () => {
    let now = 1000000, peak = 0, decisions = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, summaryIntervalMs: 1000 } });
    const agents: Agent[] = [];
    for (let index = 0; index < 5; index++) agents.push(await world.saveAgent({ ...input, name: `Agent ${index}`, timingOverrides }));
    const candidates = agents.slice(0, 4).map((agent, index) => ({ observerId: agent.id, targetAgentId: agents[(index + 1) % agents.length].id }));
    candidates.push({ observerId: agents[0].id, targetAgentId: agents[2].id });
    vi.spyOn(world, 'summaryCandidates').mockImplementation(async () => [...candidates]);
    const inFlight = new Map<string, ReturnType<typeof deferred>>(), pairs: string[] = [];
    const scheduler = new Scheduler(world, async agent => {
      expect(inFlight.has(agent.id)).toBe(false); decisions += 1;
      return { reflectionProcessed: true, action: { type: 'wait' } };
    }, () => {}, { concurrency: 4, timeoutMs: 5000, retries: 0, backoffMs: 1 }, async (agent, targetId) => {
      expect(inFlight.has(agent.id)).toBe(false);
      const pending = deferred(); inFlight.set(agent.id, pending); pairs.push(`${agent.id}/${targetId}`);
      peak = Math.max(peak, inFlight.size);
      await pending.promise; inFlight.delete(agent.id);
      candidates.splice(candidates.findIndex(pair => pair.observerId === agent.id && pair.targetAgentId === targetId), 1);
    });
    schedulers.push(scheduler);
    await scheduler.start(); await scheduler.tick(); await finished(scheduler);
    await scheduler.tick(); await finished(scheduler);
    expect(decisions).toBe(5);
    now = 1001000; await scheduler.tick();
    await vi.waitFor(() => expect(inFlight.size).toBe(4));
    now = 1002000; await scheduler.tick(); expect(decisions).toBe(5);
    inFlight.get(agents[0].id)!.resolve();
    await vi.waitFor(() => expect(inFlight.has(agents[0].id)).toBe(false));
    await scheduler.tick();
    await vi.waitFor(() => expect(pairs).toHaveLength(5));
    expect(pairs.filter(pair => pair.startsWith(agents[0].id + '/'))).toHaveLength(2);
    expect(peak).toBe(4);
    for (const pending of inFlight.values()) pending.resolve();
    await finished(scheduler);
    await scheduler.tick(); await finished(scheduler);
    expect(decisions).toBeGreaterThan(5);
  });

  it('freezes pending summary deadlines on Pause and resets them on Stop without catch-up requests', async () => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, summaryIntervalMs: 1000 } });
    const observer = await world.saveAgent({ ...input, timingOverrides: { ...timingOverrides, reflectionIntervalMs: 2000000 } });
    vi.spyOn(world, 'summaryCandidates').mockResolvedValue([{ observerId: observer.id, targetAgentId: 'target' }]);
    const summary = vi.fn(async () => {});
    const scheduler = new Scheduler(world, async () => ({ reflectionProcessed: true, action: { type: 'wait' } }), () => {},
      { concurrency: 4, timeoutMs: 5000, retries: 0, backoffMs: 1 }, summary);
    schedulers.push(scheduler);
    await scheduler.start(); await scheduler.tick(); await finished(scheduler);
    expect(scheduler.snapshot().agents[0].nextRelationshipSummaryAt).toBe(1001000);
    now = 1000400; scheduler.pause();
    now = 1010400; await scheduler.start();
    expect(scheduler.snapshot().agents[0].nextRelationshipSummaryAt).toBe(1011000);
    now = 1010999; await scheduler.tick(); expect(summary).not.toHaveBeenCalled();
    await scheduler.stop(); now = 2000000;
    await scheduler.start(); await scheduler.tick(); await finished(scheduler);
    expect(summary).not.toHaveBeenCalled();
    expect(scheduler.snapshot().agents[0].nextRelationshipSummaryAt).toBe(2001000);
    now = 2001000; await scheduler.tick(); await finished(scheduler);
    expect(summary).toHaveBeenCalledOnce();
  });
});
