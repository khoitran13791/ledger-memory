import {
  IdempotencyConflictError,
  OperatorBootstrapStateError,
  OperatorFinalizationError,
  OperatorRunNotFoundError,
  type AdvanceFinalizationStageInput,
  type AssignTaskChildConversationInput,
  type ClaimRunForFinalizationRetryInput,
  type ClaimTaskLeaseInput,
  type CreateOperatorRunWithTasksInput,
  type FinalizeRunInput,
  type OperatorExecutionPort,
  type StoredOperatorRun,
  type StoredOperatorTask,
} from '@ledgermind/application';
import { createTimestamp, type ConversationId } from '@ledgermind/domain';

import {
  createInMemoryPersistenceState,
  type InMemoryPersistenceState,
  type StoredOperatorTaskRecord,
} from './state';

const createLookupKey = (conversationId: ConversationId, idempotencyKey: string): string => {
  return `${conversationId}::${idempotencyKey}`;
};

const cloneRun = (run: StoredOperatorRun): StoredOperatorRun => ({
  ...run,
  outputSchema: { ...run.outputSchema },
  retryPolicy: { ...run.retryPolicy },
  ...(run.delegatedScope === undefined ? {} : { delegatedScope: { ...run.delegatedScope } }),
  ...(run.keptWork === undefined ? {} : { keptWork: { ...run.keptWork } }),
  ...(run.terminalFailureSummary === undefined ? {} : { terminalFailureSummary: { ...run.terminalFailureSummary } }),
});

const cloneTask = (task: StoredOperatorTaskRecord): StoredOperatorTaskRecord => {
  const cloned: StoredOperatorTaskRecord = {
    ...task,
  };

  if (task.terminalFailure !== undefined) {
    return {
      ...cloned,
      terminalFailure: { ...task.terminalFailure },
    };
  }

  return cloned;
};

const withoutTaskExecutionFields = (task: StoredOperatorTaskRecord): StoredOperatorTaskRecord => {
  const { leaseOwner, leaseExpiresAt, nextRetryAt, terminalFailure, ...rest } = task;

  void leaseOwner;
  void leaseExpiresAt;
  void nextRetryAt;
  void terminalFailure;

  return rest;
};

const countTaskStates = (tasks: readonly StoredOperatorTaskRecord[]) => {
  let pendingTaskCount = 0;
  let runningTaskCount = 0;
  let retryableFailureTaskCount = 0;
  let succeededTaskCount = 0;
  let failedTaskCount = 0;

  for (const task of tasks) {
    switch (task.status) {
      case 'pending':
        pendingTaskCount += 1;
        break;
      case 'running':
        runningTaskCount += 1;
        break;
      case 'retryable_failure':
        retryableFailureTaskCount += 1;
        break;
      case 'succeeded':
        succeededTaskCount += 1;
        break;
      case 'failed':
        failedTaskCount += 1;
        break;
    }
  }

  return {
    pendingTaskCount,
    runningTaskCount,
    retryableFailureTaskCount,
    succeededTaskCount,
    failedTaskCount,
  };
};

const deriveRunStatus = (run: StoredOperatorRun, tasks: readonly StoredOperatorTaskRecord[]): StoredOperatorRun['status'] => {
  if (tasks.length === 0) {
    return run.status;
  }

  const counts = countTaskStates(tasks);
  if (counts.runningTaskCount > 0) {
    return 'running';
  }

  if (counts.failedTaskCount > 0 && counts.succeededTaskCount === 0 && counts.pendingTaskCount === 0 && counts.retryableFailureTaskCount === 0) {
    return 'failed';
  }

  if (counts.failedTaskCount > 0) {
    return 'completed_with_failures';
  }

  if (counts.succeededTaskCount === tasks.length) {
    return 'completed';
  }

  return 'pending';
};

const updateRunFromTasks = (run: StoredOperatorRun, tasks: readonly StoredOperatorTaskRecord[]): StoredOperatorRun => {
  const counts = countTaskStates(tasks);
  const terminalFailureSummary =
    tasks.find((task) => task.status === 'failed' && task.terminalFailure !== undefined)?.terminalFailure ??
    run.terminalFailureSummary;

  return {
    ...run,
    ...counts,
    status: deriveRunStatus(run, tasks),
    updatedAt: createTimestamp(new Date()),
    ...(terminalFailureSummary === undefined ? {} : { terminalFailureSummary }),
  };
};

