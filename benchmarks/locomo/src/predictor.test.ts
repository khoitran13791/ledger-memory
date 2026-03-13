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
});
