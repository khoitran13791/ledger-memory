import { estimateTokens } from './utils.js';
import type { FairnessConfig } from './types.js';

interface LlmGenerationInput {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly modelName: string;
  readonly timeoutMs: number;
  readonly seed: number;
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly context: string;
  readonly maxAnswerTokens: number;
  readonly temperature: number;
  readonly topP: number;
}

interface LlmGenerationOutput {
  readonly prediction: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

interface GenerationRequestInput {
  readonly fairness: FairnessConfig;
  readonly predictionMode: 'heuristic' | 'llm';
  readonly seed: number;
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly context: string;
  readonly category: number;
  readonly llmBaseUrl: string | undefined;
  readonly llmApiKey: string | undefined;
  readonly llmTimeoutMs: number;
  readonly fallbackPrediction: string;
  readonly retryOnAbstention?: {
    readonly enabled: boolean;
    readonly retryPrompt: string;
    readonly retryContext?: string;
  };
}

const toOpenAiMessage = (input: {
  readonly systemInstruction: string;
  readonly context: string;
  readonly prompt: string;
}) => {
  return [
    {
      role: 'system',
      content: input.systemInstruction,
    },
    {
      role: 'user',
      content: `Conversation context:\n${input.context}\n\n${input.prompt}`,
    },
  ];
};

const parseChatCompletionsText = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const root = payload as {
    readonly choices?: readonly {
      readonly message?: {
        readonly content?: unknown;
      };
    }[];
  };

  const content = root.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim();
  }

  return undefined;
};

const parseResponsesText = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const root = payload as {
    readonly output_text?: unknown;
    readonly output?: readonly {
      readonly content?: readonly { readonly text?: unknown }[];
    }[];
  };

  if (typeof root.output_text === 'string' && root.output_text.trim().length > 0) {
    return root.output_text.trim();
  }

  const contentBlocks = root.output ?? [];
  for (const block of contentBlocks) {
    const entries = block.content ?? [];
    for (const entry of entries) {
      if (typeof entry.text === 'string' && entry.text.trim().length > 0) {
        return entry.text.trim();
      }
    }
  }

  return undefined;
};

