import { describe, expect, it } from 'vitest';
import {
  actionSchema,
  messageInputSchema,
  agentInputSchema,
  historyInputSchema,
  configurationSchema,
  clearHistorySchema,
  deleteAgentSchema,
  defaultSettings, settingsSchema, actionResponseSchema,
  conversationMessageSchema, actionJsonSchema,
  resolveScheduling, upgradeReflectionSettings, canEat,
} from '../src/index.js';

describe('runtime contracts', () => {
  it('bounds declared movement reasons while preserving legacy actions', () => {
    expect(actionSchema.parse({ type: 'move', roomId: 'forum', reason: '  Find a lively discussion.  ' }))
      .toEqual({ type: 'move', roomId: 'forum', reason: 'Find a lively discussion.' });
    expect(actionSchema.parse({ type: 'move', roomId: 'forum' })).toEqual({ type: 'move', roomId: 'forum' });
    expect(actionSchema.safeParse({ type: 'move', roomId: 'forum', reason: 'x'.repeat(240) }).success).toBe(true);
    for (const reason of ['', '  ', null, 1, 'x'.repeat(241)])
      expect(actionSchema.safeParse({ type: 'move', roomId: 'forum', reason }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'wait', reason: 'Keep listening.' }).success).toBe(false);
    const move = actionJsonSchema(true, true, false, ['forum']).properties.action.anyOf.find(option => option.properties.type.enum[0] === 'move')!;
    expect(move.required).toContain('reason');
    expect(move.properties.reason).toEqual({ type: 'string', minLength: 1, maxLength: 240, pattern: '\\S' });
  });
  it('restricts movement to the supplied room IDs without changing other requests', () => {
    const destinations = (ids?: readonly string[]) => actionJsonSchema(true, false, false, ids).properties.action.anyOf
      .find(option => option.properties.type.enum[0] === 'move')?.properties.roomId;
    expect(destinations(['news-room', 'room-4'])).toEqual({ type: 'string', minLength: 1, enum: ['news-room', 'room-4'] });
    expect(destinations(['forum'])).toEqual({ type: 'string', minLength: 1, enum: ['forum'] });
    expect(destinations()).toEqual({ type: 'string', minLength: 1 });
    expect(destinations([])).toBeUndefined();
  });
  it('validates explicit retention policies and preserves manual retention in legacy imports', () => {
    expect(defaultSettings.diagnostics).toEqual({ retention: 'rolling-time', maxAgeMinutes: 30, maxPayloadMiB: 256 });
    const settings = { ...defaultSettings, diagnostics: { retention: 'manual', maxPayloadMiB: 128 },
      prompts: { ...defaultSettings.prompts, framing: 'Keep my authored prompt.' } };
    for (const version of [2, 3, 4, 5, 6, 7]) {
      const imported = configurationSchema.parse({ format: 'terrarium-config', version, rooms: [], agents: [], settings });
      expect(imported.settings).toMatchObject({ diagnostics: { retention: 'manual', maxPayloadMiB: 128, maxAgeMinutes: 30 },
        prompts: { framing: 'Keep my authored prompt.' } });
    }
    expect(configurationSchema.safeParse({ format: 'terrarium-config', version: 8, rooms: [], agents: [], settings }).success).toBe(false);
    for (const retention of ['manual', 'rolling-time', 'rolling-size']) {
      expect(settingsSchema.parse({ ...defaultSettings, diagnostics: { retention, maxAgeMinutes: 45, maxPayloadMiB: 512 } }).diagnostics.retention).toBe(retention);
    }
    for (const diagnostics of [{ ...defaultSettings.diagnostics, retention: 'unknown' }, { ...defaultSettings.diagnostics, maxAgeMinutes: 0 },
      { ...defaultSettings.diagnostics, maxAgeMinutes: 1.5 }, { ...defaultSettings.diagnostics, maxPayloadMiB: 31 }])
      expect(settingsSchema.safeParse({ ...defaultSettings, diagnostics }).success).toBe(false);
  });
  it('requires explicit nullable reasoning choices in version 9 while accepting older files', () => {
    const settings = { ...defaultSettings, news: { ...defaultSettings.news, reasoningEffort: 'xhigh' } };
    const file = { format: 'terrarium-config', version: 9, rooms: [], agents: [], settings };
    expect(configurationSchema.parse(file).settings?.news.reasoningEffort).toBe('xhigh');
    expect(configurationSchema.parse({ ...file, settings: defaultSettings }).settings?.news.reasoningEffort).toBeNull();
    const { reasoningEffort, ...news } = settings.news;
    expect(configurationSchema.safeParse({ ...file, settings: { ...settings, news } }).success).toBe(false);
    for (const version of [7, 8])
      expect(configurationSchema.safeParse({ ...file, version, settings: { ...settings, news } }).success).toBe(true);
    expect(configurationSchema.safeParse({ ...file, settings: { ...settings, news: { ...news, reasoningEffort: '' } } }).success).toBe(false);
    const resident = { id: 'resident', name: 'Resident', instructions: 'Observe.', motivations: '', intention: '', roomId: 'room-1',
      provider: 'chatgpt', model: 'test', enabled: false, minIntervalMs: 1000, maxIntervalMs: 2000, contextMessageLimit: 30 };
    expect(configurationSchema.safeParse({ ...file, agents: [resident] }).success).toBe(false);
    expect(configurationSchema.safeParse({ ...file, version: 8, agents: [resident] }).success).toBe(true);
    expect(configurationSchema.safeParse({ ...file, agents: [{ ...resident, reasoningEffort: null }] }).success).toBe(true);
  });
  it('validates bounded emotes and typed activity, excluding fabricated arrival actions and extra state mutations', () => {
    expect(actionSchema.parse({ type: 'emote', message: '  A watches.  ' })).toEqual({ type: 'emote', message: 'A watches.' });
    for (const action of [{ type: 'emote', message: 'x'.repeat(241) }, { type: 'emote', message: ' ' },
      { type: 'emote', message: 'A watches.', roomId: 'elsewhere' }, { type: 'arrival', message: 'A enters.' }])
      expect(actionSchema.safeParse(action).success).toBe(false);
    const record = { id: 'event', roomId: 'room-1', agentId: 'a', speaker: 'A', createdAt: '2026-10-19T00:00:00.000Z', content: 'A watches.' };
    for (const type of ['speak', 'emote', 'arrival', 'departure']) expect(conversationMessageSchema.safeParse({ ...record, type }).success).toBe(true);
    for (const item of [record, { ...record, type: 'wait' }, { ...record, type: 'emote', content: 'x'.repeat(241) }, { ...record, type: 'emote', energy: 100 }])
      expect(conversationMessageSchema.safeParse(item).success).toBe(false);
    expect(actionJsonSchema(true).properties.action.anyOf.map(option => option.properties.type.enum[0])).toEqual(['emote', 'speak', 'move', 'wait']);
    expect(actionJsonSchema(false).properties.action.anyOf.map(option => option.properties.type.enum[0])).toEqual(['speak', 'move', 'wait']);
  });
  it('upgrades version-2 settings while preserving customization and requires complete version-3 settings', () => {
    const { activity, scheduling, relationships, news, media, prompts: { observations, emotes, reflection, appraisals, relationshipSummary, newsSelection, mediaParticipation, mediaVote, ...prompts }, ...settings } = defaultSettings;
    prompts.actionSelection = 'Custom action choices';
    const old = { format: 'terrarium-config', version: 2, rooms: [], agents: [], settings: { ...settings, prompts } };
    const upgraded = configurationSchema.parse(old);
    expect(upgraded.settings).toMatchObject({ activity: { roomEventsEnabled: true, emotesEnabled: true }, prompts: { actionSelection: 'Custom action choices', observations, emotes } });
    expect(configurationSchema.safeParse({ ...old, version: 3 }).success).toBe(false);
    expect(configurationSchema.parse({ ...upgraded, version: 3 }).settings).toEqual(upgraded.settings);
    expect(settingsSchema.safeParse({ ...defaultSettings, activity: { emotesEnabled: true } }).success).toBe(false);
  });
  it('upgrades prior reflection settings without overwriting custom guidance and validates merged scheduling', () => {
    const { scheduling, relationships, news, media, prompts: { reflection, appraisals, relationshipSummary, newsSelection, mediaParticipation, mediaVote, ...prompts }, ...settings } = defaultSettings;
    const previous = { ...settings, prompts: { ...prompts, actionSelection: 'Custom choices', reminders: 'Custom reminder' } };
    const upgraded = upgradeReflectionSettings(previous);
    expect(upgraded.prompts).toMatchObject({ actionSelection: 'Custom choices', reminders: 'Custom reminder', reflection });
    expect(upgraded.scheduling).toEqual(scheduling);
    const old = { format: 'terrarium-config', version: 3, rooms: [], agents: [], settings: previous };
    expect(configurationSchema.parse(old).settings).toEqual(upgraded);
    expect(configurationSchema.safeParse({ ...old, version: 4 }).success).toBe(false);
    expect(resolveScheduling(defaultSettings, { timingOverrides: { reflectionIntervalMs: 120000 } })).toEqual({ ...scheduling, reflectionIntervalMs: 120000 });
    expect(() => resolveScheduling(defaultSettings, { timingOverrides: { speechMinDelayMs: 200000 } })).toThrow('Maximum');
    expect(() => resolveScheduling(defaultSettings, { timingOverrides: { emoteMaxIntervalMs: 1 } })).toThrow('Maximum');
    expect(() => resolveScheduling(defaultSettings, { timingOverrides: { reflectionIntervalMs: 0 } })).toThrow();
    const speech = actionJsonSchema(true).properties.action.anyOf.find(option => option.properties.type.enum[0] === 'speak')!;
    expect(speech.required).toContain('replyToId');
    expect(actionSchema.parse({ type: 'speak', message: 'Hello', replyToId: null })).toMatchObject({ replyToId: null });
    expect(conversationMessageSchema.safeParse({ id: 'event', roomId: 'room-1', agentId: 'a', speaker: 'A', createdAt: '2026-10-19T00:00:00.000Z',
      content: 'A watches.', type: 'emote', replyToId: 'speech' }).success).toBe(false);
  });
  it('requires complete version-2 prompt settings without restoring missing defaults', () => {
    expect(configurationSchema.parse({ format: 'terrarium-config', version: 2, rooms: [], agents: [], settings: defaultSettings }).settings).toEqual(defaultSettings);
    for (const prompts of [{}, { ...defaultSettings.prompts, framing: '' }, { ...defaultSettings.prompts, energy: undefined }])
      expect(settingsSchema.safeParse({ ...defaultSettings, prompts }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, energy: { ...defaultSettings.energy, initial: 101 } }).success).toBe(false);
    expect(configurationSchema.safeParse({ format: 'terrarium-config', version: 3, rooms: [], agents: [] }).success).toBe(false);
  });
  it('allows one eat action and a bounded self-report, never arbitrary energy changes', () => {
    expect(actionResponseSchema.parse({ action: { type: 'eat' }, intention: null })).toEqual({ action: { type: 'eat' }, intention: null });
    for (const value of [{ action: { type: 'eat', energy: 100 } }, { action: { type: 'eat' }, intention: 'a'.repeat(241) }, { action: [{ type: 'move', roomId: 'food' }, { type: 'eat' }] }])
      expect(actionResponseSchema.safeParse(value).success).toBe(false);
  });
  it('offers eating only for enabled low energy below maximum in a food-source room', () => {
    const energy = { ...defaultSettings.energy, enabled: true };
    for (const current of [0, 24.999, 25]) expect(canEat(energy, current, true)).toBe(true);
    for (const current of [25.001, 97, 98, 99, 100]) expect(canEat(energy, current, true)).toBe(false);
    expect(canEat(defaultSettings.energy, 0, true)).toBe(false);
    expect(canEat(energy, 0, false)).toBe(false);
    expect(canEat({ ...energy, lowThreshold: 0 }, 0, true)).toBe(true);
    expect(canEat({ ...energy, lowThreshold: 10 }, 10.001, true)).toBe(false);
    expect(canEat({ ...energy, lowThreshold: 100 }, 100, true)).toBe(false);
    expect(canEat({ ...energy, lowThreshold: 100 }, 99, true)).toBe(true);
    const actions = (eligible: boolean) => actionJsonSchema(false, false, eligible).properties.action.anyOf.map(option => option.properties.type.enum[0]);
    expect(actions(canEat(energy, 25, true))).toContain('eat');
    expect(actions(canEat(energy, 97, true))).not.toContain('eat');
    expect(actions(false)).toContain('wait');
  });
  it('requires one explicit agent ID for deletion', () => {
    expect(deleteAgentSchema.parse({ id: 'agent-1' })).toEqual({ id: 'agent-1' });
    for (const input of [null, {}, { id: '' }, { id: 1 }, { id: 'agent-1', deleteMessages: true }])
      expect(deleteAgentSchema.safeParse(input).success).toBe(false);
  });
  it('requires an explicit room or all-room selection for conversation clearing', () => {
    expect(clearHistorySchema.parse({ scope: 'room', roomId: 'room-1' })).toEqual({ scope: 'room', roomId: 'room-1' });
    expect(clearHistorySchema.parse({ scope: 'all' })).toEqual({ scope: 'all' });
    for (const input of [null, {}, { scope: 'room' }, { scope: 'room', roomId: '' }, { scope: 'all', roomId: 'room-1' }, { scope: 'other' }])
      expect(clearHistorySchema.safeParse(input).success).toBe(false);
  });
  const configuration = {
    format: 'terrarium-config',
    version: 1,
    rooms: [],
    agents: [],
  };
  it.each([
    { ...configuration, version: 2 },
    { ...configuration, format: 'other' },
    { ...configuration, credentials: { token: 'synthetic' } },
    { ...configuration, rooms: [{ name: 'Missing ID' }] },
    {
      ...configuration,
      rooms: [
        { id: 'same', name: 'A' },
        { id: 'same', name: 'B' },
      ],
    },
  ])('rejects invalid configuration files %#', (value) => {
    expect(configurationSchema.safeParse(value).success).toBe(false);
  });
  it('requires stable agent IDs, rejects duplicate agents and keeps runtime fields out', () => {
    const agent = {
      id: 'agent-a',
      name: 'A',
      instructions: 'Observe.',
      roomId: 'room-1',
      provider: 'chatgpt',
      model: 'gpt-6-luna',
      enabled: true,
      minIntervalMs: 1000,
      maxIntervalMs: 2000,
      contextMessageLimit: 50,
    };
    expect(
      configurationSchema.safeParse({ ...configuration, agents: [agent] })
        .success,
    ).toBe(true);
    for (const agents of [
      [{ ...agent, id: undefined }],
      [agent, agent],
      [{ ...agent, revision: 5 }],
      [{ ...agent, maxIntervalMs: 1 }],
    ])
      expect(
        configurationSchema.safeParse({ ...configuration, agents }).success,
      ).toBe(false);
  });
  it('bounds configuration size by UTF-8 bytes including readable JSON formatting', () => {
    const rooms = Array.from({ length: 30 }, (_, index) => ({
      id: `room-${index}`,
      name: 'Large',
      description: '界'.repeat(8000),
    }));
    const result = configurationSchema.safeParse({
      ...configuration,
      rooms,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].message).toContain('512 KiB');
  });
  it.each([
    null,
    undefined,
    {},
    { roomId: 3, message: 'hello' },
    { roomId: 'room-1', message: '  ' },
    { roomId: 'room-1', message: 'a'.repeat(8001) },
  ])('rejects malformed messages %j', (value) => {
    expect(messageInputSchema.safeParse(value).success).toBe(false);
  });
  it('accepts only the agreed action vocabulary and fields', () => {
    for (const value of [
      { type: 'delete' },
      { type: 'speak', message: '' },
      { type: 'wait', command: 'extra' },
    ]) {
      expect(actionSchema.safeParse(value).success).toBe(false);
    }
    expect(actionSchema.parse({ type: 'wait' })).toEqual({ type: 'wait' });
  });
  it('rejects conflicting history cursors and inverted cadence', () => {
    const cursor = { id: 'id', createdAt: '2026-10-18T00:00:00.000Z' };
    expect(
      historyInputSchema.safeParse({
        roomId: 'room-1',
        before: cursor,
        after: cursor,
      }).success,
    ).toBe(false);
    expect(
      agentInputSchema.safeParse({
        name: 'A',
        instructions: 'A',
        roomId: 'room-1',
        provider: 'chatgpt',
        model: 'gpt-6-luna',
        enabled: true,
        minIntervalMs: 200,
        maxIntervalMs: 100,
        contextMessageLimit: 50,
      }).success,
    ).toBe(false);
  });
});
