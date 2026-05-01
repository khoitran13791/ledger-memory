import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreateOperatorRunWithTasksInput } from '@ledgermind/application';
import {
  createArtifactId,
  createCompactionThresholds,
  createConversationConfig,
  createTimestamp,
  createTokenCount,
  type ConversationId,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteConversationStore } from '../sqlite-conversation-store';
import { SqliteOperatorExecutionStore } from '../sqlite-operator-execution-store';

type StoredTaskWithOutput = Awaited<
  ReturnType<SqliteOperatorExecutionStore['listTasksForRun']>
>[number] & {
  readonly output?: unknown;
};

const tempDirs: string[] = [];

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
    runId: overrides.runId ?? 'run_sqlite_001',
    operatorKind: overrides.operatorKind ?? 'llmMap',
    conversationId,
    taskCount: overrides.taskCount ?? items.length,
    prompt: 'Do the SQLite thing',
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

const createTestDatabase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-operators-'));
  tempDirs.push(dir);
  const database = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });
  const conversations = new SqliteConversationStore(database.db);
  const conversation = await conversations.create(
    createConversationConfig({
      modelName: 'sqlite-operator-test',
      contextWindow: createTokenCount(4096),
      thresholds: createCompactionThresholds(0.6, 0.9),
    }),
  );

  return {
    database,
    conversationId: conversation.id,
    operators: new SqliteOperatorExecutionStore(database.db),
  };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteOperatorExecutionStore', () => {
  it('creates a run with two tasks and supports idempotency lookup', async () => {
    const { database, conversationId, operators } = await createTestDatabase();

    try {
      const created = await operators.createRunWithTasks(
        createRunInput(conversationId, {
          runId: 'run_sqlite_create',
          idempotencyKey: 'same-key',
          normalizedInputDigest: 'digest-a',
        }),
      );

      const stored = await operators.getRun(created.runId);
      const lookedUp = await operators.lookupRunByIdempotencyKey(conversationId, 'same-key');
      const tasks = await operators.listTasksForRun(created.runId);

      expect(created.taskCount).toBe(2);
      expect(stored?.taskCount).toBe(2);
      expect(stored?.pendingTaskCount).toBe(2);
      expect(lookedUp?.runId).toBe(created.runId);
      expect(tasks.map((task) => task.itemIndex)).toEqual([0, 1]);
      expect(tasks.map((task) => task.status)).toEqual(['pending', 'pending']);
    } finally {
      database.close();
    }
  });

  it('claims a task lease and records task success with output', async () => {
    const { database, conversationId, operators } = await createTestDatabase();

    try {
      const run = await operators.createRunWithTasks(
        createRunInput(conversationId, {
          runId: 'run_sqlite_success',
          items: [{ value: 1 }],
          taskCount: 1,
        }),
      );

      const claimed = await operators.claimTaskLease({
        workerId: 'w1',
        now: createTime('2026-04-01T00:00:00.000Z'),
        leaseDurationSeconds: 60,
      });

      expect(claimed?.runId).toBe(run.runId);
      expect(claimed?.leaseOwner).toBe('w1');

      if (claimed === null) {
        throw new Error('Expected SQLite task claim to succeed.');
      }

      await operators.recordTaskSuccess({
        taskId: claimed.taskId,
        output: { mapped: true },
        completedAt: createTime('2026-04-01T00:00:01.000Z'),
      });

      const tasks = await operators.listTasksForRun(run.runId);
      const refreshed = await operators.getRun(run.runId);

      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe('succeeded');
      expect((tasks[0] as StoredTaskWithOutput | undefined)?.output).toEqual({ mapped: true });
      expect(refreshed?.succeededTaskCount).toBe(1);
      expect(refreshed?.pendingTaskCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('keeps a run pending while failed tasks still have pending siblings', async () => {
    const { database, conversationId, operators } = await createTestDatabase();

    try {
      const run = await operators.createRunWithTasks(
        createRunInput(conversationId, {
          runId: 'run_sqlite_partial_failure',
          items: [{ value: 1 }, { value: 2 }],
          taskCount: 2,
          concurrencyLimit: 2,
        }),
      );
      const claimed = await operators.claimTaskLease({
        workerId: 'w1',
        now: createTime('2026-04-01T00:00:00.000Z'),
        leaseDurationSeconds: 60,
      });

      if (claimed === null) {
        throw new Error('Expected SQLite task claim to succeed.');
      }

      await operators.recordTaskFailure({
        taskId: claimed.taskId,
        failure: {
          code: 'PERMANENT',
          message: 'failed one task',
          retryable: false,
        },
        completedAt: createTime('2026-04-01T00:00:01.000Z'),
      });

      const refreshed = await operators.getRun(run.runId);
      expect(refreshed?.status).toBe('pending');
      expect(refreshed?.failedTaskCount).toBe(1);
      expect(refreshed?.pendingTaskCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it('finalizes zero-task runs with an output artifact id', async () => {
    const { database, conversationId, operators } = await createTestDatabase();

    try {
      const run = await operators.createRunWithTasks(
        createRunInput(conversationId, {
          runId: 'run_sqlite_empty',
          items: [],
          taskCount: 0,
        }),
      );

      expect(run.status).toBe('completed');
      expect(run.finalizationStage).toBe('not_started');

      const finalized = await operators.finalizeRun({
        runId: run.runId,
        status: 'completed',
        completedAt: createTime('2026-04-01T00:00:01.000Z'),
        outputArtifactId: createArtifactId('file_sqlite_empty_output'),
      });

      expect(finalized.outputArtifactId).toBe(createArtifactId('file_sqlite_empty_output'));
      expect(finalized.finalizationStage).toBe('completed');
    } finally {
      database.close();
    }
  });

  it('persists retryable failure and finalization retry state across reopen', async () => {
    const { database, conversationId, operators } = await createTestDatabase();
    const path = database.path;

    try {
      const run = await operators.createRunWithTasks(
        createRunInput(conversationId, {
          runId: 'run_sqlite_reopen',
          items: [{ value: 1 }],
          taskCount: 1,
        }),
      );

      const claimed = await operators.claimTaskLease({
        workerId: 'w1',
        now: createTime('2026-04-01T00:00:00.000Z'),
        leaseDurationSeconds: 60,
      });

      if (claimed === null) {
        throw new Error('Expected SQLite task claim to succeed.');
      }

      await operators.markTaskRetryableFailure({
        taskId: claimed.taskId,
        failure: {
          code: 'RETRYABLE',
          message: 'retry later',
          retryable: true,
        },
        nextRetryAt: createTime('2026-04-01T00:01:00.000Z'),
      });
      await operators.advanceFinalizationStage({
        runId: run.runId,
        from: 'not_started',
        to: 'artifact_written',
      });
      await operators.advanceFinalizationStage({
        runId: run.runId,
        from: 'artifact_written',
        to: 'handle_appended',
      });

      database.db
        .prepare(
          `UPDATE operator_runs
           SET needs_finalization_retry = 1
           WHERE run_id = ?`,
        )
        .run(run.runId);
    } finally {
      database.close();
    }

    const reopened = await openSqliteDatabase({ path });

    try {
      const reopenedOperators = new SqliteOperatorExecutionStore(reopened.db);
      const retried = await reopenedOperators.claimRunForFinalizationRetry({
        workerId: 'w2',
        now: createTime('2026-04-01T00:02:00.000Z'),
      });
      const tasks = await reopenedOperators.listTasksForRun('run_sqlite_reopen');

      expect(retried?.runId).toBe('run_sqlite_reopen');
      expect(retried?.needsFinalizationRetry).toBe(true);
      expect(retried?.finalizationStage).toBe('handle_appended');
      expect(tasks[0]?.status).toBe('retryable_failure');
      expect(tasks[0]?.terminalFailure?.code).toBe('RETRYABLE');

      const finalized = await reopenedOperators.finalizeRun({
        runId: 'run_sqlite_reopen',
        status: 'completed_with_failures',
        completedAt: createTime('2026-04-01T00:03:00.000Z'),
        outputArtifactId: createArtifactId('file_sqlite_operator_output'),
      });

      expect(finalized.finalizationStage).toBe('completed');
      expect(finalized.needsFinalizationRetry).toBe(false);
      expect(finalized.outputArtifactId).toBe(createArtifactId('file_sqlite_operator_output'));
    } finally {
      reopened.close();
    }
  });
});
