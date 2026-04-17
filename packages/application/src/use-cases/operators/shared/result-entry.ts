import type { ConversationId } from '@ledgermind/domain';

import type { OperatorFailureMetadata, OperatorResultEntry } from '../../../ports/driving/operator-execution.port';

export const createSucceededResultEntry = (
  itemIndex: number,
  output: unknown,
  childConversationId?: ConversationId,
): OperatorResultEntry => ({
  itemIndex,
  status: 'succeeded',
  output,
  ...(childConversationId === undefined ? {} : { childConversationId }),
});

export const createFailedResultEntry = (
  itemIndex: number,
  error: OperatorFailureMetadata,
  childConversationId?: ConversationId,
): OperatorResultEntry => ({
  itemIndex,
  status: 'failed',
  error,
  ...(childConversationId === undefined ? {} : { childConversationId }),
});
