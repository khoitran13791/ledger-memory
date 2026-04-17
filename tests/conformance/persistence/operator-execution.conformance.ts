import { describe, expect, it } from 'vitest';

import { IdempotencyConflictError } from '@ledgermind/application';
import { createArtifactId, createTimestamp, type ConversationId } from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from '../run-conformance';

const createTime = (value: string) => createTimestamp(new Date(value));

const createRunInput = (conversationId: ConversationId, overrides: Partial<{
  runId: string;
  operatorKind: 'llmMap' | 'agenticMap';
  taskCount: number;
  idempotencyKey: string;
  normalizedInputDigest: string;
  concurrencyLimit: number;
  items: readonly unknown[];
}> = {}) => {
  const items = overrides.items ?? [{ value: 1 }, { value: 2 }];

  return {
    runId: overrides.runId ?? 'run_conf_001',
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
  } as const;
};

export const registerOperatorExecutionConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('operator execution contract', () => {
    it('returns the existing run for the same conversation idempotency key and normalized input', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const created = await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_idempotent_first',
            idempotencyKey: 'same-key',
            normalizedInputDigest: 'digest-a',
          }),
        );

        const duplicate = await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_idempotent_second',
            idempotencyKey: 'same-key',
            normalizedInputDigest: 'digest-a',
          }),
        );

        expect(duplicate.runId).toBe(created.runId);
        expect(await runtime.operators.getRun('run_conf_idempotent_second')).toBeNull();
        expect(await runtime.operators.listTasksForRun(created.runId)).toHaveLength(2);
      } finally {
        await runtime.destroy();
      }
    });

    it('rejects reusing an idempotency key with a different normalized input digest', async () => {
      const runtime = await adapter.createRuntime();

      try {
        await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_conflict_first',
            idempotencyKey: 'conflict-key',
            normalizedInputDigest: 'digest-a',
          }),
        );

        await expect(
          runtime.operators.createRunWithTasks(
            createRunInput(runtime.defaultConversationId, {
              runId: 'run_conf_conflict_second',
              idempotencyKey: 'conflict-key',
              normalizedInputDigest: 'digest-b',
            }),
          ),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
      } finally {
        await runtime.destroy();
      }
    });

    it('rejects duplicate task claims once a lease is active', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const run = await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_claim_race',
            items: [{ value: 1 }],
            taskCount: 1,
            concurrencyLimit: 1,
          }),
        );

        const firstClaim = await runtime.operators.claimTaskLease({
          workerId: 'worker-a',
          now: createTime('2026-04-01T00:00:00.000Z'),
          leaseDurationSeconds: 60,
        });
        const secondClaim = await runtime.operators.claimTaskLease({
          workerId: 'worker-b',
          now: createTime('2026-04-01T00:00:01.000Z'),
          leaseDurationSeconds: 60,
        });

        expect(firstClaim?.runId).toBe(run.runId);
        expect(secondClaim).toBeNull();
      } finally {
        await runtime.destroy();
      }
    });

    it('reclaims an expired task lease for a later worker attempt', async () => {
      const runtime = await adapter.createRuntime();

      try {
        await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_lease_reclaim',
            items: [{ value: 1 }],
            taskCount: 1,
            concurrencyLimit: 2,
          }),
        );

        const initialClaim = await runtime.operators.claimTaskLease({
          workerId: 'worker-a',
          now: createTime('2026-04-01T00:00:00.000Z'),
          leaseDurationSeconds: 30,
        });

        if (initialClaim === null) {
          throw new Error('Expected initial task claim to succeed.');
        }

        await runtime.operators.markTaskRetryableFailure({
          taskId: initialClaim.taskId,
          failure: {
            code: 'RETRYABLE',
            message: 'retry later',
            retryable: true,
          },
          nextRetryAt: createTime('2026-04-01T00:00:30.000Z'),
        });

        const reclaimedClaim = await runtime.operators.claimTaskLease({
          workerId: 'worker-b',
          now: createTime('2026-04-01T00:00:31.000Z'),
          leaseDurationSeconds: 30,
        });

        expect(initialClaim.taskId).toBeDefined();
        expect(reclaimedClaim?.taskId).toBe(initialClaim.taskId);
        expect(reclaimedClaim?.attemptCount).toBe(2);
        expect(reclaimedClaim?.leaseOwner).toBe('worker-b');
      } finally {
        await runtime.destroy();
      }
    });

    it('assigns at most one child conversation per task', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const run = await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_child_once',
            operatorKind: 'agenticMap',
            items: [{ value: 1 }],
            taskCount: 1,
          }),
        );
        const [task] = await runtime.operators.listTasksForRun(run.runId);
        if (task === undefined) {
          throw new Error('Expected operator task for child assignment test.');
        }

        const firstAssignment = await runtime.operators.assignTaskChildConversation({
          taskId: task.taskId,
          childConversationId: 'conv_child_001' as ConversationId,
        });
        const secondAssignment = await runtime.operators.assignTaskChildConversation({
          taskId: task.taskId,
          childConversationId: 'conv_child_002' as ConversationId,
        });
        const storedTask = await runtime.operators.getTask(task.taskId);

        expect(firstAssignment).toBe('conv_child_001');
        expect(secondAssignment).toBe('conv_child_001');
        expect(storedTask?.childConversationId).toBe('conv_child_001');
      } finally {
        await runtime.destroy();
      }
    });

    it('advances finalization stages monotonically and finalizes runs idempotently', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const run = await runtime.operators.createRunWithTasks(
          createRunInput(runtime.defaultConversationId, {
            runId: 'run_conf_finalize',
            items: [{ value: 1 }],
            taskCount: 1,
          }),
        );

        const stageAfterWrite = await runtime.operators.advanceFinalizationStage({
          runId: run.runId,
          from: 'not_started',
          to: 'artifact_written',
        });
        const stageAfterDuplicateWrite = await runtime.operators.advanceFinalizationStage({
          runId: run.runId,
          from: 'not_started',
          to: 'artifact_written',
        });
        const stageAfterHandle = await runtime.operators.advanceFinalizationStage({
          runId: run.runId,
          from: 'artifact_written',
          to: 'handle_appended',
        });

        const finalized = await runtime.operators.finalizeRun({
          runId: run.runId,
          status: 'completed',
          completedAt: createTime('2026-04-01T00:10:00.000Z'),
          outputArtifactId: createArtifactId('file_conf_output_001'),
        });
        const finalizedAgain = await runtime.operators.finalizeRun({
          runId: run.runId,
          status: 'failed',
          completedAt: createTime('2026-04-01T00:11:00.000Z'),
          outputArtifactId: createArtifactId('file_conf_output_002'),
        });

        expect(stageAfterWrite).toBe('artifact_written');
        expect(stageAfterDuplicateWrite).toBe('artifact_written');
        expect(stageAfterHandle).toBe('handle_appended');
        expect(finalized.status).toBe('completed');
        expect(finalized.finalizationStage).toBe('completed');
        expect(finalizedAgain.status).toBe('completed');
        expect(finalizedAgain.outputArtifactId).toBe(createArtifactId('file_conf_output_001'));
        expect(finalizedAgain.completedAt).toEqual(createTime('2026-04-01T00:10:00.000Z'));
      } finally {
        await runtime.destroy();
      }
    });
  });
};
