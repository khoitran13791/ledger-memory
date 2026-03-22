import { access } from 'node:fs/promises';

import type { LongMemEvalScoringInput, LongMemEvalScoringResult } from './types.js';

export const normalizeAnswer = (value: string): string => {
  return value.toLowerCase().trim().replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ');
};

const resolveParityMode = (input: Pick<LongMemEvalScoringInput, 'baseline' | 'promptTokens' | 'parityTokenBudget'>) => {
  if (input.baseline === 'full_history_upper_bound' && input.promptTokens > input.parityTokenBudget) {
    return 'upper_bound';
  }

  return 'parity';
};

export const scorePrediction = async (input: LongMemEvalScoringInput): Promise<LongMemEvalScoringResult> => {
  const normalizedPrediction = normalizeAnswer(input.prediction);
  const normalizedAnswer = normalizeAnswer(input.answer);

  let scorerMode: LongMemEvalScoringResult['scorerMode'] = 'fallback_exact_match';
  try {
    await access(input.scorerPath);
    scorerMode = 'official_python';
  } catch {
    scorerMode = 'fallback_exact_match';
  }

  return {
    normalizedPrediction,
    normalizedAnswer,
    score: normalizedPrediction === normalizedAnswer ? 1 : 0,
    parityMode: resolveParityMode(input),
    scorerMode,
  };
};
