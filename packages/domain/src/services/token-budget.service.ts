import type { ConversationConfig } from '../entities/conversation';
import { InvariantViolationError } from '../errors/domain-errors';
import { createTokenBudget, type TokenBudget } from '../value-objects/token-budget';
import { createTokenCount, type TokenCount } from '../value-objects/token-count';

export interface TokenBudgetService {
  computeBudget(config: ConversationConfig, overhead: TokenCount): TokenBudget;
  isOverSoftThreshold(currentTokens: TokenCount, budget: TokenBudget): boolean;
  isOverHardThreshold(currentTokens: TokenCount, budget: TokenBudget): boolean;
  computeTargetFreeTokens(budget: TokenBudget, freePercentage: number): TokenCount;
}

const DEFAULT_SOFT_THRESHOLD_FRACTION = 0.6;
const DEFAULT_RESERVE_FRACTION = 0.25;
const DEFAULT_MAX_RESERVE_TOKENS = 20_000;

const SOFT_THRESHOLD_TOKENS = Symbol('softThresholdTokens');
const HARD_THRESHOLD_TOKENS = Symbol('hardThresholdTokens');

type ComputedTokenBudget = TokenBudget & {
  readonly [SOFT_THRESHOLD_TOKENS]: TokenCount;
  readonly [HARD_THRESHOLD_TOKENS]: TokenCount;
};

const assertFractionRange = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvariantViolationError(`${label} must be a finite number in the [0, 1] range.`);
  }
};

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvariantViolationError(`${label} must be a positive safe integer.`);
  }
};

const computeReserveTokenCount = (
  contextWindow: TokenCount,
  reserveFraction: number,
  maxReserveTokens: number,
): TokenCount => {
  assertFractionRange(reserveFraction, 'reserveFraction');
  assertPositiveInteger(maxReserveTokens, 'maxReserveTokens');

  const reserveValue = Math.min(
    maxReserveTokens,
    Math.floor(contextWindow.value * reserveFraction),
    contextWindow.value,
  );

  return createTokenCount(reserveValue);
};

const computeThresholdTokens = (
  contextWindow: TokenCount,
  overhead: TokenCount,
  fraction: number,
  hardLimit: TokenCount,
): TokenCount => {
  assertFractionRange(fraction, 'threshold fraction');

  const thresholdValue = Math.floor(contextWindow.value * fraction - overhead.value);
  return createTokenCount(Math.min(Math.max(0, thresholdValue), hardLimit.value));
};

const isComputedTokenBudget = (budget: TokenBudget): budget is ComputedTokenBudget => {
  return SOFT_THRESHOLD_TOKENS in budget && HARD_THRESHOLD_TOKENS in budget;
};

export const createTokenBudgetService = (
  defaults?: {
    readonly softThresholdFraction?: number;
    readonly reserveFraction?: number;
    readonly maxReserveTokens?: number;
  },
): TokenBudgetService => {
  const fallbackSoftThresholdFraction =
    defaults?.softThresholdFraction ?? DEFAULT_SOFT_THRESHOLD_FRACTION;
  const reserveFraction = defaults?.reserveFraction ?? DEFAULT_RESERVE_FRACTION;
  const maxReserveTokens = defaults?.maxReserveTokens ?? DEFAULT_MAX_RESERVE_TOKENS;

  assertFractionRange(fallbackSoftThresholdFraction, 'softThresholdFraction');
  assertFractionRange(reserveFraction, 'reserveFraction');
  assertPositiveInteger(maxReserveTokens, 'maxReserveTokens');

  const service: TokenBudgetService = {
    computeBudget: (config, overhead) => {
      const reserve = computeReserveTokenCount(config.contextWindow, reserveFraction, maxReserveTokens);
      const budget = createTokenBudget({
        contextWindow: config.contextWindow,
        overhead,
        reserve,
      });
      const hardThreshold = computeThresholdTokens(
        config.contextWindow,
        overhead,
        config.thresholds.hard,
        budget.available,
      );
      const softThreshold = computeThresholdTokens(
        config.contextWindow,
        overhead,
        config.thresholds.soft,
        hardThreshold,
      );

      return Object.freeze({
        ...budget,
        [SOFT_THRESHOLD_TOKENS]: softThreshold,
        [HARD_THRESHOLD_TOKENS]: hardThreshold,
      }) as ComputedTokenBudget;
    },

    isOverSoftThreshold: (currentTokens, budget) => {
      const softLimit = isComputedTokenBudget(budget)
        ? budget[SOFT_THRESHOLD_TOKENS]
        : computeThresholdTokens(
            budget.contextWindow,
            budget.overhead,
            fallbackSoftThresholdFraction,
            budget.available,
          );

      return currentTokens.value > softLimit.value;
    },

    isOverHardThreshold: (currentTokens, budget) => {
      const hardLimit = isComputedTokenBudget(budget)
        ? budget[HARD_THRESHOLD_TOKENS]
        : budget.available;

      return currentTokens.value > hardLimit.value;
    },

    computeTargetFreeTokens: (budget, freePercentage) => {
      assertFractionRange(freePercentage, 'freePercentage');
      return createTokenCount(Math.floor(budget.available.value * freePercentage));
    },
  };

  return Object.freeze(service);
};
