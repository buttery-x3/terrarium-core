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
  resolveScheduling, upgradeReflectionSettings,
} from '../src/index.js';

describe('runtime contracts', () => {
  it('validates bounded emotes and typed activity, excluding fabricated arrival actions and extra state mutations', () => {
    expect(actionSchema.parse({ type: 'emote', message: '  A watches.  ' })).toEqual({ type: 'emote', message: 'A watches.' });
    for (const action of [{ type: 'emote', message: 'x'.repeat(241) }, { type: 'emote', message: ' ' },
      { type: 'emote', message: 'A watches.', roomId: 'elsewhere' }, { type: 'arrival', message: 'A enters.' }])
      expect(actionSchema.safeParse(action).success).toBe(false);
    const record = { id: 'event', roomId: 'room-1', agentId: 'a', speaker: 'A', createdAt: '2026-10-19T00:00:00.000Z', content: 'A watches.' };
    for (const type of ['speak', 'emote', 'arrival', 'departure']) expect(conversationMessageSchema.safeParse({ ...record, type }).success).toBe(true);
    for (const item of [record, { ...record, type: 'wait' }, { ...record, type: 'emote', content: 'x'.repeat(241) }, { ...record, type: 'emote', energy: 100 }])
      expect(conversationMessageSchema.safeParse(item).success).toBe(false);
    expect(actionJsonSchema(true).properties.action.anyOf.map(option => option.properties.type.enum[0])).toEqual(['emote', 'speak', 'move', 'wait', 'eat']);
    expect(actionJsonSchema(false).properties.action.anyOf.map(option => option.properties.type.enum[0])).toEqual(['speak', 'move', 'wait', 'eat']);
  });
  it('upgrades version-2 settings while preserving customization and requires complete version-3 settings', () => {
    const { activity, scheduling, relationships, news, prompts: { observations, emotes, reflection, appraisals, relationshipSummary, newsSelection, ...prompts }, ...settings } = defaultSettings;
    prompts.actionSelection = 'Custom action choices';
    const old = { format: 'terrarium-config', version: 2, rooms: [], agents: [], settings: { ...settings, prompts } };
    const upgraded = configurationSchema.parse(old);
    expect(upgraded.settings).toMatchObject({ activity: { roomEventsEnabled: true, emotesEnabled: true }, prompts: { actionSelection: 'Custom action choices', observations, emotes } });
    expect(configurationSchema.safeParse({ ...old, version: 3 }).success).toBe(false);
    expect(configurationSchema.parse({ ...upgraded, version: 3 }).settings).toEqual(upgraded.settings);
    expect(settingsSchema.safeParse({ ...defaultSettings, activity: { emotesEnabled: true } }).success).toBe(false);
  });
  it('upgrades prior reflection settings without overwriting custom guidance and validates merged scheduling', () => {
    const { scheduling, relationships, news, prompts: { reflection, appraisals, relationshipSummary, newsSelection, ...prompts }, ...settings } = defaultSettings;
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
