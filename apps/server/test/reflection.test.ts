import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World } from '@terrarium/persistence';
import { defaultSettings, type Agent, type AgentInput, type DecisionOpportunity } from '@terrarium/shared';
import { createChatGptPayload, type LmCompletionRequest, type LmProvider } from '@terrarium/lm-providers';
import { decisionJsonSchema, performDecision, previewDecision } from '../src/reflection.js';
import { Scheduler } from '../src/scheduler.js';

let db: ReturnType<typeof createDb>, world: World;
const input: AgentInput = {
  name: 'Observer', instructions: 'Observe the room.', roomId: 'room-1', provider: 'chatgpt', model: 'fake',
  enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
};
const opportunity: DecisionOpportunity = { reflection: true, speech: false, emote: false, requestedAt: 1000, reason: 'cadence' };
const quiet = { reflection: null, speechPlan: null, requestEmote: false, engagement: null, appraisals: [], action: { type: 'wait' } };
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
  it.each([true, false])('uses exact custom destinations in preview and actual request when reflection=%s', async reflection => {
    await db.insertInto('rooms').values({ id: 'news-room', name: 'News Room', description: 'A shared display.', is_food_source: 0 }).execute();
    const agent = await world.saveAgent(input), offered = { ...opportunity, reflection };
    const preview = await previewDecision(world, agent, offered);
    await performDecision(world, agent, { name: 'fake', complete: async request => {
      expect(createChatGptPayload(request)).toEqual(preview.payload);
      const schema = request.responseFormat!.schema as ReturnType<typeof decisionJsonSchema>;
      expect(schema.properties.action.anyOf.find(option => option.properties.type.enum[0] === 'move')?.properties.roomId)
        .toEqual({ type: 'string', minLength: 1, enum: preview.context.directory.map(room => room.id) });
      const move = schema.properties.action.anyOf.find(option => option.properties.type.enum[0] === 'move')!;
      expect(move.required).toContain('reason');
      expect(move.properties.reason).toMatchObject({ type: 'string', minLength: 1, maxLength: 240 });
      return { content: JSON.stringify({ ...(reflection ? quiet : { intention: null }), action: { type: 'move', roomId: 'news-room', reason: 'Read the news display.' } }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, offered);
    expect((await world.agent(agent.id))?.roomId).toBe('news-room');
  });

  it('applies a Forum move once when its optional appraisal mistypes a witnessed source ID', async () => {
    await db.insertInto('rooms').values({ id: 'forum', name: 'Forum', description: 'Exchange opinions.', is_food_source: 0 }).execute();
    const agent = await world.saveAgent({ ...input, name: 'Quinn' }), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'A witnessed contribution.' }, () => true)).message!;
    await world.saveAgent({ ...input, id: companion.id, name: companion.name, enabled: false });
    const mistypedId = source.id.slice(0, -3) + source.id.slice(-2);
    const reason = 'Find a fresh discussion in the Forum.';
    const response = { ...quiet, action: { type: 'move', roomId: 'forum', reason },
      appraisals: [{ sourceId: mistypedId, reaction: 'like', reason: 'An interesting contribution.' }] };
    const complete = vi.fn(async (request: LmCompletionRequest) => {
      expect(request.messages[1].content).toContain(source.id);
      await request.onRequest?.(createChatGptPayload(request));
      return { content: JSON.stringify(response) };
    });
    const notify = vi.fn();
    const scheduler = new Scheduler(world, (resident, signal, current, applied, attempt, offered) =>
      performDecision(world, resident, { name: 'fake', complete }, signal, current, notify, async () => {}, applied, attempt, offered!),
    () => {}, { concurrency: 4, timeoutMs: 5000, retries: 2, backoffMs: 1 });
    try {
      await scheduler.start(); await scheduler.tick();
      await vi.waitFor(() => expect(scheduler.snapshot().agents.some(item => item.state === 'running')).toBe(false));
      expect(complete).toHaveBeenCalledOnce();
      const latest = (await world.agent(agent.id))!;
      expect(latest).toMatchObject({ roomId: 'forum', revision: agent.revision + 1 });
      const attempts = (await world.diagnostics({ agentId: agent.id }, true)).records.filter(record => record.attempt > 0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: 'applied', action: 'move', details: { moveReason: reason, proposal: response,
        sourceRoomId: agent.roomId, destinationRoomId: 'forum', moved: true, acceptedAppraisals: [],
        optionalValidationErrors: [{ field: 'appraisals', index: 0, sourceId: mistypedId, error: expect.any(String) }] } });
      expect((await world.appraisals()).appraisals).toEqual([]);
      expect(notify.mock.calls.map(([event]) => event.type)).toEqual(['departure', 'arrival']);
      for (const value of [notify.mock.calls, await world.exportConversations(), (await previewDecision(world, latest, opportunity)).payload])
        expect(JSON.stringify(value)).not.toContain(reason);
    } finally { await scheduler.close(); }
  });

  it.each(['move', 'wait'] as const)('handles a disabled newly proposed engagement independently only for %s', async type => {
    await world.saveSettings({ ...defaultSettings, scheduling: { ...defaultSettings.scheduling, engagementEnabled: false } });
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'An exchange.' }, () => true)).message!;
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    const response = { ...quiet, engagement: { rootMessageId: source.id, targetAgentId: companion.id },
      action: type === 'move' ? { type, roomId: 'room-2', reason: 'Choose a quieter setting.' } : { type } };
    const result = performDecision(world, agent, providerFor(response), new AbortController().signal,
      () => true, () => {}, async () => {}, () => {}, attempt, opportunity);
    if (type === 'move') {
      await expect(result).resolves.toMatchObject({ action: { type: 'move', roomId: 'room-2' }, engagement: null });
      expect((await world.diagnostic(attempt)).details?.optionalValidationErrors)
        .toEqual([{ field: 'engagement', sourceId: source.id, error: expect.any(String) }]);
      expect((await world.agent(agent.id))?.roomId).toBe('room-2');
    } else {
      await expect(result).rejects.toMatchObject({ category: 'world-validation' });
      expect((await world.agent(agent.id))?.roomId).toBe(agent.roomId);
    }
    expect((await world.reflection(agent.id)).engagement).toBeNull();
  });

  it.each(['invalid-destination', 'malformed-appraisal'] as const)('retains a valid move purpose when the decision fails for %s', async failure => {
    const agent = await world.saveAgent(input), notify = vi.fn(), reason = 'Seek a new conversation.';
    const response = { ...quiet, action: { type: 'move', roomId: failure === 'invalid-destination' ? 'missing-room' : 'room-2', reason },
      appraisals: [{ sourceId: 'missing-source', reaction: failure === 'malformed-appraisal' ? 'unsupported' : 'like', reason: 'A reaction.' }] };
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    await expect(performDecision(world, agent, providerFor(response), new AbortController().signal,
      () => true, notify, async () => {}, () => {}, attempt, opportunity))
      .rejects.toMatchObject({ category: failure === 'malformed-appraisal' ? 'schema' : 'world-validation' });
    expect((await world.diagnostic(attempt))).toMatchObject({ action: 'move', details: { moveReason: reason, proposal: response } });
    if (failure === 'invalid-destination') expect((await world.diagnostic(attempt)).details?.error).toContain('Destination room does not exist');
    expect((await world.diagnostic(attempt)).details).not.toHaveProperty('destinationRoomId');
    expect(await world.agent(agent.id)).toEqual(agent);
    expect((await world.appraisals()).appraisals).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('still cancels a move when its active engagement trigger becomes stale', async () => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'A current exchange.' }, () => true)).message!;
    await world.saveReflection(agent.id, agent.revision, { engagement: { roomId: agent.roomId, rootMessageId: source.id, targetAgentId: companion.id } }, () => true);
    const reason = 'Find another setting.', notify = vi.fn();
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now()), 1, agent);
    await expect(performDecision(world, agent, { name: 'fake', complete: async () => {
      await world.applyAction(companion.id, companion.revision, { type: 'move', roomId: 'room-2' }, () => true);
      return { content: JSON.stringify({ action: { type: 'move', roomId: 'room-3', reason } }) };
    } }, new AbortController().signal, () => true, notify, async () => {}, () => {}, attempt,
    { ...opportunity, reflection: false, speech: true, reason: 'engagement', engagementTrigger: {
      rootMessageId: source.id, targetAgentId: companion.id, replyToId: source.id, sourceAgentId: companion.id, requestedAt: 1000,
    } })).rejects.toMatchObject({ category: 'stale' });
    expect((await world.diagnostic(attempt))).toMatchObject({ outcome: 'stale', action: 'move', details: { moveReason: reason } });
    expect((await world.agent(agent.id))?.roomId).toBe(agent.roomId);
    expect(notify).not.toHaveBeenCalled();
  });
  it.each(['reflection', 'speech', 'emote'] as const)('uses the resident reasoning strength in %s previews and actual requests', async operation => {
    const agent = await world.saveAgent({ ...input, reasoningEffort: 'xhigh' });
    const offered = { ...opportunity, reflection: operation === 'reflection', speech: operation === 'speech', emote: operation === 'emote' };
    const preview = await previewDecision(world, agent, offered);
    expect(preview.payload).toMatchObject({ reasoning: { effort: 'xhigh' } });
    const complete = vi.fn(async (request: LmCompletionRequest) => {
      expect(request.reasoningEffort).toBe('xhigh');
      expect(createChatGptPayload(request)).toEqual(preview.payload);
      return { content: JSON.stringify(operation === 'reflection' ? quiet : { action: { type: 'wait' }, intention: null }) };
    });
    await performDecision(world, agent, { name: 'fake', complete }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, offered);
    expect(complete).toHaveBeenCalledOnce();
  });
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
      expect(request.responseFormat?.schema).toEqual(decisionJsonSchema(opportunity, true, 2, false, false, preview.context.directory.map(room => room.id)));
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

  it.each(['wait', 'move'] as const)('rejects an unwitnessed speech plan even when the immediate action is %s', async type => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    await expect(performDecision(world, agent, { name: 'fake', complete: async () => {
      const late = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Late source.' }, () => true)).message!;
      return { content: JSON.stringify({ ...quiet, speechPlan: { delayMs: 20000, replyToId: late.id, targetAgentId: companion.id },
        action: type === 'move' ? { type, roomId: 'room-2', reason: 'Find another setting.' } : { type } }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, opportunity))
      .rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.reflection(agent.id)).reflectedAt).toBeNull();
    expect((await world.agent(agent.id))?.roomId).toBe(agent.roomId);
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

  it.each(['speak', 'wait'] as const)('allows an engagement %s immediately without another reflection or speech plan', async type => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'A fresh question.' }, () => true)).message!;
    await world.saveReflection(agent.id, agent.revision, { reaction: 'Interested.', intention: 'Hear them out.',
      engagement: { roomId: agent.roomId, rootMessageId: source.id, targetAgentId: companion.id } }, () => true);
    const before = await world.reflection(agent.id), offered: DecisionOpportunity = { ...opportunity, reflection: false, speech: true, reason: 'engagement',
      engagementTrigger: { rootMessageId: source.id, targetAgentId: companion.id, replyToId: source.id, sourceAgentId: companion.id, requestedAt: 1000 } };
    const preview = await previewDecision(world, agent, offered);
    const action = type === 'speak' ? { type, message: 'Yes, that interests me.' } : { type };
    const result = await performDecision(world, agent, { name: 'fake', complete: async request => {
      expect(request.responseFormat?.schema).toEqual(decisionJsonSchema(offered, true, 2, false, false, preview.context.directory.map(room => room.id)));
      expect(request.messages[1].content).toContain('A fresh question.');
      expect(createChatGptPayload(request)).toEqual(preview.payload);
      return { content: JSON.stringify({ action }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, offered);
    expect(result.reflectionProcessed).toBe(false); expect(result.speechPlan).toBeUndefined();
    expect(await world.reflection(agent.id)).toMatchObject({ reaction: before.reaction, intention: before.intention, reflectedAt: before.reflectedAt, engagement: before.engagement });
    const memory = await world.memory(agent.id);
    if (type === 'speak') expect(memory.at(-1)).toMatchObject({ content: action.message, replyToId: source.id, conversationId: source.id });
    else expect(memory).toEqual([source]);
  });

  it.each(['partner-departure', 'partner-disable', 'disengage', 'feature-disable', 'source-departure'] as const)
    ('cancels an engagement response when %s happens during generation', async change => {
      const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' }),
        participant = await world.saveAgent({ ...input, name: 'Participant' });
      const root = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Start an exchange.' }, () => true)).message!;
      const source = (await world.applyAction(participant.id, participant.revision, { type: 'speak', message: 'Another contribution.', replyToId: root.id }, () => true)).message!;
      await world.saveReflection(agent.id, agent.revision, { engagement: { roomId: agent.roomId, rootMessageId: root.id, targetAgentId: companion.id } }, () => true);
      const offered: DecisionOpportunity = { ...opportunity, reflection: false, speech: true, reason: 'engagement',
        engagementTrigger: { rootMessageId: root.id, targetAgentId: companion.id, replyToId: source.id, sourceAgentId: participant.id, requestedAt: 1000 } };
      await expect(performDecision(world, agent, { name: 'fake', complete: async () => {
        if (change === 'partner-departure' || change === 'source-departure') {
          const actor = change === 'partner-departure' ? companion : participant;
          await world.applyAction(actor.id, actor.revision, { type: 'move', roomId: 'room-2' }, () => true);
        } else if (change === 'partner-disable') await world.saveAgent({ ...input, id: companion.id, name: companion.name, enabled: false });
        else if (change === 'disengage') await world.saveReflection(agent.id, agent.revision, { engagement: null }, () => true);
        else await world.saveSettings({ ...defaultSettings, scheduling: { ...defaultSettings.scheduling, engagementEnabled: false } });
        return { content: '{"action":{"type":"speak","message":"A stale reply."}}' };
      } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined, offered)).rejects.toMatchObject({ category: 'stale' });
      expect((await world.memory(agent.id)).some(message => message.content === 'A stale reply.')).toBe(false);
    });

  it('does not request an engagement response when its source is outside the fresh observation snapshot', async () => {
    const agent = await world.saveAgent({ ...input, contextMessageLimit: 1 }), companion = await world.saveAgent({ ...input, name: 'Companion' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Earlier question.' }, () => true)).message!;
    await world.saveReflection(agent.id, agent.revision, { engagement: { roomId: agent.roomId, rootMessageId: source.id, targetAgentId: companion.id } }, () => true);
    await world.speak(agent.roomId, 'Newer observation.');
    const complete = vi.fn(async () => ({ content: '{"action":{"type":"wait"}}' }));
    await expect(performDecision(world, agent, { name: 'fake', complete }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined,
      { ...opportunity, reflection: false, speech: true, reason: 'engagement', engagementTrigger: {
        rootMessageId: source.id, targetAgentId: companion.id, replyToId: source.id, sourceAgentId: companion.id, requestedAt: 1000,
      } })).rejects.toMatchObject({ category: 'stale' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps an explicit scheduled reply target when a different subscribed exchange is also due', async () => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' }),
      other = await world.saveAgent({ ...input, name: 'Other' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Subscribed exchange.' }, () => true)).message!;
    const planned = (await world.applyAction(other.id, other.revision, { type: 'speak', message: 'Planned reply thread.' }, () => true)).message!;
    await world.saveReflection(agent.id, agent.revision, { engagement: { roomId: agent.roomId, rootMessageId: source.id, targetAgentId: companion.id } }, () => true);
    await performDecision(world, agent, providerFor({ action: { type: 'speak', message: 'My scheduled answer.' } }), new AbortController().signal,
      () => true, () => {}, async () => {}, () => {}, undefined, { ...opportunity, reflection: false, speech: true, reason: 'engagement',
        speechPlan: { dueAt: 1000, requestedAt: 0, replyToId: planned.id, targetAgentId: other.id },
        engagementTrigger: { rootMessageId: source.id, targetAgentId: companion.id, replyToId: source.id, sourceAgentId: companion.id, requestedAt: 1000 } });
    expect((await world.memory(agent.id)).at(-1)).toMatchObject({ content: 'My scheduled answer.', replyToId: planned.id, conversationId: planned.id });
  });

  it('cancels the entire coalesced response when its engagement becomes stale during generation', async () => {
    const agent = await world.saveAgent(input), companion = await world.saveAgent({ ...input, name: 'Companion' }),
      other = await world.saveAgent({ ...input, name: 'Other' });
    const source = (await world.applyAction(companion.id, companion.revision, { type: 'speak', message: 'Subscribed exchange.' }, () => true)).message!;
    const planned = (await world.applyAction(other.id, other.revision, { type: 'speak', message: 'Separate planned thread.' }, () => true)).message!;
    await world.saveReflection(agent.id, agent.revision, { engagement: { roomId: agent.roomId, rootMessageId: source.id, targetAgentId: companion.id } }, () => true);
    await expect(performDecision(world, agent, { name: 'fake', complete: async () => {
      await world.applyAction(companion.id, companion.revision, { type: 'move', roomId: 'room-2' }, () => true);
      return { content: JSON.stringify({ action: { type: 'speak', message: 'Do not publish this mixed stale response.', replyToId: planned.id } }) };
    } }, new AbortController().signal, () => true, () => {}, async () => {}, () => {}, undefined,
    { ...opportunity, reflection: false, speech: true, reason: 'engagement',
      speechPlan: { dueAt: 1000, requestedAt: 0, replyToId: planned.id, targetAgentId: other.id },
      engagementTrigger: { rootMessageId: source.id, targetAgentId: companion.id, replyToId: source.id, sourceAgentId: companion.id, requestedAt: 1000 } }))
      .rejects.toMatchObject({ category: 'stale' });
    expect((await world.memory(agent.id)).some(message => message.content === 'Do not publish this mixed stale response.')).toBe(false);
  });

  it.each([25, 97, 99, 100])('exposes and enforces low-energy eating consistently at energy %s', async energy => {
    await world.saveRoom({ id: 'room-1', name: 'Kitchen', description: '', isFoodSource: true });
    await world.saveSettings({ ...defaultSettings, energy: { ...defaultSettings.energy, enabled: true, initial: energy } });
    const agent = await world.saveAgent(input), before = await world.reflection(agent.id), preview = await previewDecision(world, agent, opportunity);
    const schema = (preview.payload.text as { format: { schema: { properties: { action: unknown } } } }).format.schema.properties.action;
    expect(JSON.stringify(schema).includes('"eat"')).toBe(energy <= 25);
    const attempt = decide(agent, { ...quiet, reflection: { reaction: 'Eat then leave.', intention: null }, action: { type: 'eat' } });
    if (energy <= 25) { await attempt; expect((await world.agent(agent.id))?.energy).toBe(100); }
    else { await expect(attempt).rejects.toMatchObject({ category: 'world-validation' }); expect(await world.reflection(agent.id)).toEqual(before); }
  });
});
