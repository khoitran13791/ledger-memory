import { InvariantViolationError, NonMonotonicSequenceError } from '../errors/domain-errors';

type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type ConversationId = Brand<string, 'ConversationId'>;
export type EventId = Brand<string, 'EventId'>;
export type SummaryNodeId = Brand<string, 'SummaryNodeId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type SequenceNumber = Brand<number, 'SequenceNumber'>;

const assertNonEmptyString = (value: string, label: string): void => {
  if (value.trim().length === 0) {
    throw new InvariantViolationError(`${label} must be a non-empty string.`);
  }
};

export const createConversationId = (value: string): ConversationId => {
  assertNonEmptyString(value, 'ConversationId');
  return value as ConversationId;
};

export const createEventId = (value: string): EventId => {
  assertNonEmptyString(value, 'EventId');
  return value as EventId;
};

export const createSummaryNodeId = (value: string): SummaryNodeId => {
  assertNonEmptyString(value, 'SummaryNodeId');
  return value as SummaryNodeId;
};

export const createArtifactId = (value: string): ArtifactId => {
  assertNonEmptyString(value, 'ArtifactId');
  return value as ArtifactId;
};

export const createSequenceNumber = (value: number): SequenceNumber => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NonMonotonicSequenceError('SequenceNumber must be a positive safe integer.');
  }

  return value as SequenceNumber;
};
