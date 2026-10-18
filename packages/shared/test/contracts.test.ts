import { describe, expect, it } from 'vitest';
import {
  actionSchema,
  messageInputSchema,
  agentInputSchema,
  historyInputSchema,
  configurationSchema,
} from '../src/index.js';

describe('runtime contracts', () => {
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
