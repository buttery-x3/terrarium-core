import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readResponse,
  listChatGptModels,
  createChatGptProvider,
} from '../src/chatgpt.js';
import { validateCallback, type ChatGptAuth } from '../src/chatgpt-auth.js';
import { protect, unprotect } from '../src/protected-storage.js';

afterEach(() => vi.restoreAllMocks());
const stream = (...events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const auth = { token: async () => 'synthetic-token' } as ChatGptAuth;
describe('ChatGPT integration', () => {
  it('does not accept partial output or failed completion as dialogue', async () => {
    const delta = {
      type: 'response.output_text.delta',
      delta: '{"type":"wait"}',
    };
    await expect(readResponse(stream(delta))).rejects.toThrow(
      'without a completed',
    );
    await expect(
      readResponse(stream(delta, { type: 'response.failed' })),
    ).rejects.toThrow('did not complete');
    await expect(
      readResponse(
        stream(delta, {
          type: 'response.completed',
          response: { status: 'completed' },
        }),
      ),
    ).resolves.toBe('{"type":"wait"}');
  });
  it('uses the ChatGPT catalog shape and plan-authorized Responses request', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { slug: 'gpt-6-luna', visibility: 'list' },
            { slug: 'hidden', visibility: 'hidden' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        stream(
          { type: 'response.output_text.delta', delta: '{"type":"wait"}' },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      );
    expect(await listChatGptModels(auth)).toEqual(['gpt-6-luna']);
    await createChatGptProvider(auth).complete({
      provider: 'chatgpt',
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: 'Instructions' },
        { role: 'user', content: 'Observed messages' },
      ],
    });
    const [url, options] = fetcher.mock.calls[1];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(options!.body as string)).toEqual({
      model: 'gpt-6-luna',
      stream: true,
      store: false,
      instructions: 'Instructions',
      input: [{ role: 'user', content: 'Observed messages' }],
    });
    expect(options!.redirect).toBe('error');
  });
  it('validates OAuth state and issued registration identity', () => {
    expect(() =>
      validateCallback(
        new URL(
          'http://127.0.0.1/auth/callback?state=bad&client_id=issued&code=test',
        ),
        'expected',
      ),
    ).toThrow('state');
    expect(() =>
      validateCallback(
        new URL(
          'http://127.0.0.1/auth/callback?state=expected&client_id=changed&code=test',
        ),
        'expected',
        'issued',
      ),
    ).toThrow('registration');
    expect(
      validateCallback(
        new URL(
          'http://127.0.0.1/auth/callback?state=expected&client_id=issued&code=test',
        ),
        'expected',
      ),
    ).toEqual({ clientId: 'issued', code: 'test' });
  });
  it.runIf(process.platform === 'win32')(
    'protects credentials and detects tampering',
    () => {
      const encrypted = protect('synthetic secret');
      expect(encrypted.includes(Buffer.from('synthetic secret'))).toBe(false);
      expect(unprotect(encrypted)).toBe('synthetic secret');
      encrypted[encrypted.length - 1] ^= 1;
      expect(() => unprotect(encrypted)).toThrow();
    },
  );
});
