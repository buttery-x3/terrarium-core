import { describe, expect, it } from 'vitest';
import {
  actionSchema,
  messageInputSchema,
  agentInputSchema,
  historyInputSchema,
} from '../src/index.js';

describe('runtime contracts', () => {
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
