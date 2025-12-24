import { LmCompletionRequest, LmCompletionResponse, LmProvider } from './types.js';

export const anthropicProvider: LmProvider = {
  name: 'anthropic',
  async complete(request: LmCompletionRequest): Promise<LmCompletionResponse> {
    // TODO: implement Anthropic HTTP call.
    return { content: `[anthropic mock] ${request.model}` };
  },
};
