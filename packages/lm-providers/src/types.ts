export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

export interface LmCompletionRequest {
  provider: string;
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { name: string; schema: Record<string, unknown> };
  webSearch?: boolean;
  signal?: AbortSignal;
  onRequest?: (payload: Record<string, unknown>) => Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly details: { requestId?: string; responseId?: string; output?: string; truncated?: boolean } = {}) { super(message); }
}

export interface LmCompletionResponse {
  content: string;
  finishReason?: string;
  requestId?: string;
  responseId?: string;
  search?: { sources: { url: string; title?: string }[] };
}

export interface LmProvider {
  name: string;
  complete(request: LmCompletionRequest): Promise<LmCompletionResponse>;
}
