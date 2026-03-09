import { InvariantViolationError } from '../errors/domain-errors';

type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type ContextVersion = Brand<number, 'ContextVersion'>;

export const createContextVersion = (value: number): ContextVersion => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvariantViolationError('ContextVersion must be a non-negative safe integer.');
  }

  return value as ContextVersion;
};
