import { InvariantViolationError } from '../errors/domain-errors';

type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type MimeType = Brand<string, 'MimeType'>;

export const createMimeType = (value: string): MimeType => {
  if (value.trim().length === 0) {
    throw new InvariantViolationError('MimeType must be a non-empty string.');
  }

  return value as MimeType;
};
