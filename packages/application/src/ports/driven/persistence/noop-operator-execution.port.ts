import type { OperatorExecutionPort } from './operator-execution.port';

export const createNoopOperatorExecutionPort = (): OperatorExecutionPort => ({
  createRunWithTasks: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  getRun: async () => null,
  getTask: async () => null,
  listTasksForRun: async () => [],
  lookupRunByIdempotencyKey: async () => null,
  claimTaskLease: async () => null,
  recordTaskSuccess: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  recordTaskFailure: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  markTaskRetryableFailure: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  assignTaskChildConversation: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  getTaskBootstrapState: async () => 'bootstrap_not_started',
  markBootstrapStarted: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  markBootstrapCompleted: async () => {
    throw new Error('Not implemented in this operator port.');
  },
  claimRunForFinalizationRetry: async () => null,
  advanceFinalizationStage: async () => 'not_started',
  finalizeRun: async () => {
    throw new Error('Not implemented in this operator port.');
  },
});
