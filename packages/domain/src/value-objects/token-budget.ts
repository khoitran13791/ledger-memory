import { BudgetExceededError, InvariantViolationError } from '../errors/domain-errors';
import { createTokenCount, type TokenCount } from './token-count';

export interface TokenBudget {
  readonly contextWindow: TokenCount;
  readonly overhead: TokenCount;
  readonly reserve: TokenCount;
  readonly available: TokenCount;
}

export interface TokenBudgetInput {
  readonly contextWindow: TokenCount;
  readonly overhead: TokenCount;
  readonly reserve: TokenCount;
  readonly available?: TokenCount;
}

export const computeAvailableTokenCount = (
  contextWindow: TokenCount,
  overhead: TokenCount,
  reserve: TokenCount,
): TokenCount => {
  const availableValue = contextWindow.value - overhead.value - reserve.value;

  if (availableValue < 0) {
    throw new BudgetExceededError('Token budget available cannot be negative.');
  }

  return createTokenCount(availableValue);
};

export const createTokenBudget = (input: TokenBudgetInput): TokenBudget => {
  const computedAvailable = computeAvailableTokenCount(
    input.contextWindow,
    input.overhead,
    input.reserve,
  );

  if (input.available !== undefined && input.available.value !== computedAvailable.value) {
    throw new InvariantViolationError(
      'TokenBudget.available must equal contextWindow - overhead - reserve.',
    );
  }

  return Object.freeze({
    contextWindow: input.contextWindow,
    overhead: input.overhead,
    reserve: input.reserve,
    available: input.available ?? computedAvailable,
  });
};
