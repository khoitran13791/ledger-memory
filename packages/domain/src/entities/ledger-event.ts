import { InvariantViolationError, NonMonotonicSequenceError } from '../errors/domain-errors';
import type { ConversationId, EventId, SequenceNumber } from '../value-objects/ids';
import { isMessageRole, type MessageRole } from '../value-objects/message-role';
import { createTimestamp, type Timestamp } from '../value-objects/timestamp';
import type { TokenCount } from '../value-objects/token-count';

export type EventMetadata = Readonly<Record<string, unknown>>;

export interface LedgerEvent {
  readonly id: EventId;
  readonly conversationId: ConversationId;
  readonly sequence: SequenceNumber;
  readonly role: MessageRole;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly occurredAt: Timestamp;
  readonly metadata: EventMetadata;
}

export interface CreateLedgerEventInput {
  readonly id: EventId;
  readonly conversationId: ConversationId;
  readonly sequence: SequenceNumber;
  readonly role: MessageRole;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly occurredAt?: Timestamp;
  readonly metadata?: EventMetadata;
}

const assertValidSequence = (sequence: number): void => {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new NonMonotonicSequenceError('LedgerEvent.sequence must be a positive safe integer.');
  }
};

const assertValidTokenCount = (tokenCount: TokenCount): void => {
  if (!Number.isSafeInteger(tokenCount.value) || tokenCount.value < 0) {
    throw new InvariantViolationError('LedgerEvent.tokenCount must be a non-negative safe integer.');
  }
};

const assertValidRole = (role: MessageRole): void => {
  if (!isMessageRole(role)) {
    throw new InvariantViolationError('LedgerEvent.role must be one of system, user, assistant, tool.');
  }
};

export const createLedgerEvent = (input: CreateLedgerEventInput): LedgerEvent => {
  assertValidSequence(input.sequence);
  assertValidTokenCount(input.tokenCount);
  assertValidRole(input.role);

  const metadata = Object.freeze({ ...(input.metadata ?? {}) }) as EventMetadata;

  return Object.freeze({
    id: input.id,
    conversationId: input.conversationId,
    sequence: input.sequence,
    role: input.role,
    content: input.content,
    tokenCount: input.tokenCount,
    occurredAt: input.occurredAt ?? createTimestamp(new Date()),
    metadata,
  });
};
