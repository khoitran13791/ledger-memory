import { describe, expect, it } from 'vitest';

import { scorePrediction } from './scorer.js';

describe('scorePrediction', () => {
  it('normalizes answers before fallback scoring', async () => {
    const result = await scorePrediction({
      baseline: 'ledgermind_static_materialize',
      prediction: '  Violin! ',
      answer: 'violin',
      promptTokens: 400,
      parityTokenBudget: 1024,
      scorerPath: '/definitely/missing/evaluate.py',
    });

    expect(result.normalizedPrediction).toBe('violin');
    expect(result.normalizedAnswer).toBe('violin');
    expect(result.score).toBe(1);
    expect(result.parityMode).toBe('parity');
    expect(result.scorerMode).toBe('fallback_exact_match');
  });

  it('labels full_history_upper_bound as upper_bound when it exceeds the parity budget', async () => {
    const result = await scorePrediction({
      baseline: 'full_history_upper_bound',
      prediction: 'violin',
      answer: 'violin',
      promptTokens: 2048,
      parityTokenBudget: 1024,
      scorerPath: '/definitely/missing/evaluate.py',
    });

    expect(result.parityMode).toBe('upper_bound');
  });

  it('falls back cleanly when the official scorer is unavailable', async () => {
    const result = await scorePrediction({
      baseline: 'ledgermind_agentic_loop',
      prediction: 'piano',
      answer: 'violin',
      promptTokens: 300,
      parityTokenBudget: 1024,
      scorerPath: '/definitely/missing/evaluate.py',
    });

    expect(result.scorerMode).toBe('fallback_exact_match');
    expect(result.score).toBe(0);
  });
});
