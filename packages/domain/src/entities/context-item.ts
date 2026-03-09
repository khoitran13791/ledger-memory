import { InvariantViolationError } from '../errors/domain-errors';
import type { ConversationId, EventId, SummaryNodeId } from '../value-objects/ids';

export type ContextItemRef =
  | { readonly type: 'message'; readonly messageId: EventId }
  | { readonly type: 'summary'; readonly summaryId: SummaryNodeId };

export interface ContextItem {
  readonly conversationId: ConversationId;
  readonly position: number;
  readonly ref: ContextItemRef;
}

export interface CreateContextItemInput {
  readonly conversationId: ConversationId;
  readonly position: number;
  readonly ref: ContextItemRef;
}

const assertValidPosition = (position: number): void => {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new InvariantViolationError('ContextItem.position must be a non-negative safe integer.');
  }
};

const assertValidContextItemRef = (ref: ContextItemRef): void => {
  if (typeof ref !== 'object' || ref === null || !('type' in ref)) {
    throw new InvariantViolationError('ContextItem.ref must be a valid message or summary reference.');
  }

  if (ref.type === 'message' && 'messageId' in ref && !('summaryId' in ref)) {
    return;
  }

  if (ref.type === 'summary' && 'summaryId' in ref && !('messageId' in ref)) {
    return;
  }

  throw new InvariantViolationError('ContextItem.ref must have exactly one reference target.');
};

export const createMessageContextItemRef = (messageId: EventId): ContextItemRef => {
  return Object.freeze({
    type: 'message',
    messageId,
  });
};

export const createSummaryContextItemRef = (summaryId: SummaryNodeId): ContextItemRef => {
  return Object.freeze({
    type: 'summary',
    summaryId,
  });
};

export const createContextItem = (input: CreateContextItemInput): ContextItem => {
  assertValidPosition(input.position);
  assertValidContextItemRef(input.ref);

  const ref =
    input.ref.type === 'message'
      ? createMessageContextItemRef(input.ref.messageId)
      : createSummaryContextItemRef(input.ref.summaryId);

  return Object.freeze({
    conversationId: input.conversationId,
    position: input.position,
    ref,
  });
};
