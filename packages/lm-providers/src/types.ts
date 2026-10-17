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
  signal?: AbortSignal;
}

export interface LmCompletionResponse {
  content: string;
  finishReason?: string;
}

export interface LmProvider {
  name: string;
  complete(request: LmCompletionRequest): Promise<LmCompletionResponse>;
}
