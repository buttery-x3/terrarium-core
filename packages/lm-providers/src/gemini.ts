import { LmCompletionRequest, LmCompletionResponse, LmProvider } from './types.js';

export const geminiProvider: LmProvider = {
  name: 'gemini',
  async complete(request: LmCompletionRequest): Promise<LmCompletionResponse> {
    // TODO: implement Gemini call.
    return { content: `[gemini mock] ${request.model}` };
  },
};
