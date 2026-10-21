import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readResponse,
  listChatGptModels,
  listChatGptModelCatalog,
  validateChatGptReasoning,
  createChatGptProvider,
  createChatGptPayload,
} from '../src/chatgpt.js';
import { validateCallback, type ChatGptAuth } from '../src/chatgpt-auth.js';
import { protect, unprotect } from '../src/protected-storage.js';

afterEach(() => vi.restoreAllMocks());
const stream = (...events: unknown[]) =>
  new Response(
    events
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const auth = { token: async () => 'synthetic-token' } as ChatGptAuth;
describe('ChatGPT integration', () => {
  it('keeps model defaults omitted and serializes an explicit reasoning strength', () => {
    const request = { provider: 'chatgpt', model: 'test', messages: [] };
    expect(createChatGptPayload(request)).not.toHaveProperty('reasoning');
    expect(createChatGptPayload({ ...request, reasoningEffort: null })).not.toHaveProperty('reasoning');
    expect(createChatGptPayload({ ...request, reasoningEffort: 'xhigh' })).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });
  it('retains only visible catalog capabilities, including dynamic effort names and missing metadata', async () => {
    const connection = { token: async () => 'synthetic' } as ChatGptAuth;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ models: [
      { slug: 'capable', visibility: 'list', display_name: 'Capable', default_reasoning_level: 'low',
        supports_reasoning_effort_updates: false, base_instructions: 'MUST NOT LEAK',
        supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'future-effort', description: 'New option' }, { effort: 'low' }, null, { effort: 3 }] },
      { slug: 'unknown', visibility: 'list' }, { slug: 'none', visibility: 'list', supported_reasoning_levels: [] },
      { slug: 'hidden', visibility: 'hidden', supported_reasoning_levels: [{ effort: 'high' }] }, null,
    ] }));
    const catalog = await listChatGptModelCatalog(connection);
    expect(catalog).toEqual([
      { slug: 'capable', displayName: 'Capable', defaultReasoningEffort: 'low', supportedReasoningEfforts: [
        { effort: 'low', description: 'Fast' }, { effort: 'future-effort', description: 'New option' }] },
      { slug: 'unknown', displayName: 'unknown', defaultReasoningEffort: null, supportedReasoningEfforts: null },
      { slug: 'none', displayName: 'none', defaultReasoningEffort: null, supportedReasoningEfforts: [] },
    ]);
    expect(JSON.stringify(catalog)).not.toContain('MUST NOT LEAK');
    await expect(validateChatGptReasoning(connection, 'capable', 'future-effort')).resolves.toBeUndefined();
    await expect(validateChatGptReasoning(connection, 'capable', 'high')).rejects.toThrow('does not support');
    await expect(validateChatGptReasoning(connection, 'unknown', 'high')).rejects.toThrow('unavailable');
    await expect(validateChatGptReasoning(connection, 'hidden', 'high')).rejects.toThrow('unavailable');
    await expect(validateChatGptReasoning(connection, 'none', 'high')).rejects.toThrow('does not support');
  });
  it('validates explicit effort before capture or inference, caches capability reads, and captures the submitted effort', async () => {
    const connection = { token: async () => 'synthetic' } as ChatGptAuth, capture = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ models: [{
      slug: 'test', visibility: 'list', supported_reasoning_levels: [{ effort: 'xhigh' }],
    }] })).mockResolvedValueOnce(stream(
      { type: 'response.output_text.delta', delta: '{"action":{"type":"wait"}}' },
      { type: 'response.completed', response: { status: 'completed' } },
    ));
    const provider = createChatGptProvider(connection), request = { provider: 'chatgpt', model: 'test', messages: [], onRequest: capture };
    await expect(provider.complete({ ...request, reasoningEffort: 'unsupported' })).rejects.toThrow('does not support');
    expect(capture).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    await provider.complete({ ...request, reasoningEffort: 'xhigh' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(payload.reasoning).toEqual({ effort: 'xhigh' });
    expect(capture).toHaveBeenCalledWith(payload);
  });
  it('does not infer an effort when catalog refresh fails', async () => {
    const connection = { token: async () => 'synthetic' } as ChatGptAuth;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Catalog offline'));
    await expect(validateChatGptReasoning(connection, 'test', 'high')).rejects.toThrow('Catalog offline');
    await expect(validateChatGptReasoning(connection, 'test', null)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('partitions cached and pending catalogs by credential identity without exposing credentials', async () => {
    let identity = 'first-synthetic', resolveFirst!: (value: Response) => void;
    const connection = { token: async () => identity } as ChatGptAuth;
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const response = (slug: string) => Response.json({ models: [{ slug, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(firstResponse).mockResolvedValueOnce(response('second'));
    const first = listChatGptModelCatalog(connection);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    identity = 'second-synthetic';
    expect((await listChatGptModelCatalog(connection))[0].slug).toBe('second');
    resolveFirst(response('first'));
    expect((await first)[0].slug).toBe('first');
    expect((await listChatGptModelCatalog(connection))[0].slug).toBe('second');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not start catalog discovery or inference for an already cancelled request', async () => {
    const connection = { token: vi.fn(async () => 'synthetic') } as unknown as ChatGptAuth;
    const fetcher = vi.spyOn(globalThis, 'fetch'), controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(createChatGptProvider(connection).complete({ provider: 'chatgpt', model: 'test', reasoningEffort: 'high',
      messages: [], signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(connection.token).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('enables search only for an explicit shared-news request', () => {
    const request = { provider: 'chatgpt', model: 'test', messages: [] };
    expect(createChatGptPayload(request)).not.toHaveProperty('tools');
    expect(createChatGptPayload({ ...request, webSearch: true })).toMatchObject({ tools: [{ type: 'web_search' }],
      tool_choice: 'required', include: ['web_search_call.action.sources'] });
  });
  it('returns actual completed search sources and rejects search in ordinary requests', async () => {
    const search = { type: 'web_search_call', status: 'completed', action: { sources: [
      { url: 'https://example.org/story', title: 'Source' }, { url: 'https://example.org/story' },
      { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.org/' },
    ] } };
    const events = [{ type: 'response.output_item.done', output_index: 0, item: search },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"headline":"News"}' }] } },
      { type: 'response.completed', response: { status: 'completed', output: [] } }];
    await expect(readResponse(stream(...events))).rejects.toThrow('unsupported tool');
    expect(await readResponse(stream(...events), { webSearch: true })).toMatchObject({ content: '{"headline":"News"}',
      search: { sources: [{ url: 'https://example.org/story' }] } });
  });
  it('rejects missing or unfinished search and unrelated tools even when search is requested', async () => {
    const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] };
    for (const output of [[message], [{ type: 'web_search_call', status: 'in_progress' }, message]])
      await expect(readResponse(stream({ type: 'response.completed', response: { status: 'completed', output } }), { webSearch: true }))
        .rejects.toThrow('no completed web search');
    await expect(readResponse(stream({ type: 'response.output_item.added', item: { type: 'function_call' } }), { webSearch: true }))
      .rejects.toThrow('unsupported tool');
  });
  it('captures the exact body before sending and refuses to send when capture fails', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      expect(captured).toEqual(JSON.parse(options!.body as string));
      return stream({ type: 'response.output_text.delta', delta: '{"action":{"type":"wait"}}' }, { type: 'response.completed', response: { status: 'completed' } });
    });
    let captured: Record<string, unknown> | undefined;
    const request = { provider: 'chatgpt', model: 'test-model', messages: [{ role: 'system' as const, content: 'Configured framing' }, { role: 'user' as const, content: 'Observed history' }],
      responseFormat: { name: 'action', schema: { type: 'object' } }, onRequest: async (payload: Record<string, unknown>) => { captured = structuredClone(payload); } };
    await createChatGptProvider(auth).complete(request);
    expect(captured).toEqual(createChatGptPayload(request));
    expect(JSON.stringify(captured)).not.toContain('synthetic-token');
    expect(JSON.stringify(captured)).not.toContain('Authorization');
    await expect(createChatGptProvider(auth).complete({ ...request, onRequest: async () => { throw new Error('Capture failed'); } })).rejects.toThrow('Capture failed');
    expect(fetcher).toHaveBeenCalledOnce();
  });
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
    ).resolves.toMatchObject({
      content: '{"type":"wait"}',
      finishReason: 'completed',
    });
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
  it('enforces the supplied schema and reads authoritative completed output with diagnostic IDs', async () => {
    const response = stream(
      { type: 'response.output_text.delta', delta: 'intermediate text' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_completed',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: '{"action":{"type":"wait"}}' },
              ],
            },
          ],
        },
      },
    );
    response.headers.set('x-request-id', 'req_completed');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response);
    const schema = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    };
    const result = await createChatGptProvider(auth).complete({
      provider: 'chatgpt',
      model: 'gpt-6-luna',
      messages: [],
      responseFormat: { name: 'test_action', schema },
    });
    expect(
      JSON.parse(fetcher.mock.calls[0][1]!.body as string).text,
    ).toEqual({
      format: {
        type: 'json_schema',
        name: 'test_action',
        strict: true,
        schema,
      },
    });
    expect(result).toEqual({
      content: '{"action":{"type":"wait"}}',
      finishReason: 'completed',
      responseId: 'resp_completed',
      requestId: 'req_completed',
    });
  });
  it('accepts ChatGPT plan streams with an empty final output list and ignores commentary', async () => {
    const message = (text: string, phase: string) => ({
      type: 'message',
      role: 'assistant',
      phase,
      content: [{ type: 'output_text', text }],
    });
    await expect(
      readResponse(
        stream(
          {
            type: 'response.output_text.delta',
            output_index: 0,
            delta: 'Considering the discussion.',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: message('Considering the discussion.', 'commentary'),
          },
          {
            type: 'response.output_text.delta',
            output_index: 1,
            delta: '{"action":',
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: message('{"action":{"type":"wait"}}', 'final_answer'),
          },
          {
            type: 'response.completed',
            response: { id: 'resp_plan', status: 'completed', output: [] },
          },
        ),
      ),
    ).resolves.toMatchObject({
      content: '{"action":{"type":"wait"}}',
      responseId: 'resp_plan',
    });
  });
  it('uses completed text without duplicating deltas when no output items are repeated', async () => {
    await expect(
      readResponse(
        stream(
          {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: '{"action":',
          },
          {
            type: 'response.output_text.done',
            output_index: 0,
            content_index: 0,
            text: '{"action":{"type":"wait"}}',
          },
          {
            type: 'response.completed',
            response: { status: 'completed', output: [] },
          },
        ),
      ),
    ).resolves.toMatchObject({ content: '{"action":{"type":"wait"}}' });
  });
  it('reports an unsupported schema without silently retrying an unconstrained request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          error: {
            code: 'invalid_json_schema',
            param: 'text.format.schema',
            message: 'Unsupported schema keyword.',
          },
        },
        { status: 400, headers: { 'x-request-id': 'req_schema' } },
      ),
    );
    await expect(
      createChatGptProvider(auth).complete({
        provider: 'chatgpt',
        model: 'test-model',
        messages: [],
        responseFormat: { name: 'test', schema: {} },
      }),
    ).rejects.toThrow(
      /HTTP 400.*invalid_json_schema.*text.format.schema.*Unsupported schema keyword.*req_schema.*test-model/,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    {
      type: 'response.failed',
      response: {
        id: 'resp_failure',
        error: { code: 'server_error', message: 'Please retry.' },
      },
    },
    {
      type: 'response.incomplete',
      response: {
        id: 'resp_failure',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    },
    { type: 'response.refusal.done', response: { id: 'resp_failure' } },
  ])('distinguishes a $type stream failure', async (event) => {
    const result = readResponse(stream(event));
    await expect(result).rejects.toThrow(event.type);
    await expect(result).rejects.toThrow('resp_failure');
    if ('incomplete_details' in event.response)
      await expect(result).rejects.toThrow('max_output_tokens');
    if ('error' in event.response)
      await expect(result).rejects.toThrow('server_error');
  });
  it('rejects multiple completed messages instead of joining them into malformed JSON', async () => {
    const message = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: '{"action":{"type":"wait"}}' },
      ],
    };
    await expect(
      readResponse(
        stream({
          type: 'response.completed',
          response: { status: 'completed', output: [message, message] },
        }),
      ),
    ).rejects.toThrow('2 output messages');
  });
  it('bounds provider error details and omits unrelated response fields', async () => {
    const result = readResponse(
      Response.json(
        {
          error: {
            message: 'x'.repeat(1000),
            authorization: 'synthetic-secret',
          },
        },
        { status: 500 },
      ),
    ).catch((error: Error) => error.message);
    expect(await result).not.toContain('synthetic-secret');
    expect(((await result) as string).length).toBeLessThan(400);
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
      expect(encrypted.includes(Buffer.from('synthetic secret'))).toBe(
        false,
      );
      expect(unprotect(encrypted)).toBe('synthetic secret');
      encrypted[encrypted.length - 1] ^= 1;
      expect(() => unprotect(encrypted)).toThrow();
    },
  );
});
