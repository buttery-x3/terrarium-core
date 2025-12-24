import { LmCompletionRequest, LmCompletionResponse, LmProvider } from './types.js';

const { LMSTUDIO_API_KEY, LMSTUDIO_BASE_URL } = process.env;

export const lmStudioProvider: LmProvider = {
  name: 'lmstudio',
  async complete(request: LmCompletionRequest): Promise<LmCompletionResponse> {
    if (!LMSTUDIO_BASE_URL) {
      return { content: '[lmstudio] missing LMSTUDIO_BASE_URL' };
    }
    // TODO: call LM Studio REST endpoint; this is intentionally separate from OpenAI adapter.
    const note = LMSTUDIO_API_KEY ? '' : ' (no key)';
    return { content: `[lmstudio mock${note}] ${request.model}` };
  },
};
