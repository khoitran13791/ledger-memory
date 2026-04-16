import { describe, expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  type CreateOperatorRunWithTasksInput,
} from '@ledgermind/application';
import { createArtifactId, createTimestamp, type ConversationId } from '@ledgermind/domain';

import { createPostgresTestHarness } from './postgres-test-harness';

const createTime = (value: string) => createTimestamp(new Date(value));

const createRunInput = (
  conversationId: ConversationId,
  overrides: Partial<{
    runId: string;
    operatorKind: 'llmMap' | 'agenticMap';
    taskCount: number;
    idempotencyKey: string;
    normalizedInputDigest: string;
    concurrencyLimit: number;
    items: readonly unknown[];
  }> = {},
): CreateOperatorRunWithTasksInput => {
  const items = overrides.items ?? [{ value: 1 }, { value: 2 }];

  return {
    runId: overrides.runId ?? 'run_pg_001',
    operatorKind: overrides.operatorKind ?? 'llmMap',
    conversationId,
    taskCount: overrides.taskCount ?? items.length,
    prompt: 'Do the thing',
    outputSchema: { type: 'object' },
    concurrencyLimit: overrides.concurrencyLimit ?? 1,
    retryPolicy: {
      maxRetries: 2,
      retryBackoffSeconds: 30,
    },
    ...(overrides.idempotencyKey === undefined ? {} : { idempotencyKey: overrides.idempotencyKey }),
    ...(overrides.normalizedInputDigest === undefined
      ? {}
      : { normalizedInputDigest: overrides.normalizedInputDigest }),
    items,
  };
};

describe('PgOperatorExecutionStore', () => {
  it('creates a run and ordered tasks atomically', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const run = await harness.operators.createRunWithTasks(
        createRunInput(harness.conversationId, {
          runId: 'run_pg_atomic',
          items: [{ value: 1 }, { value: 2 }, { value: 3 }],
          taskCount: 3,
        }),
      );

      const stored = await harness.operators.getRun(run.runId);
      const tasks = await harness.operators.listTasksForRun(run.runId);

      expect(stored?.runId).toBe(run.runId);
      expect(stored?.pendingTaskCount).toBe(3);
      expect(tasks.map((task) => task.itemIndex)).toEqual([0, 1, 2]);
      expect(tasks.map((task) => task.status)).toEqual(['pending', 'pending', 'pending']);
    } finally {
      await harness.destroy();
    }
  });

  it('claims at most one task under concurrent callers when the run concurrency limit is 1', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const run = await harness.operators.createRunWithTasks(
        createRunInput(harness.conversationId, {
          runId: 'run_pg_claim_race',
          concurrencyLimit: 1,
        }),
      );

      const [first, second] = await Promise.all([
        harness.operators.claimTaskLease({
          workerId: 'worker-a',
          now: createTime('2026-04-01T00:00:00.000Z'),
          leaseDurationSeconds: 60,
        }),
        harness.operators.claimTaskLease({
          workerId: 'worker-b',
          now: createTime('2026-04-01T00:00:00.000Z'),
          leaseDurationSeconds: 60,
        }),
      ]);

      const claims = [first, second].filter((claim) => claim !== null);

      expect(claims).toHaveLength(1);
      expect(claims[0]?.runId).toBe(run.runId);
    } finally {
      await harness.destroy();
    }
  });

  it('reclaims a retryable task after its next retry time passes', async () => {
    const harness = await createPostgresTestHarness();

    try {
      await harness.operators.createRunWithTasks(
        createRunInput(harness.conversationId, {
          runId: 'run_pg_reclaim',
          items: [{ value: 1 }],
          taskCount: 1,
          concurrencyLimit: 2,
        }),
      );

      const initialClaim = await harness.operators.claimTaskLease({
        workerId: 'worker-a',
        now: createTime('2026-04-01T00:00:00.000Z'),
        leaseDurationSeconds: 30,
      });

      if (initialClaim === null) {
        throw new Error('Expected initial task claim to succeed.');
      }

      await harness.operators.markTaskRetryableFailure({
        taskId: initialClaim.taskId,
        failure: {
          code: 'RETRYABLE',
          message: 'retry later',
          retryable: true,
        },
        nextRetryAt: createTime('2026-04-01T00:00:30.000Z'),
      });

      const earlyRetry = await harness.operators.claimTaskLease({
        workerId: 'worker-b',
        now: createTime('2026-04-01T00:00:29.000Z'),
        leaseDurationSeconds: 30,
      });
      const reclaimed = await harness.operators.claimTaskLease({
        workerId: 'worker-c',
        now: createTime('2026-04-01T00:00:31.000Z'),
        leaseDurationSeconds: 30,
      });

      expect(earlyRetry).toBeNull();
      expect(reclaimed?.taskId).toBe(initialClaim.taskId);
      expect(reclaimed?.attemptCount).toBe(2);
      expect(reclaimed?.leaseOwner).toBe('worker-c');
    } finally {
      await harness.destroy();
    }
  });

  it('advances finalization stages idempotently and preserves the first terminal finalization', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const run = await harness.operators.createRunWithTasks(
        createRunInput(harness.conversationId, {
          runId: 'run_pg_finalize',
          items: [{ value: 1 }],
          taskCount: 1,
        }),
      );

      const stageAfterWrite = await harness.operators.advanceFinalizationStage({
        runId: run.runId,
        from: 'not_started',
        to: 'artifact_written',
      });
      const stageAfterDuplicateWrite = await harness.operators.advanceFinalizationStage({
        runId: run.runId,
        from: 'not_started',
        to: 'artifact_written',
      });
      const stageAfterHandle = await harness.operators.advanceFinalizationStage({
        runId: run.runId,
        from: 'artifact_written',
        to: 'handle_appended',
      });

      const finalized = await harness.operators.finalizeRun({
        runId: run.runId,
        status: 'completed',
        completedAt: createTime('2026-04-01T00:10:00.000Z'),
        outputArtifactId: createArtifactId('file_pg_output_001'),
      });
      const finalizedAgain = await harness.operators.finalizeRun({
        runId: run.runId,
        status: 'failed',
        completedAt: createTime('2026-04-01T00:11:00.000Z'),
        outputArtifactId: createArtifactId('file_pg_output_002'),
      });

      expect(stageAfterWrite).toBe('artifact_written');
      expect(stageAfterDuplicateWrite).toBe('artifact_written');
      expect(stageAfterHandle).toBe('handle_appended');
      expect(finalized.finalizationStage).toBe('completed');
      expect(finalizedAgain.status).toBe('completed');
      expect(finalizedAgain.outputArtifactId).toBe(createArtifactId('file_pg_output_001'));
    } finally {
      await harness.destroy();
    }
  });

  it('enforces unique conversation idempotency keys while allowing exact replays', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const created = await harness.operators.createRunWithTasks(
        createRunInput(harness.conversationId, {
          runId: 'run_pg_idempotent_first',
          idempotencyKey: 'same-key',
          normalizedInputDigest: 'digest-a',
        }),
      );

      const duplicate = await harness.operators.createRunWithTasks(
        createRunInput(harness.conversationId, {
          runId: 'run_pg_idempotent_second',
          idempotencyKey: 'same-key',
          normalizedInputDigest: 'digest-a',
        }),
      );

      expect(duplicate.runId).toBe(created.runId);

      await expect(
        harness.operators.createRunWithTasks(
          createRunInput(harness.conversationId, {
            runId: 'run_pg_idempotent_third',
            idempotencyKey: 'same-key',
            normalizedInputDigest: 'digest-b',
          }),
        ),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    } finally {
      await harness.destroy();
    }
  });
});
