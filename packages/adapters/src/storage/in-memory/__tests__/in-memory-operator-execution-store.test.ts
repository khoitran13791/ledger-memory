import { describe, expect, it } from 'vitest';

import { InMemoryOperatorExecutionStore, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { IdempotencyConflictError } from '@ledgermind/application';
import { createArtifactId, createConversationId, createTimestamp } from '@ledgermind/domain';

const createTime = (value: string) => createTimestamp(new Date(value));

const createRunInput = (conversationId = createConversationId('conv_operator_001')) => ({
  runId: 'run_test_001',
  operatorKind: 'llmMap' as const,
  conversationId,
  taskCount: 2,
  prompt: 'prompt',
  outputSchema: { type: 'object' },
  concurrencyLimit: 1,
  retryPolicy: {
    maxRetries: 2,
    retryBackoffSeconds: 30,
  },
  idempotencyKey: 'same-key',
  normalizedInputDigest: 'digest-a',
  items: [{ value: 1 }, { value: 2 }],
});

describe('InMemoryOperatorExecutionStore', () => {
  it('creates runs/tasks idempotently and rejects digest conflicts', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryOperatorExecutionStore(state);
    const input = createRunInput();

    const created = await store.createRunWithTasks(input);
    const duplicate = await store.createRunWithTasks({
      ...input,
      runId: 'run_test_002',
    });

    expect(duplicate.runId).toBe(created.runId);
    expect(await store.listTasksForRun(created.runId)).toHaveLength(2);

    await expect(
      store.createRunWithTasks({
        ...input,
        runId: 'run_test_003',
        normalizedInputDigest: 'digest-b',
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('claims leases once, reclaims expired leases, and preserves task ordering', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryOperatorExecutionStore(state);
    const run = await store.createRunWithTasks(createRunInput());

    const firstClaim = await store.claimTaskLease({
      workerId: 'worker-a',
      now: createTime('2026-04-01T00:00:00.000Z'),
      leaseDurationSeconds: 30,
    });
    const secondClaim = await store.claimTaskLease({
      workerId: 'worker-b',
      now: createTime('2026-04-01T00:00:01.000Z'),
      leaseDurationSeconds: 30,
    });

    if (firstClaim === null) {
      throw new Error('Expected first lease claim to succeed.');
    }

    await store.recordTaskSuccess({
      taskId: firstClaim.taskId,
      output: { ok: true },
      completedAt: createTime('2026-04-01T00:00:10.000Z'),
    });

    const reclaimed = await store.claimTaskLease({
      workerId: 'worker-c',
      now: createTime('2026-04-01T00:00:31.000Z'),
      leaseDurationSeconds: 30,
    });

    expect(firstClaim.itemIndex).toBe(0);
    expect(secondClaim).toBeNull();
    expect(reclaimed?.itemIndex).toBe(1);
    expect(reclaimed?.attemptCount).toBe(1);

    const tasks = await store.listTasksForRun(run.runId);
    expect(tasks.map((task) => task.itemIndex)).toEqual([0, 1]);
  });

  it('assigns child conversations once and tracks bootstrap transitions', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryOperatorExecutionStore(state);
    const run = await store.createRunWithTasks({
      ...createRunInput(),
      operatorKind: 'agenticMap',
      runId: 'run_test_agentic',
      idempotencyKey: 'agentic-key',
      normalizedInputDigest: 'digest-agentic',
    });
    const [task] = await store.listTasksForRun(run.runId);
    if (task === undefined) {
      throw new Error('Expected first operator task to exist.');
    }

    expect(await store.assignTaskChildConversation({ taskId: task.taskId, childConversationId: createConversationId('conv_child_001') })).toBe(
      createConversationId('conv_child_001'),
    );
    expect(await store.assignTaskChildConversation({ taskId: task.taskId, childConversationId: createConversationId('conv_child_002') })).toBe(
      createConversationId('conv_child_001'),
    );

    expect(await store.getTaskBootstrapState(task.taskId)).toBe('bootstrap_not_started');
    await store.markBootstrapStarted(task.taskId);
    expect(await store.getTaskBootstrapState(task.taskId)).toBe('bootstrap_in_progress');
    await store.markBootstrapCompleted(task.taskId);
    expect(await store.getTaskBootstrapState(task.taskId)).toBe('bootstrap_completed');
  });

  it('records success/failure transitions and finalizes idempotently', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryOperatorExecutionStore(state);
    const run = await store.createRunWithTasks(createRunInput());
    const [firstTask] = await store.listTasksForRun(run.runId);
    if (firstTask === undefined) {
      throw new Error('Expected first operator task to exist.');
    }

    await store.claimTaskLease({
      workerId: 'worker-a',
      now: createTime('2026-04-01T00:00:00.000Z'),
      leaseDurationSeconds: 30,
    });
    await store.recordTaskSuccess({
      taskId: firstTask.taskId,
      output: { ok: true },
      completedAt: createTime('2026-04-01T00:00:05.000Z'),
      resultArtifactId: createArtifactId('file_result_001'),
    });

    const [updatedFirstTask, secondTask] = await store.listTasksForRun(run.runId);
    if (updatedFirstTask === undefined || secondTask === undefined) {
      throw new Error('Expected finalized operator tasks to exist.');
    }
    expect(updatedFirstTask.status).toBe('succeeded');
    expect(updatedFirstTask.resultArtifactId).toBe(createArtifactId('file_result_001'));

    await store.markTaskRetryableFailure({
      taskId: secondTask.taskId,
      failure: {
        code: 'RETRY',
        message: 'try later',
        retryable: true,
      },
      nextRetryAt: createTime('2026-04-01T00:01:00.000Z'),
    });

    expect((await store.getTask(secondTask.taskId))?.status).toBe('retryable_failure');

    await store.advanceFinalizationStage({ runId: run.runId, from: 'not_started', to: 'artifact_written' });
    await store.advanceFinalizationStage({ runId: run.runId, from: 'artifact_written', to: 'handle_appended' });

    const finalized = await store.finalizeRun({
      runId: run.runId,
      status: 'completed_with_failures',
      completedAt: createTime('2026-04-01T00:02:00.000Z'),
      outputArtifactId: createArtifactId('file_output_001'),
    });
    const finalizedAgain = await store.finalizeRun({
      runId: run.runId,
      status: 'failed',
      completedAt: createTime('2026-04-01T00:03:00.000Z'),
      outputArtifactId: createArtifactId('file_output_002'),
    });

    expect(finalized.status).toBe('completed_with_failures');
    expect(finalized.finalizationStage).toBe('completed');
    expect(finalizedAgain.outputArtifactId).toBe(createArtifactId('file_output_001'));
    expect(finalizedAgain.status).toBe('completed_with_failures');
  });
});
