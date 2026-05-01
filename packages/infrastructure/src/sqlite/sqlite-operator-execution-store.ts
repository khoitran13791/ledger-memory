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
  type DelegatedScopeInput,
  type FinalizeRunInput,
  type KeptWorkInput,
  type OperatorExecutionPort,
  type OperatorFailureMetadata,
  type RetryPolicy,
  type StoredOperatorRun,
  type StoredOperatorTask,
} from '@ledgermind/application';
import { InvariantViolationError, type ArtifactId, type ConversationId } from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger, parseSqliteJsonObject, stringifySqliteJson } from './sqlite-json';

interface OperatorRunRow {
  readonly run_id: string;
  readonly conversation_id: string;
  readonly operator_kind: StoredOperatorRun['operatorKind'];
  readonly status: StoredOperatorRun['status'];
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly prompt: string | null;
  readonly task_prompt: string | null;
  readonly output_schema_json: unknown;
  readonly concurrency_limit: unknown;
  readonly retry_policy_json: unknown;
  readonly delegated_scope_json: unknown;
  readonly kept_work_json: unknown;
  readonly idempotency_key: string | null;
  readonly normalized_input_digest: string | null;
  readonly input_artifact_id: string | null;
  readonly output_artifact_id: string | null;
  readonly finalization_stage: StoredOperatorRun['finalizationStage'];
  readonly needs_finalization_retry: unknown;
  readonly parent_handle_appended_at: string | null;
  readonly task_count: unknown;
  readonly succeeded_task_count: unknown;
  readonly failed_task_count: unknown;
  readonly retryable_failure_task_count: unknown;
  readonly running_task_count: unknown;
  readonly pending_task_count: unknown;
  readonly terminal_failure_summary_json: unknown;
}

interface OperatorTaskRow {
  readonly task_id: string;
  readonly run_id: string;
  readonly conversation_id: string;
  readonly item_index: unknown;
  readonly status: StoredOperatorTask['status'];
  readonly attempt_count: unknown;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly next_retry_at: string | null;
  readonly child_conversation_id: string | null;
  readonly bootstrap_state: StoredOperatorTask['bootstrapState'];
  readonly result_json: unknown;
  readonly result_artifact_id: string | null;
  readonly last_error_json: unknown;
}

interface TaskRunIdRow {
  readonly run_id: string;
}

interface CountsRow {
  readonly pending_task_count: unknown;
  readonly running_task_count: unknown;
  readonly retryable_failure_task_count: unknown;
  readonly succeeded_task_count: unknown;
  readonly failed_task_count: unknown;
}

interface FailureRow {
  readonly last_error_json: string | null;
}

const SQLITE_OPERATOR_SAVEPOINT = 'sqlite_operator_execution';

const RUN_COLUMNS = `run_id,
       conversation_id,
       operator_kind,
       status,
       created_at,
       updated_at,
       completed_at,
       prompt,
       task_prompt,
       output_schema_json,
       concurrency_limit,
       retry_policy_json,
       delegated_scope_json,
       kept_work_json,
       idempotency_key,
       normalized_input_digest,
       input_artifact_id,
       output_artifact_id,
       finalization_stage,
       needs_finalization_retry,
       parent_handle_appended_at,
       task_count,
       succeeded_task_count,
       failed_task_count,
       retryable_failure_task_count,
       running_task_count,
       pending_task_count,
       terminal_failure_summary_json`;

const TASK_COLUMNS = `task_id,
       run_id,
       conversation_id,
       item_index,
       status,
       attempt_count,
       lease_owner,
       lease_expires_at,
       next_retry_at,
       child_conversation_id,
       bootstrap_state,
       result_json,
       result_artifact_id,
       last_error_json`;

const nowIso = (): string => new Date().toISOString();

const toTimestamp = (value: string) => {
  return createTimestamp(new Date(value));
};

