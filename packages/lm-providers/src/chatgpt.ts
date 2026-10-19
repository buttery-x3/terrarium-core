import { boundedJson, type ChatGptAuth } from './chatgpt-auth.js';
import { ProviderError, type LmCompletionRequest, type LmCompletionResponse, type LmProvider } from './types.js';

function errorDetails(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(
      ([key, field]) =>
        ['code', 'type', 'param', 'message', 'reason'].includes(key) &&
        typeof field === 'string',
    )
    .map(
      ([key, field]) =>
        `${key}: ${JSON.stringify((field as string).slice(0, 240))}`,
    )
    .join('; ');
}

export async function readResponse(
  response: Response,
  options: { webSearch?: boolean } = {},
): Promise<LmCompletionResponse> {
  const requestId =
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    undefined;
  let responseId: string | undefined;
  let captured = '';
  const failure = (reason: string) =>
    new ProviderError(
      [
        reason,
        responseId ? `Response: ${responseId}.` : '',
        requestId ? `Request: ${requestId}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      { requestId, responseId, output: captured, truncated: true },
    );
  if (!response.ok) {
    const body = await boundedJson(response, 65536).catch(() => undefined);
    const detail = errorDetails(body?.error);
    throw failure(
      `ChatGPT request failed (HTTP ${response.status}).${detail ? ` ${detail}` : ' Check connection and model access.'}`,
    );
  }
  if (!response.body) throw failure('ChatGPT returned no response stream.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const finishedItems = new Map<number, any>();
  const textParts = new Map<string, string>();
  let search: LmCompletionResponse['search'];
  const unsupported = (item: any) => !item || (/call|computer|search/.test(item.type) &&
    !(options.webSearch && item.type === 'web_search_call'));
  let pending = '',
    text = '',
    size = 0,
    completed = false;
  try {
    while (!completed) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4 * 1024 * 1024)
        throw failure('ChatGPT response exceeded the local size limit.');
      pending += decoder.decode(part.value, { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw failure('ChatGPT returned malformed streaming data.');
        }
        if (!event || typeof event.type !== 'string')
          throw failure('ChatGPT returned an invalid streaming event.');
        if (typeof event.response?.id === 'string')
          responseId = event.response.id.slice(0, 160);
        if (
          event.error ||
          ['response.failed', 'response.incomplete', 'error'].includes(
            event.type,
          ) ||
          event.type.includes('refusal')
        )
          throw failure(
            `ChatGPT did not complete the request (${event.type}). ${errorDetails(event.response?.error ?? event.error ?? event.response?.incomplete_details ?? event)}`.trim(),
          );
        if (
          event.item?.type &&
          unsupported(event.item)
        )
          throw failure(
            `ChatGPT proposed an unsupported tool call (${event.item.type}).`,
          );
        if (event.type === 'response.output_item.done') {
          if (!event.item || !Number.isInteger(event.output_index))
            throw failure(
              'ChatGPT returned an invalid completed output item.',
            );
          finishedItems.set(event.output_index, event.item);
        }
        if (
          [
            'response.output_text.delta',
            'response.output_text.done',
          ].includes(event.type)
        ) {
          const part =
            event.type === 'response.output_text.delta'
              ? event.delta
              : event.text;
          if (typeof part !== 'string')
            throw failure('ChatGPT returned invalid text.');
          const key = `${event.output_index ?? event.item_id ?? 0}:${event.content_index ?? 0}`;
          textParts.set(
            key,
            event.type === 'response.output_text.delta'
              ? (textParts.get(key) ?? '') + part
              : part,
          );
          captured = [...textParts.values()].join('\n');
        }
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed')
            throw failure(
              'ChatGPT returned an unsuccessful action response status.',
            );
          if (
            event.response.output !== undefined &&
            !Array.isArray(event.response.output)
          )
            throw failure(
              'ChatGPT returned an invalid completed output list.',
            );
          // INTENT: ChatGPT plan streams may leave the final output list empty.
          const items = event.response.output?.length
            ? event.response.output
            : [...finishedItems.values()];
          if (
            items.some(
              (item: any) =>
                unsupported(item),
            )
          )
            throw failure(
              'ChatGPT returned an invalid output item or unsupported tool call.',
            );
          if (options.webSearch) {
            const searches = items.filter((item: any) => item.type === 'web_search_call' && item.status === 'completed');
            if (!searches.length) throw failure('ChatGPT returned no completed web search.');
            const sources = new Map<string, { url: string; title?: string }>();
            for (const item of searches) for (const source of Array.isArray(item.action?.sources) ? item.action.sources : []) {
              if (typeof source?.url !== 'string' || source.url.length > 2048) continue;
              try {
                const url = new URL(source.url);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
                if (sources.size < 100) sources.set(url.href, { url: url.href,
                  ...(typeof source.title === 'string' ? { title: source.title.slice(0, 240) } : {}) });
              } catch {}
            }
            search = { sources: [...sources.values()] };
          }
          if (
            items.some(
              (item: any) =>
                Array.isArray(item.content) &&
                item.content.some(
                  (content: any) => content?.type === 'refusal',
                ),
            )
          )
            throw failure('ChatGPT refused the action request.');
          if (items.length) {
            // INVARIANT: commentary and separate messages are never concatenated into an action.
            const messages = items.filter(
              (item: any) =>
                item.type === 'message' && item.phase !== 'commentary',
            );
            if (messages.length !== 1 || messages[0].role !== 'assistant')
              throw failure(
                `ChatGPT returned ${messages.length} output messages; expected one assistant action.`,
              );
            const contents = messages[0].content;
            if (
              !Array.isArray(contents) ||
              contents.length !== 1 ||
              contents[0]?.type !== 'output_text' ||
              typeof contents[0].text !== 'string'
            )
              throw failure(
                'ChatGPT returned an invalid completed text action.',
              );
            text = contents[0].text;
          } else {
            if (textParts.size !== 1)
              throw failure(
                `ChatGPT returned ${textParts.size} text parts; expected one action.`,
              );
            text = [...textParts.values()][0];
          }
          completed = true;
          break;
        }
      }
    }
    if (!completed || !text.trim())
      throw failure('ChatGPT response ended without a completed action.');
    return {
      content: text,
      finishReason: 'completed',
      requestId,
      responseId,
      ...(search ? { search } : {}),
    };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createChatGptProvider(auth: ChatGptAuth): LmProvider {
  return {
    name: 'chatgpt',
    async complete(request) {
      const token = await auth.token();
      request.signal?.throwIfAborted();
      const payload = createChatGptPayload(request);
      await request.onRequest?.(payload);
      request.signal?.throwIfAborted();
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
      });
      const result = await readResponse(response, { webSearch: request.webSearch }).catch(
        (error: unknown) => {
          throw new ProviderError(
            `${error instanceof Error ? error.message : 'ChatGPT response failed.'} Model: ${request.model}.`,
            error instanceof ProviderError ? error.details : {},
          );
        },
      );
      request.signal?.throwIfAborted();
      return result;
    },
  };
}

export function createChatGptPayload(request: LmCompletionRequest): Record<string, unknown> {
  return {
    model: request.model, stream: true, store: false,
    instructions: request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
    input: request.messages.filter(message => message.role !== 'system'),
    ...(request.webSearch ? { tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'] } : {}),
    ...(request.responseFormat ? { text: { format: { type: 'json_schema', name: request.responseFormat.name,
      strict: true, schema: request.responseFormat.schema } } } : {}),
  };
}

export async function listChatGptModels(auth: ChatGptAuth) {
  const token = await auth.token();
  const response = await fetch('https://api.openai.com/v1/models', {
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `ChatGPT model discovery failed (HTTP ${response.status}).`,
    );
  const value = await boundedJson(response);
  if (!Array.isArray(value.models))
    throw new Error('ChatGPT returned an invalid model catalog.');
  return value.models.flatMap((model: any) =>
    model.visibility === 'list' && typeof model.slug === 'string'
      ? [model.slug]
      : [],
  );
}
