import { LmCompletionRequest, LmCompletionResponse, LmProvider } from './types.js';

export const azureOpenAiProvider: LmProvider = {
  name: 'azure-openai',
  async complete(request: LmCompletionRequest): Promise<LmCompletionResponse> {
    // TODO: implement Azure OpenAI call using deployment name + endpoint envs.
    return { content: `[azure-openai mock] ${request.model}` };
  },
};
