import { InvariantViolationError } from '../errors/domain-errors';

type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type Timestamp = Brand<Date, 'Timestamp'>;

export const createTimestamp = (value: Date = new Date()): Timestamp => {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new InvariantViolationError('Timestamp must be a valid Date instance.');
  }

  return normalized as Timestamp;
};