const withSavepoint = <T>(db: DatabaseSync, work: () => T): T => {
  db.exec(`SAVEPOINT ${SQLITE_OPERATOR_SAVEPOINT}`);

  try {
    const result = work();
    db.exec(`RELEASE SAVEPOINT ${SQLITE_OPERATOR_SAVEPOINT}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${SQLITE_OPERATOR_SAVEPOINT}`);
    db.exec(`RELEASE SAVEPOINT ${SQLITE_OPERATOR_SAVEPOINT}`);
    throw error;
  }
};

const isNestedTransactionError = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { readonly message?: unknown }).message === 'string' &&
    (error as { readonly message: string }).message.includes('within a transaction')
  );
};

const withImmediateWrite = <T>(db: DatabaseSync, work: () => T): T => {
  let began = false;

  try {
    db.exec('BEGIN IMMEDIATE');
    began = true;
  } catch (error) {
    if (isNestedTransactionError(error)) {
      return withSavepoint(db, work);
    }

    throw error;
  }

  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (began) {
      db.exec('ROLLBACK');
    }

    throw error;
  }
};

const parseOptionalJson = (value: unknown): unknown | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  return JSON.parse(value) as unknown;
};

const toRetryPolicy = (value: unknown): RetryPolicy => {
  const object = parseSqliteJsonObject(value);
  return {
    maxRetries: Number(object.maxRetries ?? 0),
    retryBackoffSeconds: Number(object.retryBackoffSeconds ?? 0),
  };
};

const toFailureMetadata = (value: unknown): OperatorFailureMetadata | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const object = parseSqliteJsonObject(value);
  const code = typeof object.code === 'string' ? object.code : 'UNKNOWN';
  const message = typeof object.message === 'string' ? object.message : 'Unknown operator failure.';
  const retryable = object.retryable === true;
  const details =
    typeof object.details === 'object' && object.details !== null && !Array.isArray(object.details)
      ? (object.details as Record<string, unknown>)
      : undefined;

  return {
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  };
};

const toDelegatedScope = (value: unknown): DelegatedScopeInput | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const object = parseSqliteJsonObject(value);
  const messageIds = Array.isArray(object.messageIds)
    ? object.messageIds.filter((item): item is string => typeof item === 'string')
    : undefined;
  const summaryIds = Array.isArray(object.summaryIds)
    ? object.summaryIds.filter((item): item is string => typeof item === 'string')
    : undefined;
  const artifactIds = Array.isArray(object.artifactIds)
    ? object.artifactIds.filter((item): item is ArtifactId => typeof item === 'string')
    : undefined;
  const note = typeof object.note === 'string' ? object.note : undefined;

  if (
    messageIds === undefined &&
    summaryIds === undefined &&
    artifactIds === undefined &&
    note === undefined
  ) {
    return undefined;
  }

  return {
    ...(messageIds === undefined ? {} : { messageIds }),
    ...(summaryIds === undefined ? {} : { summaryIds }),
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(note === undefined ? {} : { note }),
  };
};

const toKeptWork = (value: unknown): KeptWorkInput | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const object = parseSqliteJsonObject(value);
  const description = typeof object.description === 'string' ? object.description : undefined;
  const expectedOutput =
    typeof object.expectedOutput === 'string' ? object.expectedOutput : undefined;

  if (description === undefined || expectedOutput === undefined) {
    return undefined;
  }

  return { description, expectedOutput };
};

const stringifyOptionalFailure = (value: OperatorFailureMetadata | undefined): string | null => {
  return value === undefined ? null : stringifySqliteJson(value);
};

