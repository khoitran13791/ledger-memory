import { InvariantViolationError } from '../errors/domain-errors';

export interface TokenCount {
  readonly value: number;
}

export const createTokenCount = (value: number): TokenCount => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvariantViolationError('TokenCount must be a non-negative safe integer.');
  }

  return Object.freeze({ value });
};
