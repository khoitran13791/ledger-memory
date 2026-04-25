import { afterEach, describe, expect, it, vi } from 'vitest';

import { generatePrediction } from './predictor.js';
import type { FairnessConfig } from './types.js';

const fairness: FairnessConfig = {
  modelName: 'gpt-4o-mini',
  promptTemplate: 'Answer from context only.',
  temperature: 0,
  topP: 1,
  tokenBudget: 3_000,
  overheadTokens: 300,
  maxAnswerTokens: 50,
};

const baseInput = {
  fairness,
  seed: 7,
  systemInstruction: 'Answer strictly from context.',
  prompt: 'Question: Where did they meet?',
  context: 'They met in Lisbon.',
  category: 1,
  llmApiKey: 'test-key',
  llmTimeoutMs: 1_000,
  fallbackPrediction: 'Lisbon',
} as const;

const toJsonResponse = (payload: unknown): Response => {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
};

describe('generatePrediction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps explicit heuristic mode unchanged', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'heuristic',
      llmBaseUrl: undefined,
    });

    expect(result.prediction).toBe('Lisbon');
    expect(result.predictionSource).toBe('heuristic');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns llm-backed predictions when llm mode is configured correctly', async () => {
    const fetchMock = vi.fn(async () => toJsonResponse({ output_text: 'Lisbon' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
    });

    expect(result.prediction).toBe('Lisbon');
    expect(result.predictionSource).toBe('llm');
    expect(result.abstentionRetried).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails llm mode on runtime transport errors instead of downgrading to heuristic', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generatePrediction({
        ...baseInput,
        predictionMode: 'llm',
        llmBaseUrl: 'https://example.test/v1',
      }),
    ).rejects.toThrow('network down');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('repairs country answers to match the question form', async () => {
    const fetchMock = vi.fn(async () => toJsonResponse({ output_text: 'France' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: "Question: In what country did Jolene's mother buy her the pendant?",
      context: 'Jolene: This pendant reminds me of my mother, she gave it to me in 2010 in Paris.',
      category: 3,
    });

    expect(result.prediction).toBe('In France');
  });

  it('maps city answers to countries for country questions', async () => {
    const fetchMock = vi.fn(async () => toJsonResponse({ output_text: 'Paris' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: "Question: In what country did Jolene's mother buy her the pendant?",
      context: 'Jolene: This pendant reminds me of my mother, she gave it to me in 2010 in Paris.',
      category: 3,
    });

    expect(result.prediction).toBe('In France');
  });

  it('uses country evidence from context when the model abstains on country questions', async () => {
    const fetchMock = vi.fn(async () =>
      toJsonResponse({ output_text: 'No information available' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: 'Question: Which country do Calvin and Dave want to meet in?',
      context:
        "Calvin: I'm looking forward to my upcoming trip to Boston after I finish the Frank Ocean tour. Dave: I can't wait for your trip to Boston. I'll show you around town.",
      category: 3,
    });

    expect(result.prediction).toBe('United States');
  });

  it('trims trailing context qualifiers from exact-span predictions', async () => {
    const fetchMock = vi.fn(async () =>
      toJsonResponse({ output_text: 'improving education and infrastructure in our community' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: "Question: What is John's main focus in local politics?",
      context:
        "John: I'm passionate about improving education and infrastructure in our community. Those are my main focuses.",
      category: 4,
    });

    expect(result.prediction).toBe('improving education and infrastructure');
  });

  it('prefers car model spans over descriptive qualifiers for kind questions', async () => {
    const fetchMock = vi.fn(async () => toJsonResponse({ output_text: 'new Prius' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: 'Question: What kind of car does Evan drive?',
      context: 'Evan: I just got back from a trip with my family in my new Prius.',
      category: 1,
    });

    expect(result.prediction).toBe('Prius');
  });

  it('prefers pet type spans over individual pet names', async () => {
    const fetchMock = vi.fn(async () => toJsonResponse({ output_text: 'Susie and a snake' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: 'Question: What pets does Jolene have?',
      context:
        'Jolene: I want to show you one of my snakes! They always calm me down. This is Susie. My second snake Seraphim did it.',
      category: 4,
    });

    expect(result.prediction).toBe('snakes');
  });

  it('keeps only supported concise list items for multi-hop answers', async () => {
    const fetchMock = vi.fn(async () =>
      toJsonResponse({ output_text: 'video games, watching movies, and making desserts' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePrediction({
      ...baseInput,
      predictionMode: 'llm',
      llmBaseUrl: 'https://example.test/v1',
      prompt: 'Question: What kind of interests do Joanna and Nate share?',
      context:
        'Joanna: I also enjoy reading, watching movies, and exploring nature. Nate: Playing video games and watching movies are my main hobbies. Nate: I can make coconut milk icecream. Joanna: testing out dairy-free dessert recipes for friends and fam.',
      category: 1,
    });

    expect(result.prediction).toBe('watching movies, making desserts');
  });
});