const toStoredRun = (row: OperatorRunRow): StoredOperatorRun => {
  const delegatedScope = toDelegatedScope(row.delegated_scope_json);
  const keptWork = toKeptWork(row.kept_work_json);
  const terminalFailureSummary = toFailureMetadata(row.terminal_failure_summary_json);

  return {
    runId: row.run_id,
    conversationId: row.conversation_id as ConversationId,
    operatorKind: row.operator_kind,
    status: row.status,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
    ...(row.completed_at === null ? {} : { completedAt: toTimestamp(row.completed_at) }),
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    ...(row.task_prompt === null ? {} : { taskPrompt: row.task_prompt }),
    outputSchema: parseSqliteJsonObject(row.output_schema_json),
    concurrencyLimit: parseSqliteInteger(row.concurrency_limit, 'operator_runs.concurrency_limit'),
    retryPolicy: toRetryPolicy(row.retry_policy_json),
    ...(delegatedScope === undefined ? {} : { delegatedScope }),
    ...(keptWork === undefined ? {} : { keptWork }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.normalized_input_digest === null
      ? {}
      : { normalizedInputDigest: row.normalized_input_digest }),
    ...(row.input_artifact_id === null
      ? {}
      : { inputArtifactId: row.input_artifact_id as ArtifactId }),
    ...(row.output_artifact_id === null
      ? {}
      : { outputArtifactId: row.output_artifact_id as ArtifactId }),
    finalizationStage: row.finalization_stage,
    needsFinalizationRetry:
      parseSqliteInteger(row.needs_finalization_retry, 'operator_runs.needs_finalization_retry') ===
      1,
    ...(row.parent_handle_appended_at === null
      ? {}
      : { parentHandleAppendedAt: toTimestamp(row.parent_handle_appended_at) }),
    taskCount: parseSqliteInteger(row.task_count, 'operator_runs.task_count'),
    succeededTaskCount: parseSqliteInteger(
      row.succeeded_task_count,
      'operator_runs.succeeded_task_count',
    ),
    failedTaskCount: parseSqliteInteger(row.failed_task_count, 'operator_runs.failed_task_count'),
    retryableFailureTaskCount: parseSqliteInteger(
      row.retryable_failure_task_count,
      'operator_runs.retryable_failure_task_count',
    ),
    runningTaskCount: parseSqliteInteger(
      row.running_task_count,
      'operator_runs.running_task_count',
    ),
    pendingTaskCount: parseSqliteInteger(
      row.pending_task_count,
      'operator_runs.pending_task_count',
    ),
    ...(terminalFailureSummary === undefined ? {} : { terminalFailureSummary }),
  };
};

const toStoredTask = (row: OperatorTaskRow): StoredOperatorTask => {
  const terminalFailure = toFailureMetadata(row.last_error_json);
  const output = parseOptionalJson(row.result_json);

  return {
    taskId: row.task_id,
    runId: row.run_id,
    conversationId: row.conversation_id as ConversationId,
    itemIndex: parseSqliteInteger(row.item_index, 'operator_tasks.item_index'),
    status: row.status,
    attemptCount: parseSqliteInteger(row.attempt_count, 'operator_tasks.attempt_count'),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: toTimestamp(row.lease_expires_at) }),
    ...(row.next_retry_at === null ? {} : { nextRetryAt: toTimestamp(row.next_retry_at) }),
    ...(row.child_conversation_id === null
      ? {}
      : { childConversationId: row.child_conversation_id as ConversationId }),
    bootstrapState: row.bootstrap_state,
    ...(row.result_artifact_id === null
      ? {}
      : { resultArtifactId: row.result_artifact_id as ArtifactId }),
    ...(terminalFailure === undefined ? {} : { terminalFailure }),
    ...(output === undefined ? {} : { output }),
  };
};

const isSqliteIdempotencyConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return (
    candidate.code === 'ERR_SQLITE_ERROR' &&
    typeof candidate.message === 'string' &&
    candidate.message.includes('operator_runs.conversation_id') &&
    candidate.message.includes('operator_runs.idempotency_key')
  );
};

export class SqliteOperatorExecutionStore implements OperatorExecutionPort {
  constructor(private readonly db: DatabaseSync) {}

