import { boundedJson, type ChatGptAuth } from './chatgpt-auth.js';
import type { LmProvider } from './types.js';

export async function readResponse(response: Response): Promise<string> {
  if (!response.ok)
    throw new Error(
      `ChatGPT request failed (HTTP ${response.status}). Check connection and model access.`,
    );
  if (!response.body) throw new Error('ChatGPT returned no response stream.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
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
        throw new Error('ChatGPT response exceeded the local size limit.');
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
          throw new Error('ChatGPT returned malformed streaming data.');
        }
        if (
          event.error ||
          ['response.failed', 'response.incomplete', 'error'].includes(
            event.type,
          ) ||
          event.type?.includes('refusal')
        )
          throw new Error('ChatGPT did not complete the request.');
        if (event.item?.type && /call|computer|search/.test(event.item.type))
          throw new Error('ChatGPT proposed an unsupported tool call.');
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta !== 'string')
            throw new Error('ChatGPT returned invalid text.');
          text += event.delta;
        }
        if (event.type === 'response.completed') {
          if (
            event.response?.status !== 'completed' ||
            event.response?.output?.some(
              (item: any) =>
                /call|computer|search/.test(item.type) ||
                item.content?.some(
                  (content: any) => content.type === 'refusal',
                ),
            )
          )
            throw new Error(
              'ChatGPT returned an unsuccessful action response.',
            );
          completed = true;
          break;
        }
      }
    }
    if (!completed || !text.trim())
      throw new Error('ChatGPT response ended without a completed action.');
    return text;
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
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          store: false,
          instructions: request.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n'),
          input: request.messages.filter(
            (message) => message.role !== 'system',
          ),
        }),
      });
      const content = await readResponse(response);
      request.signal?.throwIfAborted();
      return { content, finishReason: 'completed' };
    },
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
