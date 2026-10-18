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
} from '../src/index.js';

describe('runtime contracts', () => {
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
