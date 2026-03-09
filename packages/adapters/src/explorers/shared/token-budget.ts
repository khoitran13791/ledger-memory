import type { ExplorerOutput, TokenizerPort } from '@ledgermind/application';

export interface ConstrainedSummary {
  readonly summary: string;
  readonly tokenCount: ExplorerOutput['tokenCount'];
  readonly truncated: boolean;
  readonly originalTokenCount: number;
  readonly outputTokenCount: number;
  readonly maxTokensRequested?: number;
}

const TRUNCATION_MARKER = '\n... [truncated for token budget]';

const normalizeMaxTokens = (maxTokens: number): number => {
  if (!Number.isFinite(maxTokens)) {
    return 0;
  }

  return Math.max(0, Math.floor(maxTokens));
};

/**
 * Deterministically constrains summary output to maxTokens with stable truncation marker fallback.
 */
export const constrainSummaryToTokenBudget = (
  summary: string,
  tokenizer: TokenizerPort,
  maxTokens?: number,
): ConstrainedSummary => {
  const fullTokenCount = tokenizer.countTokens(summary).value;

  if (maxTokens === undefined) {
    return {
      summary,
      tokenCount: tokenizer.countTokens(summary),
      truncated: false,
      originalTokenCount: fullTokenCount,
      outputTokenCount: fullTokenCount,
    };
  }

  const budget = normalizeMaxTokens(maxTokens);
  if (budget === 0) {
    return {
      summary: '',
      tokenCount: tokenizer.countTokens(''),
      truncated: summary.length > 0,
      originalTokenCount: fullTokenCount,
      outputTokenCount: 0,
      maxTokensRequested: budget,
    };
  }

  if (fullTokenCount <= budget) {
    return {
      summary,
      tokenCount: tokenizer.countTokens(summary),
      truncated: false,
      originalTokenCount: fullTokenCount,
      outputTokenCount: fullTokenCount,
      maxTokensRequested: budget,
    };
  }

  const markerTokenCount = tokenizer.countTokens(TRUNCATION_MARKER).value;
  const targetTokens = Math.max(1, budget - markerTokenCount);
  const ratio = summary.length / Math.max(1, fullTokenCount);
  let cutoff = Math.max(1, Math.floor(targetTokens * ratio));
  let truncatedSummary = `${summary.slice(0, cutoff)}${TRUNCATION_MARKER}`;

  while (tokenizer.countTokens(truncatedSummary).value > budget && cutoff > 1) {
    cutoff = Math.max(1, Math.floor(cutoff * 0.9));
    truncatedSummary = `${summary.slice(0, cutoff)}${TRUNCATION_MARKER}`;
  }

  const truncatedTokenCount = tokenizer.countTokens(truncatedSummary);
  if (truncatedTokenCount.value <= budget) {
    return {
      summary: truncatedSummary,
      tokenCount: truncatedTokenCount,
      truncated: true,
      originalTokenCount: fullTokenCount,
      outputTokenCount: truncatedTokenCount.value,
      maxTokensRequested: budget,
    };
  }

  let markerOnly = TRUNCATION_MARKER;
  while (tokenizer.countTokens(markerOnly).value > budget && markerOnly.length > 0) {
    markerOnly = markerOnly.slice(0, Math.floor(markerOnly.length * 0.9));
  }

  const markerOnlyTokenCount = tokenizer.countTokens(markerOnly);
  if (markerOnlyTokenCount.value <= budget) {
    return {
      summary: markerOnly,
      tokenCount: markerOnlyTokenCount,
      truncated: true,
      originalTokenCount: fullTokenCount,
      outputTokenCount: markerOnlyTokenCount.value,
      maxTokensRequested: budget,
    };
  }

  return {
    summary: '',
    tokenCount: tokenizer.countTokens(''),
    truncated: true,
    originalTokenCount: fullTokenCount,
    outputTokenCount: 0,
    maxTokensRequested: budget,
  };
};
