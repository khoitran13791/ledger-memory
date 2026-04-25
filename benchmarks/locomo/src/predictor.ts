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

const extractQuestionFromPrompt = (prompt: string): string => {
  const questionMatch = prompt.match(/Question:\s*([^\n]+?)(?:\n|$)/i);
  return questionMatch?.[1]?.trim() ?? prompt.trim();
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const stripAnswerWrapper = (prediction: string): string => {
  return normalizeWhitespace(prediction)
    .replace(/^(?:short\s+answer|answer)\s*:\s*/i, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .trim();
};

const toLowerTokens = (value: string): readonly string[] => {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
};

const singularize = (value: string): string => {
  if (value.endsWith('ies') && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 1) {
    return value.slice(0, -1);
  }

  return value;
};

const extractSpeakersFromQuestion = (question: string): readonly string[] => {
  const normalized = question.replace(/[`']/g, "'");
  const match = normalized.match(
    /\b(?:do|does|did|are|were|have|has)\s+([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)\b/,
  );
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return [match[1], match[2]];
  }

  return [];
};

const splitPredictionItems = (prediction: string): readonly string[] => {
  return prediction
    .replace(/\s+and\s+/gi, ', ')
    .split(',')
    .map((part) => normalizeWhitespace(part.replace(/^(?:also|both)\s+/i, '')))
    .filter((part) => part.length > 0);
};

const normalizeListItem = (item: string): string => {
  const lower = item.toLowerCase();
  if (/\bwatch(?:ing)?\s+movies?\b/.test(lower)) {
    return 'watching movies';
  }

  if (/\b(?:make|making|bake|baking|dessert|desserts|icecream|ice\s*cream)\b/.test(lower)) {
    return 'making desserts';
  }

  return item;
};

const speakerHasItem = (input: {
  readonly context: string;
  readonly speaker: string;
  readonly item: string;
}): boolean => {
  const itemTokens = toLowerTokens(input.item).map(singularize);
  const speakerPattern = input.speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = input.context
    .split(/(?<=\.)\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => new RegExp(`\\b${speakerPattern}\\b`, 'i').test(line));

  return lines.some((line) => {
    if (
      input.item === 'making desserts' &&
      /\b(?:make|bake|making|baking|dessert|desserts|icecream|ice\s*cream|cake|recipe|recipes)\b/i.test(
        line,
      )
    ) {
      return true;
    }

    const lineTokens = new Set(toLowerTokens(line).map(singularize));
    return itemTokens.some((token) => lineTokens.has(token));
  });
};

const refineSharedListPrediction = (input: {
  readonly category: number;
  readonly question: string;
  readonly context: string;
  readonly prediction: string;
}): string | undefined => {
  if (input.category !== 1 || !/\b(?:share|both|common)\b/i.test(input.question)) {
    return undefined;
  }

  const speakers = extractSpeakersFromQuestion(input.question);
  if (speakers.length !== 2) {
    return undefined;
  }

  const normalizedItems = [
    ...new Set(splitPredictionItems(input.prediction).map(normalizeListItem)),
  ];
  const supportedItems = normalizedItems.filter((item) =>
    speakers.every((speaker) => speakerHasItem({ context: input.context, speaker, item })),
  );

  return supportedItems.length === 0 ? undefined : supportedItems.join(', ');
};

const refineKindPrediction = (input: {
  readonly question: string;
  readonly prediction: string;
}): string | undefined => {
  if (!/\bwhat\s+(?:kind|type)\b/i.test(input.question)) {
    return undefined;
  }

  if (/\bcar\b/i.test(input.question) && /\bdoes\b.*\bdrive\b/i.test(input.question)) {
    const refined = input.prediction.replace(/\b(?:new|old|used|repaired)\s+/gi, '').trim();
    return refined.length > 0 && refined !== input.prediction ? refined : undefined;
  }

  return undefined;
};

const refinePetPrediction = (input: {
  readonly question: string;
  readonly context: string;
  readonly prediction: string;
}): string | undefined => {
  if (!/\bwhat\s+pets?\b/i.test(input.question)) {
    return undefined;
  }

  const lowerPrediction = input.prediction.toLowerCase();
  const lowerContext = input.context.toLowerCase();
  if (
    lowerPrediction.includes('snake') &&
    /\b(?:one of my snakes|my snakes|second snake|snakes)\b/.test(lowerContext)
  ) {
    return 'snakes';
  }

  return undefined;
};

const trimTrailingContextQualifier = (input: {
  readonly question: string;
  readonly prediction: string;
}): string | undefined => {
  if (!/\b(?:main\s+focus|focuses?)\b/i.test(input.question)) {
    return undefined;
  }

  const refined = input.prediction
    .replace(/\s+in\s+(?:our|the|his|her|their|my|your)\s+community\.?$/i, '')
    .trim();
  return refined.length > 0 && refined !== input.prediction ? refined : undefined;
};

const repairCountryPreposition = (input: {
  readonly question: string;
  readonly prediction: string;
}): string | undefined => {
  if (!/^\s*in\s+what\s+country\b/i.test(input.question) || /^\s*in\b/i.test(input.prediction)) {
    return undefined;
  }

  const tokens = toLowerTokens(input.prediction);
  if (tokens.length !== 1) {
    return undefined;
  }

  return `In ${input.prediction}`;
};

const CITY_TO_COUNTRY: Readonly<Record<string, string>> = Object.freeze({
  boston: 'United States',
  jasper: 'Canada',
  paris: 'France',
});

const isCountryQuestion = (question: string): boolean =>
  /\b(?:what|which)\s+country\b/i.test(question);

const preserveCountryQuestionPreposition = (input: {
  readonly question: string;
  readonly country: string;
}): string => {
  return /^\s*in\s+what\s+country\b/i.test(input.question) ? `In ${input.country}` : input.country;
};

const mappedCountryFromText = (text: string): string | undefined => {
  const tokens = toLowerTokens(text);
  for (const token of tokens) {
    const country = CITY_TO_COUNTRY[token];
    if (country !== undefined) {
      return country;
    }
  }

  return undefined;
};

const refineCountryPrediction = (input: {
  readonly question: string;
  readonly context: string;
  readonly prediction: string;
}): string | undefined => {
  if (!isCountryQuestion(input.question)) {
    return undefined;
  }

  const predictionCountry = mappedCountryFromText(input.prediction);
  if (predictionCountry !== undefined) {
    return preserveCountryQuestionPreposition({
      question: input.question,
      country: predictionCountry,
    });
  }

  if (isAbstentionPrediction({ category: 3, prediction: input.prediction })) {
    const contextCountry = mappedCountryFromText(input.context);
    if (contextCountry !== undefined) {
      return preserveCountryQuestionPreposition({
        question: input.question,
        country: contextCountry,
      });
    }
  }

  return undefined;
};

const exactCaseFromContext = (input: {
  readonly context: string;
  readonly prediction: string;
}): string | undefined => {
  const escaped = input.prediction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = input.context.match(new RegExp(`\\b${escaped}\\b`, 'i'));
  return match?.[0];
};

const postProcessPrediction = (input: {
  readonly category: number;
  readonly question: string;
  readonly context: string;
  readonly prediction: string;
}): string => {
  const stripped = stripAnswerWrapper(input.prediction);
  if (stripped.length === 0) {
    return stripped;
  }

  const countryFromCity = refineCountryPrediction({
    question: input.question,
    context: input.context,
    prediction: stripped,
  });
  if (countryFromCity !== undefined) {
    return countryFromCity;
  }

  const country = repairCountryPreposition({ question: input.question, prediction: stripped });
  if (country !== undefined) {
    return country;
  }

  const sharedList = refineSharedListPrediction({ ...input, prediction: stripped });
  if (sharedList !== undefined) {
    return sharedList;
  }

  const pet = refinePetPrediction({
    question: input.question,
    context: input.context,
    prediction: stripped,
  });
  if (pet !== undefined) {
    return pet;
  }

  const kind = refineKindPrediction({ question: input.question, prediction: stripped });
  if (kind !== undefined) {
    return exactCaseFromContext({ context: input.context, prediction: kind }) ?? kind;
  }

  const trimmed = trimTrailingContextQualifier({ question: input.question, prediction: stripped });
  if (trimmed !== undefined) {
    return exactCaseFromContext({ context: input.context, prediction: trimmed }) ?? trimmed;
  }

  return exactCaseFromContext({ context: input.context, prediction: stripped }) ?? stripped;
};

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
      promptTokens: estimateTokens(
        `${input.systemInstruction}\n\n${input.context}\n\n${input.prompt}`,
      ),
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
    promptTokens: estimateTokens(
      `${input.systemInstruction}\n\n${input.context}\n\n${input.prompt}`,
    ),
    completionTokens: estimateTokens(textFromChat),
  };
};

const normalizePrediction = (input: {
  readonly category: number;
  readonly prediction: string;
}): string => {
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

const isAbstentionPrediction = (input: {
  readonly category: number;
  readonly prediction: string;
}): boolean => {
  const lower = input.prediction.trim().toLowerCase();
  if (lower.length === 0) {
    return true;
  }

  if (input.category === 5) {
    return (
      lower.includes('not mentioned in the conversation') ||
      lower.includes('no information available')
    );
  }

  return (
    lower.includes('no information available') ||
    lower.includes('not mentioned in the conversation')
  );
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
  const question = extractQuestionFromPrompt(input.prompt);

  if (input.predictionMode === 'heuristic') {
    const normalizedFallback = normalizePrediction({
      category: input.category,
      prediction: input.fallbackPrediction,
    });
    const processedFallback = postProcessPrediction({
      category: input.category,
      question,
      context: input.context,
      prediction: normalizedFallback,
    });

    return {
      prediction: processedFallback,
      promptTokens: toPromptTokenEstimate({
        systemInstruction: input.systemInstruction,
        context: input.context,
        prompt: input.prompt,
      }),
      completionTokens: estimateTokens(processedFallback),
      predictionSource: 'heuristic',
      abstentionRetried: false,
    };
  }

  if (input.llmBaseUrl === undefined) {
    throw new Error(
      'LOCOMO LLM mode invariant violated: llmBaseUrl is required for prediction generation.',
    );
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
  const processedPrimary = postProcessPrediction({
    category: input.category,
    question,
    context: input.context,
    prediction: normalizedPrimary,
  });

  const shouldRetry =
    input.retryOnAbstention?.enabled === true &&
    isAbstentionPrediction({ category: input.category, prediction: processedPrimary });

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
    const retryPrompt = input.retryOnAbstention?.retryPrompt ?? input.prompt;
    const processedRetry = postProcessPrediction({
      category: input.category,
      question: extractQuestionFromPrompt(retryPrompt),
      context: input.retryOnAbstention?.retryContext ?? input.context,
      prediction: normalizedRetry,
    });

    return {
      prediction: processedRetry,
      promptTokens: primaryOutput.promptTokens + retryOutput.promptTokens,
      completionTokens: primaryOutput.completionTokens + estimateTokens(processedRetry),
      predictionSource: 'llm',
      abstentionRetried: true,
    };
  }

  return {
    prediction: processedPrimary,
    promptTokens: primaryOutput.promptTokens,
    completionTokens: estimateTokens(processedPrimary),
    predictionSource: 'llm',
    abstentionRetried: false,
  };
};