  private getRunRow(runId: string): OperatorRunRow | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM operator_runs
         WHERE run_id = ?`,
      )
      .get(runId) as OperatorRunRow | undefined;

    return row ?? null;
  }

  private getTaskRow(taskId: string): OperatorTaskRow | null {
    const row = this.db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM operator_tasks
         WHERE task_id = ?`,
      )
      .get(taskId) as OperatorTaskRow | undefined;

    return row ?? null;
  }

  private lookupRunByIdempotencyKeyRow(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): OperatorRunRow | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM operator_runs
         WHERE conversation_id = ?
           AND idempotency_key = ?`,
      )
      .get(conversationId, idempotencyKey) as OperatorRunRow | undefined;

    return row ?? null;
  }

  private refreshRunFromTasks(runId: string): StoredOperatorRun {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_task_count,
           COUNT(CASE WHEN status = 'running' THEN 1 END) AS running_task_count,
           COUNT(CASE WHEN status = 'retryable_failure' THEN 1 END) AS retryable_failure_task_count,
           COUNT(CASE WHEN status = 'succeeded' THEN 1 END) AS succeeded_task_count,
           COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed_task_count
         FROM operator_tasks
         WHERE run_id = ?`,
      )
      .get(runId) as CountsRow | undefined;

    if (counts === undefined) {
      throw new OperatorRunNotFoundError(runId);
    }

    const failure = this.db
      .prepare(
        `SELECT last_error_json
         FROM operator_tasks
         WHERE run_id = ?
           AND status = 'failed'
           AND last_error_json IS NOT NULL
         ORDER BY item_index ASC
         LIMIT 1`,
      )
      .get(runId) as FailureRow | undefined;

    const pendingTaskCount = parseSqliteInteger(
      counts.pending_task_count,
      'operator_tasks.pending_task_count',
    );
    const runningTaskCount = parseSqliteInteger(
      counts.running_task_count,
      'operator_tasks.running_task_count',
    );
    const retryableFailureTaskCount = parseSqliteInteger(
      counts.retryable_failure_task_count,
      'operator_tasks.retryable_failure_task_count',
    );
    const succeededTaskCount = parseSqliteInteger(
      counts.succeeded_task_count,
      'operator_tasks.succeeded_task_count',
    );
    const failedTaskCount = parseSqliteInteger(
      counts.failed_task_count,
      'operator_tasks.failed_task_count',
    );
    const currentRun = this.getRunRow(runId);

    if (currentRun === null) {
      throw new OperatorRunNotFoundError(runId);
    }

    const taskCount = parseSqliteInteger(currentRun.task_count, 'operator_runs.task_count');
    const hasRemainingWork =
      runningTaskCount > 0 || pendingTaskCount > 0 || retryableFailureTaskCount > 0;
    const status: StoredOperatorRun['status'] = hasRemainingWork
      ? runningTaskCount > 0
        ? 'running'
        : 'pending'
      : failedTaskCount > 0 && succeededTaskCount === 0
        ? 'failed'
        : failedTaskCount > 0
          ? 'completed_with_failures'
          : succeededTaskCount === taskCount
            ? 'completed'
            : 'pending';

    const updated = this.db
      .prepare(
        `UPDATE operator_runs
         SET pending_task_count = ?,
             running_task_count = ?,
             retryable_failure_task_count = ?,
             succeeded_task_count = ?,
             failed_task_count = ?,
             status = ?,
             terminal_failure_summary_json = COALESCE(?, terminal_failure_summary_json),
             updated_at = ?
         WHERE run_id = ?
         RETURNING ${RUN_COLUMNS}`,
      )
      .get(
        pendingTaskCount,
        runningTaskCount,
        retryableFailureTaskCount,
        succeededTaskCount,
        failedTaskCount,
        status,
        failure?.last_error_json ?? null,
        nowIso(),
        runId,
      ) as OperatorRunRow | undefined;

    if (updated === undefined) {
      throw new OperatorRunNotFoundError(runId);
    }

    return toStoredRun(updated);
  }

  async createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun> {
    return withSavepoint(this.db, () => {
      const existingForKey =
        input.idempotencyKey === undefined
          ? null
          : this.lookupRunByIdempotencyKeyRow(input.conversationId, input.idempotencyKey);

      if (existingForKey !== null) {
        const existing = toStoredRun(existingForKey);
        if (existing.normalizedInputDigest !== input.normalizedInputDigest) {
          throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey as string);
        }

        return existing;
      }

      try {
        const timestamp = nowIso();
        const row = this.db
          .prepare(
            `INSERT INTO operator_runs (
              run_id,
              conversation_id,
              operator_kind,
              status,
              created_at,
              updated_at,
              completed_at,
              prompt,
              task_prompt,
              output_schema_json,
              concurrency_limit,
              retry_policy_json,
              delegated_scope_json,
              kept_work_json,
              idempotency_key,
              normalized_input_digest,
              input_artifact_id,
              finalization_stage,
              needs_finalization_retry,
              task_count,
              succeeded_task_count,
              failed_task_count,
              retryable_failure_task_count,
              running_task_count,
              pending_task_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, ?)
            RETURNING ${RUN_COLUMNS}`,
          )
          .get(
            input.runId,
            input.conversationId,
            input.operatorKind,
            input.taskCount === 0 ? 'completed' : 'pending',
            timestamp,
            timestamp,
            input.taskCount === 0 ? timestamp : null,
            input.prompt ?? null,
            input.taskPrompt ?? null,
            stringifySqliteJson(input.outputSchema),
            input.concurrencyLimit,
            stringifySqliteJson(input.retryPolicy),
            input.delegatedScope === undefined ? null : stringifySqliteJson(input.delegatedScope),
            input.keptWork === undefined ? null : stringifySqliteJson(input.keptWork),
            input.idempotencyKey ?? null,
            input.normalizedInputDigest ?? null,
            input.inputArtifactId ?? null,
            'not_started',
            input.taskCount,
            input.taskCount,
          ) as OperatorRunRow | undefined;

        if (row === undefined) {
          throw new InvariantViolationError('Failed to insert operator run.');
        }

        const insertTask = this.db.prepare(
          `INSERT INTO operator_tasks (
            task_id,
            run_id,
            conversation_id,
            item_index,
            status,
            attempt_count,
            bootstrap_state
          )
          VALUES (?, ?, ?, ?, 'pending', 0, 'bootstrap_not_started')`,
        );

        for (let index = 0; index < input.taskCount; index += 1) {
          insertTask.run(
            `${input.runId}:task:${String(index).padStart(4, '0')}`,
            input.runId,
            input.conversationId,
            index,
          );
        }

        return toStoredRun(row);
      } catch (error) {
        if (input.idempotencyKey !== undefined && isSqliteIdempotencyConflict(error)) {
          const existingRow = this.lookupRunByIdempotencyKeyRow(
            input.conversationId,
            input.idempotencyKey,
          );

          if (existingRow === null) {
            throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey);
          }

          const existing = toStoredRun(existingRow);
          if (existing.normalizedInputDigest !== input.normalizedInputDigest) {
            throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey);
          }

          return existing;
        }

        throw error;
      }
    });
  }

  async getRun(runId: string): Promise<StoredOperatorRun | null> {
    const row = this.getRunRow(runId);
    return row === null ? null : toStoredRun(row);
  }

  async getTask(taskId: string): Promise<StoredOperatorTask | null> {
    const row = this.getTaskRow(taskId);
    return row === null ? null : toStoredTask(row);
  }

  async listTasksForRun(runId: string): Promise<readonly StoredOperatorTask[]> {
    const rows = this.db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM operator_tasks
         WHERE run_id = ?
         ORDER BY item_index ASC`,
      )
      .all(runId) as unknown as OperatorTaskRow[];

    return rows.map((row) => toStoredTask(row));
  }

  async lookupRunByIdempotencyKey(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): Promise<StoredOperatorRun | null> {
    const row = this.lookupRunByIdempotencyKeyRow(conversationId, idempotencyKey);
    return row === null ? null : toStoredRun(row);
  }

  async claimTaskLease(input: ClaimTaskLeaseInput): Promise<StoredOperatorTask | null> {
    return withImmediateWrite(this.db, () => {
      const allowedStatuses = input.allowedStatuses ?? ['pending', 'retryable_failure'];
      const allowedStatusPlaceholders = allowedStatuses.map(() => '?').join(', ');
      const selectAllowedStatusSql =
        allowedStatuses.length === 0 ? '0' : `task.status IN (${allowedStatusPlaceholders})`;
      const updateAllowedStatusSql =
        allowedStatuses.length === 0 ? '0' : `status IN (${allowedStatusPlaceholders})`;
      const now = input.now.toISOString();

      const candidate = this.db
        .prepare(
          `SELECT task.task_id, task.run_id
           FROM operator_tasks AS task
           JOIN operator_runs AS run ON run.run_id = task.run_id
           WHERE (
               ${selectAllowedStatusSql}
               OR (
                 task.status = 'running'
                 AND task.lease_expires_at IS NOT NULL
                 AND task.lease_expires_at <= ?
               )
             )
             AND (
               task.status <> 'retryable_failure'
               OR task.next_retry_at IS NULL
               OR task.next_retry_at <= ?
             )
             AND (
               SELECT COUNT(*)
               FROM operator_tasks AS active
               WHERE active.run_id = task.run_id
                 AND active.status = 'running'
                 AND active.lease_expires_at IS NOT NULL
                 AND active.lease_expires_at > ?
             ) < run.concurrency_limit
           ORDER BY task.item_index ASC
           LIMIT 1`,
        )
        .get(...allowedStatuses, now, now, now) as
        | { readonly task_id: string; readonly run_id: string }
        | undefined;

      if (candidate === undefined) {
        return null;
      }

      const leaseExpiresAt = new Date(
        input.now.getTime() + input.leaseDurationSeconds * 1000,
      ).toISOString();
      const updated = this.db
        .prepare(
          `UPDATE operator_tasks
           SET status = 'running',
               attempt_count = attempt_count + 1,
               lease_owner = ?,
               lease_expires_at = ?,
               next_retry_at = NULL,
               last_error_json = NULL
           WHERE task_id = ?
             AND (
               ${updateAllowedStatusSql}
               OR (
                 status = 'running'
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= ?
               )
             )
             AND (
               status <> 'retryable_failure'
               OR next_retry_at IS NULL
               OR next_retry_at <= ?
             )
             AND (
               SELECT COUNT(*)
               FROM operator_tasks AS active
               WHERE active.run_id = operator_tasks.run_id
                 AND active.status = 'running'
                 AND active.lease_expires_at IS NOT NULL
                 AND active.lease_expires_at > ?
             ) < (
               SELECT concurrency_limit
               FROM operator_runs
               WHERE run_id = operator_tasks.run_id
             )
           RETURNING ${TASK_COLUMNS}`,
        )
        .get(
          input.workerId,
          leaseExpiresAt,
          candidate.task_id,
          ...allowedStatuses,
          now,
          now,
          now,
        ) as OperatorTaskRow | undefined;

      if (updated === undefined) {
        return null;
      }

      this.refreshRunFromTasks(updated.run_id);
      return toStoredTask(updated);
    });
  }

  async recordTaskSuccess(input: {
    taskId: string;
    output: unknown;
    completedAt: ReturnType<typeof createTimestamp>;
    resultArtifactId?: StoredOperatorTask['resultArtifactId'];
  }): Promise<void> {
    withSavepoint(this.db, () => {
      const row = this.db
        .prepare(
          `UPDATE operator_tasks
           SET status = 'succeeded',
               lease_owner = NULL,
               lease_expires_at = NULL,
               next_retry_at = NULL,
               result_json = ?,
               result_artifact_id = ?,
               last_error_json = NULL,
               last_failure_at = NULL
           WHERE task_id = ?
           RETURNING run_id`,
        )
        .get(stringifySqliteJson(input.output), input.resultArtifactId ?? null, input.taskId) as
        | TaskRunIdRow
        | undefined;

      if (row === undefined) {
        throw new OperatorBootstrapStateError(
          input.taskId,
          `Operator task not found: ${input.taskId}`,
        );
      }

      this.refreshRunFromTasks(row.run_id);
      void input.completedAt;
    });
  }

  async recordTaskFailure(input: {
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'] extends infer T ? Exclude<T, undefined> : never;
    completedAt: ReturnType<typeof createTimestamp>;
  }): Promise<void> {
    withSavepoint(this.db, () => {
      const row = this.db
        .prepare(
          `UPDATE operator_tasks
           SET status = 'failed',
               lease_owner = NULL,
               lease_expires_at = NULL,
               next_retry_at = NULL,
               last_error_json = ?,
               last_failure_at = ?,
               result_json = NULL
           WHERE task_id = ?
           RETURNING run_id`,
        )
        .get(stringifySqliteJson(input.failure), input.completedAt.toISOString(), input.taskId) as
        | TaskRunIdRow
        | undefined;

      if (row === undefined) {
        throw new OperatorBootstrapStateError(
          input.taskId,
          `Operator task not found: ${input.taskId}`,
        );
      }

      this.refreshRunFromTasks(row.run_id);
    });
  }

  async markTaskRetryableFailure(input: {
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'] extends infer T ? Exclude<T, undefined> : never;
    nextRetryAt: ReturnType<typeof createTimestamp>;
  }): Promise<void> {
    withSavepoint(this.db, () => {
      const row = this.db
        .prepare(
          `UPDATE operator_tasks
           SET status = 'retryable_failure',
               lease_owner = NULL,
               lease_expires_at = NULL,
               next_retry_at = ?,
               last_error_json = ?,
               result_json = NULL
           WHERE task_id = ?
           RETURNING run_id`,
        )
        .get(input.nextRetryAt.toISOString(), stringifySqliteJson(input.failure), input.taskId) as
        | TaskRunIdRow
        | undefined;

      if (row === undefined) {
        throw new OperatorBootstrapStateError(
          input.taskId,
          `Operator task not found: ${input.taskId}`,
        );
      }

      this.refreshRunFromTasks(row.run_id);
    });
  }

  async assignTaskChildConversation(
    input: AssignTaskChildConversationInput,
  ): Promise<ConversationId> {
    const row = this.db
      .prepare(
        `UPDATE operator_tasks
         SET child_conversation_id = COALESCE(child_conversation_id, ?)
         WHERE task_id = ?
         RETURNING child_conversation_id`,
      )
      .get(input.childConversationId, input.taskId) as
      | { readonly child_conversation_id: string | null }
      | undefined;

    if (row === undefined || row.child_conversation_id === null) {
      throw new OperatorBootstrapStateError(
        input.taskId,
        `Operator task not found: ${input.taskId}`,
      );
    }

    return row.child_conversation_id as ConversationId;
  }

  async getTaskBootstrapState(taskId: string): Promise<StoredOperatorTask['bootstrapState']> {
    const row = this.db
      .prepare(
        `SELECT bootstrap_state
         FROM operator_tasks
         WHERE task_id = ?`,
      )
      .get(taskId) as
      | { readonly bootstrap_state: StoredOperatorTask['bootstrapState'] }
      | undefined;

    if (row === undefined) {
      throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
    }

    return row.bootstrap_state;
  }

  async markBootstrapStarted(taskId: string): Promise<void> {
    const row = this.db
      .prepare(
        `UPDATE operator_tasks
         SET bootstrap_state = CASE
           WHEN bootstrap_state = 'bootstrap_completed'
             THEN bootstrap_state
           ELSE 'bootstrap_in_progress'
         END
         WHERE task_id = ?
         RETURNING bootstrap_state`,
      )
      .get(taskId);

    if (row === undefined) {
      throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
    }
  }

  async markBootstrapCompleted(taskId: string): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE operator_tasks
         SET bootstrap_state = 'bootstrap_completed'
         WHERE task_id = ?`,
      )
      .run(taskId);

    if (result.changes === 0) {
      throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
    }
  }

  async claimRunForFinalizationRetry(
    input: ClaimRunForFinalizationRetryInput,
  ): Promise<StoredOperatorRun | null> {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM operator_runs
         WHERE needs_finalization_retry = 1
           AND finalization_stage <> 'completed'
         ORDER BY updated_at ASC, created_at ASC
         LIMIT 1`,
      )
      .get() as OperatorRunRow | undefined;

    void input.workerId;
    void input.now;
    return row === undefined ? null : toStoredRun(row);
  }

  async advanceFinalizationStage(
    input: AdvanceFinalizationStageInput,
  ): Promise<StoredOperatorRun['finalizationStage']> {
    return withSavepoint(this.db, () => {
      const run = this.getRunRow(input.runId);
      if (run === null) {
        throw new OperatorRunNotFoundError(input.runId);
      }

      if (run.finalization_stage === 'completed') {
        return 'completed';
      }

      if (run.finalization_stage !== input.from) {
        return run.finalization_stage;
      }

      const timestamp = nowIso();
      const row = this.db
        .prepare(
          `UPDATE operator_runs
           SET finalization_stage = ?,
               updated_at = ?,
               parent_handle_appended_at = CASE
                 WHEN ? = 'handle_appended'
                   THEN COALESCE(parent_handle_appended_at, ?)
                 ELSE parent_handle_appended_at
               END
           WHERE run_id = ?
           RETURNING finalization_stage`,
        )
        .get(input.to, timestamp, input.to, timestamp, input.runId) as
        | { readonly finalization_stage: StoredOperatorRun['finalizationStage'] }
        | undefined;

      return row?.finalization_stage ?? input.to;
    });
  }

  async finalizeRun(input: FinalizeRunInput): Promise<StoredOperatorRun> {
    return withSavepoint(this.db, () => {
      const run = this.getRunRow(input.runId);
      if (run === null) {
        throw new OperatorRunNotFoundError(input.runId);
      }

      if (run.finalization_stage === 'completed') {
        return toStoredRun(run);
      }

      if (
        run.finalization_stage === 'not_started' &&
        parseSqliteInteger(run.task_count, 'operator_runs.task_count') > 0
      ) {
        throw new OperatorFinalizationError(
          input.runId,
          'not_started',
          'Finalization must advance through stages before completion.',
        );
      }

      const refreshed = this.refreshRunFromTasks(input.runId);
      const row = this.db
        .prepare(
          `UPDATE operator_runs
           SET status = ?,
               completed_at = ?,
               output_artifact_id = ?,
               terminal_failure_summary_json = ?,
               finalization_stage = 'completed',
               needs_finalization_retry = 0,
               updated_at = ?
           WHERE run_id = ?
           RETURNING ${RUN_COLUMNS}`,
        )
        .get(
          input.status,
          input.completedAt.toISOString(),
          input.outputArtifactId ?? refreshed.outputArtifactId ?? null,
          stringifyOptionalFailure(
            input.terminalFailureSummary ?? refreshed.terminalFailureSummary,
          ),
          nowIso(),
          input.runId,
        ) as OperatorRunRow | undefined;

      if (row === undefined) {
        throw new OperatorRunNotFoundError(input.runId);
      }

      return toStoredRun(row);
    });
  }
}
