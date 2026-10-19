import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World } from '@terrarium/persistence';
import { defaultSettings, type Agent, type AgentInput, type DecisionOpportunity } from '@terrarium/shared';
import { createChatGptPayload, type LmCompletionRequest, type LmProvider } from '@terrarium/lm-providers';
import { decisionJsonSchema, performDecision, previewDecision } from '../src/reflection.js';

let db: ReturnType<typeof createDb>, world: World;
const input: AgentInput = {
  name: 'Observer', instructions: 'Observe the room.', roomId: 'room-1', provider: 'chatgpt', model: 'fake',
  enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
};
const opportunity: DecisionOpportunity = { reflection: true, speech: false, emote: false, requestedAt: 1000, reason: 'cadence' };
const quiet = { reflection: null, speechPlan: null, requestEmote: false, engagement: null, action: { type: 'wait' } };
const providerFor = (value: unknown): LmProvider => ({ name: 'fake', complete: async () => ({ content: JSON.stringify(value) }) });
const decide = (agent: Agent, value: unknown, offered = opportunity) => performDecision(world, agent, providerFor(value),
  new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, offered);

beforeEach(async () => {
  db = createDb(':memory:');
  await ensureTables(db);
  world = new World(db);
});
afterEach(async () => { await db.destroy(); vi.restoreAllMocks(); });

