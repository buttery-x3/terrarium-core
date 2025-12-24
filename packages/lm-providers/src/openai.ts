import { LmCompletionRequest, LmCompletionResponse, LmProvider } from './types.js';

const { OPENAI_API_KEY, OPENAI_BASE_URL } = process.env;

export const openAiProvider: LmProvider = {
  name: 'openai',
  async complete(request: LmCompletionRequest): Promise<LmCompletionResponse> {
    if (!OPENAI_API_KEY) {
      return { content: '[openai] missing OPENAI_API_KEY' };
    }
    // TODO: perform real OpenAI-compatible call using fetch.
    return { content: `[openai mock] ${request.model}` };
  },
};