const getOrderedTasks = (state: InMemoryPersistenceState, runId: string): StoredOperatorTaskRecord[] => {
  const taskIds = state.operatorTaskIdsByRun.get(runId) ?? [];
  return taskIds
    .map((taskId) => state.operatorTasksById.get(taskId))
    .filter((task): task is StoredOperatorTaskRecord => task !== undefined)
    .sort((left, right) => left.itemIndex - right.itemIndex);
};

export class InMemoryOperatorExecutionStore implements OperatorExecutionPort {
  constructor(private readonly state: InMemoryPersistenceState = createInMemoryPersistenceState()) {}

  async createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun> {
    if (input.idempotencyKey !== undefined) {
      const existingRunId = this.state.operatorRunIdByConversationAndKey.get(
        createLookupKey(input.conversationId, input.idempotencyKey),
      );
      if (existingRunId !== undefined) {
        const existingRun = this.state.operatorRunsById.get(existingRunId);
        if (existingRun === undefined) {
          throw new OperatorRunNotFoundError(existingRunId);
        }

        if (existingRun.normalizedInputDigest !== input.normalizedInputDigest) {
          throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey);
        }

        return cloneRun(existingRun);
      }
    }

    const now = createTimestamp(new Date());
    const run: StoredOperatorRun = {
      runId: input.runId,
      conversationId: input.conversationId,
      operatorKind: input.operatorKind,
      status: input.taskCount === 0 ? 'completed' : 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.taskCount === 0 ? { completedAt: now } : {}),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
      outputSchema: { ...input.outputSchema },
      concurrencyLimit: input.concurrencyLimit,
      retryPolicy: { ...input.retryPolicy },
      ...(input.delegatedScope === undefined ? {} : { delegatedScope: { ...input.delegatedScope } }),
      ...(input.keptWork === undefined ? {} : { keptWork: { ...input.keptWork } }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.normalizedInputDigest === undefined
        ? {}
        : { normalizedInputDigest: input.normalizedInputDigest }),
      ...(input.inputArtifactId === undefined ? {} : { inputArtifactId: input.inputArtifactId }),
      finalizationStage: input.taskCount === 0 ? 'completed' : 'not_started',
      needsFinalizationRetry: false,
      taskCount: input.taskCount,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      retryableFailureTaskCount: 0,
      runningTaskCount: 0,
      pendingTaskCount: input.taskCount,
    };

    this.state.operatorRunsById.set(run.runId, run);
    this.state.operatorTaskIdsByRun.set(run.runId, []);

    const conversationOrdinal = (this.state.operatorRunOrdinalsByConversation.get(input.conversationId) ?? 0) + 1;
    this.state.operatorRunOrdinalsByConversation.set(input.conversationId, conversationOrdinal);

    for (let index = 0; index < input.items.length; index += 1) {
      const taskId = `${run.runId}:task:${String(index).padStart(4, '0')}`;
      const task: StoredOperatorTaskRecord = {
        taskId,
        runId: run.runId,
        conversationId: input.conversationId,
        itemIndex: index,
        status: 'pending',
        attemptCount: 0,
        bootstrapState: 'bootstrap_not_started',
      };
      this.state.operatorTasksById.set(taskId, task);
      this.state.operatorTaskIdsByRun.get(run.runId)?.push(taskId);
    }

    if (input.idempotencyKey !== undefined) {
      this.state.operatorRunIdByConversationAndKey.set(
        createLookupKey(input.conversationId, input.idempotencyKey),
        run.runId,
      );
    }

    return cloneRun(run);
  }

  async getRun(runId: string): Promise<StoredOperatorRun | null> {
    const run = this.state.operatorRunsById.get(runId);
    return run === undefined ? null : cloneRun(run);
  }

  async getTask(taskId: string): Promise<StoredOperatorTask | null> {
    const task = this.state.operatorTasksById.get(taskId);
    return task === undefined ? null : cloneTask(task);
  }

  async listTasksForRun(runId: string): Promise<readonly StoredOperatorTask[]> {
    return getOrderedTasks(this.state, runId).map((task) => cloneTask(task));
  }

  async lookupRunByIdempotencyKey(conversationId: ConversationId, idempotencyKey: string): Promise<StoredOperatorRun | null> {
    const runId = this.state.operatorRunIdByConversationAndKey.get(createLookupKey(conversationId, idempotencyKey));
    if (runId === undefined) {
      return null;
    }

    return this.getRun(runId);
  }

  async claimTaskLease(input: ClaimTaskLeaseInput): Promise<StoredOperatorTask | null> {
    const nowMs = input.now.getTime();
    const allowedStatuses = input.allowedStatuses ?? ['pending', 'retryable_failure'];
    const allTasks = [...this.state.operatorTasksById.values()].sort((left, right) => left.itemIndex - right.itemIndex);

    const selectClaimableTask = (
      candidates: readonly StoredOperatorTaskRecord[],
      options: { readonly allowExpiredRunning?: boolean } = {},
    ): StoredOperatorTask | null => {
      for (const task of candidates) {
        const canReclaimExpiredRunning =
          options.allowExpiredRunning === true &&
          task.status === 'running' &&
          task.leaseExpiresAt !== undefined &&
          task.leaseExpiresAt.getTime() <= nowMs;
        if (!canReclaimExpiredRunning && !allowedStatuses.includes(task.status as (typeof allowedStatuses)[number])) {
          continue;
        }

        if (task.nextRetryAt !== undefined && task.nextRetryAt.getTime() > nowMs) {
          continue;
        }

        if (task.leaseExpiresAt !== undefined && task.leaseExpiresAt.getTime() > nowMs) {
          continue;
        }

        const run = this.state.operatorRunsById.get(task.runId);
        if (run === undefined) {
          continue;
        }

        const tasksForRun = getOrderedTasks(this.state, task.runId);
        const activeLeaseCount = tasksForRun.filter(
          (candidate) =>
            candidate.status === 'running' &&
            candidate.leaseExpiresAt !== undefined &&
            candidate.leaseExpiresAt.getTime() > nowMs,
        ).length;

        if (task.status !== 'running' && activeLeaseCount >= run.concurrencyLimit) {
          continue;
        }

        const claimedTask: StoredOperatorTaskRecord = {
          ...withoutTaskExecutionFields(task),
          status: 'running',
          attemptCount: task.attemptCount + 1,
          leaseOwner: input.workerId,
          leaseExpiresAt: createTimestamp(new Date(nowMs + input.leaseDurationSeconds * 1000)),
        };
        this.state.operatorTasksById.set(task.taskId, claimedTask);
        this.state.operatorRunsById.set(run.runId, updateRunFromTasks(run, getOrderedTasks(this.state, run.runId)));
        return cloneTask(claimedTask);
      }

      return null;
    };

    const expiredRunningTasks = allTasks.filter(
      (task) => task.status === 'running' && task.leaseExpiresAt !== undefined && task.leaseExpiresAt.getTime() <= nowMs,
    );

    return selectClaimableTask(expiredRunningTasks, { allowExpiredRunning: true }) ?? selectClaimableTask(allTasks);
  }

  async recordTaskSuccess(input: {
    taskId: string;
    output: unknown;
    completedAt: ReturnType<typeof createTimestamp>;
    resultArtifactId?: StoredOperatorTask['resultArtifactId'];
  }): Promise<void> {
    const task = this.state.operatorTasksById.get(input.taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
    }

    const updatedTask: StoredOperatorTaskRecord = {
      ...withoutTaskExecutionFields(task),
      status: 'succeeded',
      output: input.output,
      ...(input.resultArtifactId === undefined ? {} : { resultArtifactId: input.resultArtifactId }),
    };
    this.state.operatorTasksById.set(task.taskId, updatedTask);

    const run = this.state.operatorRunsById.get(task.runId);
    if (run !== undefined) {
      this.state.operatorRunsById.set(run.runId, updateRunFromTasks(run, getOrderedTasks(this.state, run.runId)));
    }
    void input.completedAt;
  }

  async recordTaskFailure(input: {
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'] extends infer T ? Exclude<T, undefined> : never;
    completedAt: ReturnType<typeof createTimestamp>;
  }): Promise<void> {
    const task = this.state.operatorTasksById.get(input.taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
    }

    const updatedTask: StoredOperatorTaskRecord = {
      ...withoutTaskExecutionFields(task),
      status: 'failed',
      terminalFailure: { ...input.failure },
      lastFailureAt: input.completedAt,
    };
    this.state.operatorTasksById.set(task.taskId, updatedTask);

    const run = this.state.operatorRunsById.get(task.runId);
    if (run !== undefined) {
      this.state.operatorRunsById.set(run.runId, updateRunFromTasks(run, getOrderedTasks(this.state, run.runId)));
    }
  }

  async markTaskRetryableFailure(input: {
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'] extends infer T ? Exclude<T, undefined> : never;
    nextRetryAt: ReturnType<typeof createTimestamp>;
  }): Promise<void> {
    const task = this.state.operatorTasksById.get(input.taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
    }

    const updatedTask: StoredOperatorTaskRecord = {
      ...withoutTaskExecutionFields(task),
      status: 'retryable_failure',
      terminalFailure: { ...input.failure },
      nextRetryAt: input.nextRetryAt,
    };
    this.state.operatorTasksById.set(task.taskId, updatedTask);

    const run = this.state.operatorRunsById.get(task.runId);
    if (run !== undefined) {
      this.state.operatorRunsById.set(run.runId, updateRunFromTasks(run, getOrderedTasks(this.state, run.runId)));
    }
  }

  async assignTaskChildConversation(input: AssignTaskChildConversationInput): Promise<ConversationId> {
    const task = this.state.operatorTasksById.get(input.taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
    }

    if (task.childConversationId !== undefined) {
      return task.childConversationId;
    }

    const updatedTask: StoredOperatorTaskRecord = {
      ...task,
      childConversationId: input.childConversationId,
    };
    this.state.operatorTasksById.set(task.taskId, updatedTask);
    return input.childConversationId;
  }

  async getTaskBootstrapState(taskId: string) {
    const task = this.state.operatorTasksById.get(taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
    }

    return task.bootstrapState;
  }

  async markBootstrapStarted(taskId: string): Promise<void> {
    const task = this.state.operatorTasksById.get(taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
    }

    if (task.bootstrapState === 'bootstrap_completed') {
      return;
    }

    this.state.operatorTasksById.set(taskId, {
      ...task,
      bootstrapState: 'bootstrap_in_progress',
    });
  }

  async markBootstrapCompleted(taskId: string): Promise<void> {
    const task = this.state.operatorTasksById.get(taskId);
    if (task === undefined) {
      throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
    }

    this.state.operatorTasksById.set(taskId, {
      ...task,
      bootstrapState: 'bootstrap_completed',
    });
  }

  async claimRunForFinalizationRetry(input: ClaimRunForFinalizationRetryInput): Promise<StoredOperatorRun | null> {
    void input.workerId;
    void input.now;
    for (const run of this.state.operatorRunsById.values()) {
      if (run.needsFinalizationRetry === true && run.finalizationStage !== 'completed') {
        return cloneRun(run);
      }
    }

    return null;
  }

  async advanceFinalizationStage(input: AdvanceFinalizationStageInput) {
    const run = this.state.operatorRunsById.get(input.runId);
    if (run === undefined) {
      throw new OperatorRunNotFoundError(input.runId);
    }

    if (run.finalizationStage === 'completed') {
      return 'completed' as const;
    }

    if (run.finalizationStage !== input.from) {
      return run.finalizationStage;
    }

    const updatedRun: StoredOperatorRun = {
      ...run,
      finalizationStage: input.to,
      updatedAt: createTimestamp(new Date()),
      ...(input.to === 'handle_appended' ? { parentHandleAppendedAt: createTimestamp(new Date()) } : {}),
    };
    this.state.operatorRunsById.set(run.runId, updatedRun);
    return updatedRun.finalizationStage;
  }

  async finalizeRun(input: FinalizeRunInput): Promise<StoredOperatorRun> {
    const run = this.state.operatorRunsById.get(input.runId);
    if (run === undefined) {
      throw new OperatorRunNotFoundError(input.runId);
    }

    if (run.finalizationStage === 'completed') {
      return cloneRun(run);
    }

    const tasks = getOrderedTasks(this.state, run.runId);
    const counts = countTaskStates(tasks);
    const updatedRun: StoredOperatorRun = {
      ...run,
      status: input.status,
      completedAt: input.completedAt,
      ...(input.outputArtifactId === undefined ? {} : { outputArtifactId: input.outputArtifactId }),
      ...(input.terminalFailureSummary === undefined
        ? {}
        : { terminalFailureSummary: { ...input.terminalFailureSummary } }),
      finalizationStage: 'completed',
      needsFinalizationRetry: false,
      updatedAt: createTimestamp(new Date()),
      ...counts,
    };

    if (run.finalizationStage === 'not_started') {
      throw new OperatorFinalizationError(run.runId, run.finalizationStage, 'Finalization must advance through stages before completion.');
    }

    this.state.operatorRunsById.set(run.runId, updatedRun);
    return cloneRun(updatedRun);
  }
}
