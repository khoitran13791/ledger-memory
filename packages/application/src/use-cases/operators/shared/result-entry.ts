import type { OperatorFailureMetadata, OperatorResultEntry } from '../../../ports/driving/operator-execution.port';

export const createSucceededResultEntry = (itemIndex: number, output: unknown): OperatorResultEntry => ({
  itemIndex,
  status: 'succeeded',
  output,
});

export const createFailedResultEntry = (
  itemIndex: number,
  failure: OperatorFailureMetadata,
): OperatorResultEntry => ({
  itemIndex,
  status: 'failed',
  failure,
});