const postJson = async (input: {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly body: Record<string, unknown>;
}): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (input.apiKey !== undefined && input.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${input.apiKey}`;
    }

    const response = await fetch(input.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} at ${input.url}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const generateWithLlm = async (input: LlmGenerationInput): Promise<LlmGenerationOutput> => {
  const baseUrl = input.baseUrl.replace(/\/+$/, '');

  const responsesPayload = await postJson({
    url: `${baseUrl}/responses`,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    body: {
      model: input.modelName,
      seed: input.seed,
      temperature: input.temperature,
      top_p: input.topP,
      max_output_tokens: input.maxAnswerTokens,
      input: toOpenAiMessage({
        systemInstruction: input.systemInstruction,
        context: input.context,
        prompt: input.prompt,
      }),
    },
  }).catch(() => undefined);

  const textFromResponses = parseResponsesText(responsesPayload);
  if (textFromResponses !== undefined) {
    return {
      prediction: textFromResponses,
      promptTokens: estimateTokens(`${input.systemInstruction}\n\n${input.context}\n\n${input.prompt}`),
      completionTokens: estimateTokens(textFromResponses),
    };
  }

  const chatPayload = await postJson({
    url: `${baseUrl}/chat/completions`,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    body: {
      model: input.modelName,
      seed: input.seed,
      temperature: input.temperature,
      top_p: input.topP,
      max_tokens: input.maxAnswerTokens,
      messages: toOpenAiMessage({
        systemInstruction: input.systemInstruction,
        context: input.context,
        prompt: input.prompt,
      }),
    },
  });

  const textFromChat = parseChatCompletionsText(chatPayload);
  if (textFromChat === undefined) {
    throw new Error('LLM response did not contain text output.');
  }

  return {
    prediction: textFromChat,
    promptTokens: estimateTokens(`${input.systemInstruction}\n\n${input.context}\n\n${input.prompt}`),
    completionTokens: estimateTokens(textFromChat),
  };
};

const normalizePrediction = (input: { readonly category: number; readonly prediction: string }): string => {
  const trimmed = input.prediction.trim();
  if (trimmed.length === 0) {
    return input.category === 5 ? 'Not mentioned in the conversation' : 'No information available';
  }

  if (input.category === 5) {
    const lower = trimmed.toLowerCase();
    if (lower.includes('no information available') || lower.includes('not mentioned')) {
      return 'Not mentioned in the conversation';
    }
  }

  return trimmed;
};

const isAbstentionPrediction = (input: { readonly category: number; readonly prediction: string }): boolean => {
  const lower = input.prediction.trim().toLowerCase();
  if (lower.length === 0) {
    return true;
  }

  if (input.category === 5) {
    return lower.includes('not mentioned in the conversation') || lower.includes('no information available');
  }

  return lower.includes('no information available') || lower.includes('not mentioned in the conversation');
};

const toPromptTokenEstimate = (input: {
  readonly systemInstruction: string;
  readonly context: string;
  readonly prompt: string;
}): number => {
  return estimateTokens(`${input.systemInstruction}\n\n${input.context}\n\n${input.prompt}`);
};

export const generatePrediction = async (
  input: GenerationRequestInput,
): Promise<{
  readonly prediction: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly predictionSource: 'heuristic' | 'llm';
  readonly abstentionRetried: boolean;
}> => {
  if (input.predictionMode === 'heuristic') {
    return {
      prediction: input.fallbackPrediction,
      promptTokens: toPromptTokenEstimate({
        systemInstruction: input.systemInstruction,
        context: input.context,
        prompt: input.prompt,
      }),
      completionTokens: estimateTokens(input.fallbackPrediction),
      predictionSource: 'heuristic',
      abstentionRetried: false,
    };
  }

  if (input.llmBaseUrl === undefined) {
    throw new Error('LOCOMO LLM mode invariant violated: llmBaseUrl is required for prediction generation.');
  }

  const primaryOutput = await generateWithLlm({
    baseUrl: input.llmBaseUrl,
    apiKey: input.llmApiKey,
    modelName: input.fairness.modelName,
    timeoutMs: input.llmTimeoutMs,
    seed: input.seed,
    systemInstruction: input.systemInstruction,
    prompt: input.prompt,
    context: input.context,
    maxAnswerTokens: input.fairness.maxAnswerTokens,
    temperature: input.fairness.temperature,
    topP: input.fairness.topP,
  });

  const normalizedPrimary = normalizePrediction({
    category: input.category,
    prediction: primaryOutput.prediction,
  });

  const shouldRetry =
    input.retryOnAbstention?.enabled === true &&
    isAbstentionPrediction({ category: input.category, prediction: normalizedPrimary });

  if (shouldRetry) {
    const retryOutput = await generateWithLlm({
      baseUrl: input.llmBaseUrl,
      apiKey: input.llmApiKey,
      modelName: input.fairness.modelName,
      timeoutMs: input.llmTimeoutMs,
      seed: input.seed,
      systemInstruction: input.systemInstruction,
      prompt: input.retryOnAbstention?.retryPrompt ?? input.prompt,
      context: input.retryOnAbstention?.retryContext ?? input.context,
      maxAnswerTokens: input.fairness.maxAnswerTokens,
      temperature: input.fairness.temperature,
      topP: input.fairness.topP,
    });

    const normalizedRetry = normalizePrediction({
      category: input.category,
      prediction: retryOutput.prediction,
    });

    return {
      prediction: normalizedRetry,
      promptTokens: primaryOutput.promptTokens + retryOutput.promptTokens,
      completionTokens: primaryOutput.completionTokens + retryOutput.completionTokens,
      predictionSource: 'llm',
      abstentionRetried: true,
    };
  }

  return {
    prediction: normalizedPrimary,
    promptTokens: primaryOutput.promptTokens,
    completionTokens: primaryOutput.completionTokens,
    predictionSource: 'llm',
    abstentionRetried: false,
  };
};