describe('private reflection decisions', () => {
  it('allows genuine inactivity while observations and elapsed energy continue', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await world.saveRoom({ id: 'room-1', name: 'Kitchen', description: '', isFoodSource: true });
    await world.saveSettings({ ...defaultSettings, energy: { ...defaultSettings.energy, enabled: true, initial: 50 } });
    const agent = await world.saveAgent(input), notify = vi.fn();
    const witnessed = await world.speak('room-1', 'A quiet room is still observable.');
    await world.syncEnergy(now, true);
    now += 60000;
    const result = await performDecision(world, agent, providerFor({ ...quiet,
      reflection: { reaction: 'Content to listen.', intention: null } }), new AbortController().signal,
      () => true, notify, async () => {}, () => {}, undefined, opportunity);
    expect(result).toMatchObject({ reflectionProcessed: true, speechPlan: null, requestEmote: false, action: { type: 'wait' } });
    expect(notify).not.toHaveBeenCalled();
    expect(await world.memory(agent.id)).toEqual([witnessed]);
    expect((await world.history({ roomId: agent.roomId })).messages).toEqual([witnessed]);
    expect((await world.agent(agent.id))?.energy).toBe(45);
    expect(await world.reflection(agent.id)).toMatchObject({ reaction: 'Content to listen.', intention: null, reflectedAt: expect.any(String) });
  });

  it('exposes only the observer’s latest private state alongside witnessed context', async () => {
    const agent = await world.saveAgent(input);
    const local = await world.saveAgent({ ...input, name: 'Local companion', instructions: 'LOCAL PROFILE SECRET' });
    const remote = await world.saveAgent({ ...input, name: 'REMOTE PERSON', roomId: 'room-2' });
    await world.saveReflection(agent.id, agent.revision, { reaction: 'OWN REACTION', intention: 'OWN INTENTION' }, () => true);
    await world.saveReflection(local.id, local.revision, { reaction: 'LOCAL REACTION SECRET', intention: 'LOCAL INTENTION SECRET' }, () => true);
    await world.saveReflection(remote.id, remote.revision, { reaction: 'REMOTE REACTION SECRET' }, () => true);
    await world.speak('room-2', 'REMOTE CONVERSATION SECRET');
    await world.speak('room-1', 'A witnessed contribution.');
    const preview = await previewDecision(world, agent, opportunity), payload = JSON.stringify(preview.payload);
    expect(payload).toContain('OWN REACTION');
    expect(payload).toContain('OWN INTENTION');
    expect(payload).toContain('Local companion');
    expect(payload).toContain('A witnessed contribution.');
    for (const secret of ['LOCAL PROFILE SECRET', 'LOCAL REACTION SECRET', 'LOCAL INTENTION SECRET', 'REMOTE REACTION SECRET', 'REMOTE CONVERSATION SECRET', 'REMOTE PERSON'])
      expect(payload).not.toContain(secret);
    expect(await world.diagnostics()).toMatchObject({ records: [] });
  });

  it('leaves unchanged reflection private and preserves its timestamp', async () => {
    const agent = await world.saveAgent(input);
    await world.saveReflection(agent.id, agent.revision, { reaction: 'Still interested.', intention: 'Listen.' }, () => true);
    const previous = await world.reflection(agent.id);
    expect(await decide(agent, quiet)).toMatchObject({ reflectionProcessed: true, speechPlan: null });
    expect(await world.reflection(agent.id)).toEqual(previous);
    await decide(agent, { ...quiet, reflection: { reaction: null, intention: null } });
    expect(await world.reflection(agent.id)).toMatchObject({ reaction: null, intention: null });
  });

  it('keeps movement and eating available independently of speech and emote eligibility', async () => {
    await world.saveRoom({ id: 'room-2', name: 'Kitchen', description: '', isFoodSource: true });
    await world.saveSettings({ ...defaultSettings, energy: { ...defaultSettings.energy, enabled: true, initial: 10 } });
    const agent = await world.saveAgent(input);
    await decide(agent, { ...quiet, reflection: { reaction: 'Hungry.', intention: 'Find food.' }, action: { type: 'move', roomId: 'room-2' } });
    const moved = (await world.agent(agent.id))!;
    expect(moved.roomId).toBe('room-2');
    await decide(moved, { ...quiet, reflection: { reaction: 'Ready to eat.', intention: null }, action: { type: 'eat' } });
    expect((await world.agent(agent.id))?.energy).toBe(100);
    expect((await world.memory(agent.id)).map(message => message.type)).toEqual(['departure', 'arrival']);
  });

  it.each(['speak', 'emote'] as const)('rejects ineligible %s without partially saving reflection', async type => {
    const agent = await world.saveAgent(input);
    await expect(decide(agent, { ...quiet, reflection: { reaction: 'Must not be saved.', intention: null },
      action: { type, message: 'Not eligible.' } })).rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.reflection(agent.id)).reaction).toBeNull();
    expect(await world.memory(agent.id)).toEqual([]);
  });

  it('rolls back private state when the same decision contains an invalid world action', async () => {
    const agent = await world.saveAgent(input);
    await expect(decide(agent, { ...quiet, reflection: { reaction: 'Not committed.', intention: 'Eat.' }, action: { type: 'eat' } }))
      .rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.reflection(agent.id)).reflectedAt).toBeNull();
    expect(await world.agent(agent.id)).toEqual(agent);
  });

  it('captures the exact schema, request, response and reflection without publishing diagnostic content', async () => {
    const agent = await world.saveAgent(input);
    await world.saveSettings({ ...defaultSettings, prompts: { ...defaultSettings.prompts, reflection: 'CUSTOM REFLECTION PROMPT' } });
    const preview = await previewDecision(world, agent, opportunity);
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    const response = { ...quiet, reflection: { reaction: 'Interested.', intention: 'Consider a question.' },
      speechPlan: { delayMs: 35000, replyToId: null, targetAgentId: null } };
    const result = await performDecision(world, agent, { name: 'fake', complete: async request => {
      expect(request.responseFormat?.schema).toEqual(decisionJsonSchema(opportunity, true));
      expect(request.messages[0].content).toContain('CUSTOM REFLECTION PROMPT');
      await request.onRequest?.(createChatGptPayload(request));
      return { content: JSON.stringify(response), responseId: 'response-private', requestId: 'request-private' };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, attempt, opportunity);
    expect(result.speechPlan?.delayMs).toBe(35000);
    const record = await world.diagnostic(attempt);
    expect(record.outcome).toBe('applied');
    expect(record.details).toMatchObject({ payload: preview.payload, output: JSON.stringify(response), proposal: response,
      requestId: 'request-private', responseId: 'response-private', rawRequestedDelay: 35000, opportunities: opportunity });
    const next = JSON.stringify((await previewDecision(world, agent, opportunity)).payload);
    expect(next).toContain('Consider a question.');
    expect(next).not.toContain('request-private');
    expect(next).not.toContain('response-private');
    expect(await world.memory(agent.id)).toEqual([]);
  });

  it('permits an eligible emote or silence without overwriting private state on a nonreflection opportunity', async () => {
    const agent = await world.saveAgent(input);
    await world.saveReflection(agent.id, agent.revision, { reaction: 'Saved private reaction.' }, () => true);
    const offered = { ...opportunity, reflection: false, emote: true };
    const result = await decide(agent, { action: { type: 'emote', message: 'Observer folds their arms.' }, intention: 'Diagnostic only.' }, offered);
    expect(result).toEqual({ reflectionProcessed: false, action: { type: 'emote', message: 'Observer folds their arms.' } });
    expect((await world.reflection(agent.id)).reaction).toBe('Saved private reaction.');
    expect((await world.reflection(agent.id)).intention).toBeNull();
    await decide(agent, { action: { type: 'wait' }, intention: null }, offered);
    expect((await world.memory(agent.id)).map(message => message.type)).toEqual(['emote']);
  });

  it.each(['before', 'during'] as const)('cancels delayed speech when its partner leaves %s the model request', async when => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Any thoughts?' }, () => true)).message!;
    const offered: DecisionOpportunity = { ...opportunity, reflection: false, speech: true, reason: 'scheduled-speech',
      speechPlan: { dueAt: 1000, requestedAt: 0, replyToId: source.id, targetAgentId: companion.id } };
    const leave = () => world.applyAction(companion.id, companion.revision, { type: 'move', roomId: 'room-2' }, () => true);
    if (when === 'before') await leave();
    const complete = vi.fn(async () => {
      if (when === 'during') await leave();
      return { content: JSON.stringify({ action: { type: 'speak', message: 'This reply is now stale.', replyToId: source.id } }) };
    });
    await expect(performDecision(world, agent, { name: 'fake', complete }, new AbortController().signal,
      () => true, () => {}, async () => {}, () => {}, undefined, offered)).rejects.toMatchObject({ category: 'stale' });
    expect(complete).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect((await world.memory(agent.id)).some(message => message.content === 'This reply is now stale.')).toBe(false);
  });

  it('generates delayed words against fresh observations and preserves validated reply linkage', async () => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Any thoughts?' }, () => true)).message!;
    const planned = await decide(agent, { ...quiet, speechPlan: { delayMs: 20000, replyToId: source.id, targetAgentId: null },
      engagement: { rootMessageId: source.id, targetAgentId: companion.id } });
    expect(planned.speechPlan?.targetAgentId).toBe(companion.id);
    expect((await world.memory(agent.id)).filter(message => message.type === 'speak')).toHaveLength(1);
    await world.speak('room-1', 'Fresh information after the intention was scheduled.');
    const offered: DecisionOpportunity = { ...opportunity, reflection: false, speech: true, reason: 'scheduled-speech',
      speechPlan: { dueAt: 21000, requestedAt: 1000, replyToId: source.id, targetAgentId: companion.id } };
    await performDecision(world, agent, { name: 'fake', complete: async (request: LmCompletionRequest) => {
      expect(request.messages[1].content).toContain('Fresh information after the intention was scheduled.');
      return { content: JSON.stringify({ action: { type: 'speak', message: 'Now I can respond to the new information.', replyToId: source.id } }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, offered);
    const response = (await world.memory(agent.id)).at(-1)!;
    expect(response).toMatchObject({ type: 'speak', replyToId: source.id, conversationId: source.id });
  });

  it('rejects evidence that arrived after the actual request snapshot', async () => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    await expect(performDecision(world, agent, { name: 'fake', complete: async () => {
      const late = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Late source.' }, () => true)).message!;
      return { content: JSON.stringify({ ...quiet, speechPlan: { delayMs: 20000, replyToId: late.id, targetAgentId: companion.id } }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, opportunity))
      .rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.reflection(agent.id)).reflectedAt).toBeNull();
  });

  it('records notification failure after the private state and action have committed', async () => {
    const agent = await world.saveAgent(input), applied = vi.fn();
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    await expect(performDecision(world, agent, providerFor({ ...quiet, reflection: { reaction: 'Moving on.', intention: null },
      action: { type: 'move', roomId: 'room-2' } }), new AbortController().signal, () => true,
    () => { throw new Error('Notification failed'); }, async () => {}, applied, attempt, opportunity))
      .rejects.toMatchObject({ category: 'applied-notification-failure' });
    expect(applied).toHaveBeenCalledOnce();
    expect((await world.agent(agent.id))?.roomId).toBe('room-2');
    expect((await world.reflection(agent.id)).reaction).toBe('Moving on.');
    expect((await world.diagnostic(attempt)).outcome).toBe('applied-notification-failure');
  });
});
