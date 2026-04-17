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
import { createTimestamp, type ArtifactId, type ConversationId } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';

import { mapPgError } from './errors';
import { toJsonObject, toTimestamp } from './sql';
import { withPgTransaction } from './transaction';
import { toRowCount, type PgExecutor, type PgPoolClientLike } from './types';

const OPERATOR_IDEMPOTENCY_UNIQUE_INDEX = 'idx_operator_runs_conversation_idempotency_key_unique';

interface OperatorRunRow {
  readonly run_id: string;
  readonly conversation_id: string;
  readonly operator_kind: StoredOperatorRun['operatorKind'];
  readonly status: StoredOperatorRun['status'];
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
  readonly completed_at: string | Date | null;
  readonly prompt: string | null;
  readonly task_prompt: string | null;
  readonly output_schema: unknown;
  readonly concurrency_limit: number;
  readonly retry_policy: unknown;
  readonly delegated_scope: unknown;
  readonly kept_work: unknown;
  readonly idempotency_key: string | null;
  readonly normalized_input_digest: string | null;
  readonly input_artifact_id: string | null;
  readonly output_artifact_id: string | null;
  readonly finalization_stage: StoredOperatorRun['finalizationStage'];
  readonly needs_finalization_retry: boolean;
  readonly parent_handle_appended_at: string | Date | null;
  readonly task_count: number;
  readonly succeeded_task_count: number;
  readonly failed_task_count: number;
  readonly retryable_failure_task_count: number;
  readonly running_task_count: number;
  readonly pending_task_count: number;
  readonly terminal_failure_summary: unknown;
}

interface OperatorTaskRow {
  readonly task_id: string;
  readonly run_id: string;
  readonly conversation_id: string;
  readonly item_index: number;
  readonly status: StoredOperatorTask['status'];
  readonly attempt_count: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | Date | null;
  readonly next_retry_at: string | Date | null;
  readonly child_conversation_id: string | null;
  readonly bootstrap_state: StoredOperatorTask['bootstrapState'];
  readonly result_artifact_id: string | null;
  readonly last_error: unknown;
}

const parseInteger = (value: number | string, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed)) {
    throw new InvariantViolationError(`Invalid ${fieldName} from PostgreSQL row.`);
  }

  return parsed;
};

const toRetryPolicy = (value: unknown): RetryPolicy => {
  const object = toJsonObject(value);
  return {
    maxRetries: Number(object.maxRetries ?? 0),
    retryBackoffSeconds: Number(object.retryBackoffSeconds ?? 0),
  };
};

const toFailureMetadata = (value: unknown): OperatorFailureMetadata | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const object = toJsonObject(value);
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

  const object = toJsonObject(value);
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

  if (messageIds === undefined && summaryIds === undefined && artifactIds === undefined && note === undefined) {
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

  const object = toJsonObject(value);
  const description = typeof object.description === 'string' ? object.description : undefined;
  const expectedOutput = typeof object.expectedOutput === 'string' ? object.expectedOutput : undefined;

  if (description === undefined || expectedOutput === undefined) {
    return undefined;
  }

  return {
    description,
    expectedOutput,
  };
};

const toStoredRun = (row: OperatorRunRow): StoredOperatorRun => {
  const delegatedScope = toDelegatedScope(row.delegated_scope);
  const keptWork = toKeptWork(row.kept_work);
  const terminalFailureSummary = toFailureMetadata(row.terminal_failure_summary);

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
    outputSchema: toJsonObject(row.output_schema),
    concurrencyLimit: row.concurrency_limit,
    retryPolicy: toRetryPolicy(row.retry_policy),
    ...(delegatedScope === undefined ? {} : { delegatedScope }),
    ...(keptWork === undefined ? {} : { keptWork }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.normalized_input_digest === null ? {} : { normalizedInputDigest: row.normalized_input_digest }),
    ...(row.input_artifact_id === null ? {} : { inputArtifactId: row.input_artifact_id as ArtifactId }),
    ...(row.output_artifact_id === null ? {} : { outputArtifactId: row.output_artifact_id as ArtifactId }),
    finalizationStage: row.finalization_stage,
    needsFinalizationRetry: row.needs_finalization_retry,
    ...(row.parent_handle_appended_at === null
      ? {}
      : { parentHandleAppendedAt: toTimestamp(row.parent_handle_appended_at) }),
    taskCount: row.task_count,
    succeededTaskCount: row.succeeded_task_count,
    failedTaskCount: row.failed_task_count,
    retryableFailureTaskCount: row.retryable_failure_task_count,
    runningTaskCount: row.running_task_count,
    pendingTaskCount: row.pending_task_count,
    ...(terminalFailureSummary === undefined ? {} : { terminalFailureSummary }),
  };
};

const toStoredTask = (row: OperatorTaskRow): StoredOperatorTask => {
  const terminalFailure = toFailureMetadata(row.last_error);

  return {
    taskId: row.task_id,
    runId: row.run_id,
    conversationId: row.conversation_id as ConversationId,
    itemIndex: row.item_index,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: toTimestamp(row.lease_expires_at) }),
    ...(row.next_retry_at === null ? {} : { nextRetryAt: toTimestamp(row.next_retry_at) }),
    ...(row.child_conversation_id === null
      ? {}
      : { childConversationId: row.child_conversation_id as ConversationId }),
    bootstrapState: row.bootstrap_state,
    ...(row.result_artifact_id === null ? {} : { resultArtifactId: row.result_artifact_id as ArtifactId }),
    ...(terminalFailure === undefined ? {} : { terminalFailure }),
  };
};

const isOperatorIdempotencyUniqueConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === OPERATOR_IDEMPOTENCY_UNIQUE_INDEX;
};

const RUN_COLUMNS = `run_id,
       conversation_id,
       operator_kind,
       status,
       created_at,
       updated_at,
       completed_at,
       prompt,
       task_prompt,
       output_schema,
       concurrency_limit,
       retry_policy,
       delegated_scope,
       kept_work,
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
       terminal_failure_summary`;

const RUN_COLUMNS_FOR_ALIAS = (alias: string) => `${alias}.run_id AS run_id,
       ${alias}.conversation_id AS conversation_id,
       ${alias}.operator_kind AS operator_kind,
       ${alias}.status AS status,
       ${alias}.created_at AS created_at,
       ${alias}.updated_at AS updated_at,
       ${alias}.completed_at AS completed_at,
       ${alias}.prompt AS prompt,
       ${alias}.task_prompt AS task_prompt,
       ${alias}.output_schema AS output_schema,
       ${alias}.concurrency_limit AS concurrency_limit,
       ${alias}.retry_policy AS retry_policy,
       ${alias}.delegated_scope AS delegated_scope,
       ${alias}.kept_work AS kept_work,
       ${alias}.idempotency_key AS idempotency_key,
       ${alias}.normalized_input_digest AS normalized_input_digest,
       ${alias}.input_artifact_id AS input_artifact_id,
       ${alias}.output_artifact_id AS output_artifact_id,
       ${alias}.finalization_stage AS finalization_stage,
       ${alias}.needs_finalization_retry AS needs_finalization_retry,
       ${alias}.parent_handle_appended_at AS parent_handle_appended_at,
       ${alias}.task_count AS task_count,
       ${alias}.succeeded_task_count AS succeeded_task_count,
       ${alias}.failed_task_count AS failed_task_count,
       ${alias}.retryable_failure_task_count AS retryable_failure_task_count,
       ${alias}.running_task_count AS running_task_count,
       ${alias}.pending_task_count AS pending_task_count,
       ${alias}.terminal_failure_summary AS terminal_failure_summary`;

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
       result_artifact_id,
       last_error`;

const TASK_COLUMNS_FOR_ALIAS = (alias: string) => `${alias}.task_id AS task_id,
       ${alias}.run_id AS run_id,
       ${alias}.conversation_id AS conversation_id,
       ${alias}.item_index AS item_index,
       ${alias}.status AS status,
       ${alias}.attempt_count AS attempt_count,
       ${alias}.lease_owner AS lease_owner,
       ${alias}.lease_expires_at AS lease_expires_at,
       ${alias}.next_retry_at AS next_retry_at,
       ${alias}.child_conversation_id AS child_conversation_id,
       ${alias}.bootstrap_state AS bootstrap_state,
       ${alias}.result_artifact_id AS result_artifact_id,
       ${alias}.last_error AS last_error`;

export class PgOperatorExecutionStore implements OperatorExecutionPort {
  constructor(private readonly executor: PgExecutor) {}

  private async getRunRow(client: PgPoolClientLike, runId: string): Promise<OperatorRunRow | null> {
    const result = await client.query<OperatorRunRow>(
      `SELECT ${RUN_COLUMNS}
       FROM operator_runs
       WHERE run_id = $1`,
      [runId],
    );

    return result.rows[0] ?? null;
  }

  private async getTaskRow(client: PgPoolClientLike, taskId: string): Promise<OperatorTaskRow | null> {
    const result = await client.query<OperatorTaskRow>(
      `SELECT ${TASK_COLUMNS}
       FROM operator_tasks
       WHERE task_id = $1`,
      [taskId],
    );

    return result.rows[0] ?? null;
  }

  private async lookupRunByIdempotencyKeyRow(
    client: PgPoolClientLike,
    conversationId: ConversationId,
    idempotencyKey: string,
  ): Promise<OperatorRunRow | null> {
    const result = await client.query<OperatorRunRow>(
      `SELECT ${RUN_COLUMNS}
       FROM operator_runs
       WHERE conversation_id = $1
         AND idempotency_key = $2`,
      [conversationId, idempotencyKey],
    );

    return result.rows[0] ?? null;
  }

  private async refreshRunFromTasks(client: PgPoolClientLike, runId: string): Promise<StoredOperatorRun> {
    const result = await client.query<OperatorRunRow>(
      `WITH counts AS (
         SELECT
           run_id,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_task_count,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running_task_count,
           COUNT(*) FILTER (WHERE status = 'retryable_failure')::int AS retryable_failure_task_count,
           COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_task_count,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_task_count
         FROM operator_tasks
         WHERE run_id = $1
         GROUP BY run_id
       ),
       failure AS (
         SELECT last_error
         FROM operator_tasks
         WHERE run_id = $1
           AND status = 'failed'
           AND last_error IS NOT NULL
         ORDER BY item_index ASC
         LIMIT 1
       )
       UPDATE operator_runs AS runs
       SET pending_task_count = counts.pending_task_count,
           running_task_count = counts.running_task_count,
           retryable_failure_task_count = counts.retryable_failure_task_count,
           succeeded_task_count = counts.succeeded_task_count,
           failed_task_count = counts.failed_task_count,
           status = CASE
             WHEN counts.running_task_count > 0 THEN 'running'::operator_run_status
             WHEN counts.failed_task_count > 0
               AND counts.succeeded_task_count = 0
               AND counts.pending_task_count = 0
               AND counts.retryable_failure_task_count = 0 THEN 'failed'::operator_run_status
             WHEN counts.failed_task_count > 0 THEN 'completed_with_failures'::operator_run_status
             WHEN counts.succeeded_task_count = runs.task_count THEN 'completed'::operator_run_status
             ELSE 'pending'::operator_run_status
           END,
           terminal_failure_summary = COALESCE((SELECT last_error FROM failure), runs.terminal_failure_summary),
           updated_at = now()
       FROM counts
       WHERE runs.run_id = counts.run_id
       RETURNING ${RUN_COLUMNS_FOR_ALIAS('runs')}`,
      [runId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new OperatorRunNotFoundError(runId);
    }

    return toStoredRun(row);
  }

  async createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun> {
    try {
      return await withPgTransaction(this.executor, async (client) => {
        const existingForKey =
          input.idempotencyKey === undefined
            ? null
            : await this.lookupRunByIdempotencyKeyRow(client, input.conversationId, input.idempotencyKey);

        if (existingForKey !== null) {
          const existing: StoredOperatorRun = toStoredRun(existingForKey);
          if (existing.normalizedInputDigest !== input.normalizedInputDigest) {
            throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey as string);
          }

          return existing;
        }

        try {
          const inserted = await client.query<OperatorRunRow>(
            `INSERT INTO operator_runs (
              run_id,
              conversation_id,
              operator_kind,
              status,
              completed_at,
              prompt,
              task_prompt,
              output_schema,
              concurrency_limit,
              retry_policy,
              delegated_scope,
              kept_work,
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
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8::jsonb,
              $9,
              $10::jsonb,
              $11::jsonb,
              $12::jsonb,
              $13,
              $14,
              $15,
              $16,
              FALSE,
              $17,
              0,
              0,
              0,
              0,
              $18
            )
            RETURNING ${RUN_COLUMNS}`,
            [
              input.runId,
              input.conversationId,
              input.operatorKind,
              input.taskCount === 0 ? 'completed' : 'pending',
              input.taskCount === 0 ? new Date() : null,
              input.prompt ?? null,
              input.taskPrompt ?? null,
              JSON.stringify(input.outputSchema),
              input.concurrencyLimit,
              JSON.stringify(input.retryPolicy),
              input.delegatedScope === undefined ? null : JSON.stringify(input.delegatedScope),
              input.keptWork === undefined ? null : JSON.stringify(input.keptWork),
              input.idempotencyKey ?? null,
              input.normalizedInputDigest ?? null,
              input.inputArtifactId ?? null,
              input.taskCount === 0 ? 'completed' : 'not_started',
              input.taskCount,
              input.taskCount,
            ],
          );

          const row = inserted.rows[0];
          if (row === undefined) {
            throw new InvariantViolationError('Failed to insert operator run.');
          }

          if (input.taskCount > 0) {
            await client.query(
              `INSERT INTO operator_tasks (
                task_id,
                run_id,
                conversation_id,
                item_index,
                status,
                attempt_count,
                bootstrap_state
              )
              SELECT
                $1 || ':task:' || LPAD(series.item_index::text, 4, '0'),
                $1,
                $2,
                series.item_index,
                'pending'::operator_task_status,
                0,
                'bootstrap_not_started'::operator_bootstrap_state
              FROM generate_series(0, $3 - 1) AS series(item_index)`,
              [input.runId, input.conversationId, input.taskCount],
            );
          }

          return toStoredRun(row);
        } catch (error) {
          if (input.idempotencyKey !== undefined && isOperatorIdempotencyUniqueConflict(error)) {
            const existingRow = await this.lookupRunByIdempotencyKeyRow(
              client,
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

          mapPgError(error);
        }

        throw new InvariantViolationError('Unexpected operator run creation fallthrough.');
      });
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getRun(runId: string): Promise<StoredOperatorRun | null> {
    try {
      const result = await this.executor.query<OperatorRunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM operator_runs
         WHERE run_id = $1`,
        [runId],
      );

      const row = result.rows[0];
      return row === undefined ? null : toStoredRun(row);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getTask(taskId: string): Promise<StoredOperatorTask | null> {
    try {
      const result = await this.executor.query<OperatorTaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM operator_tasks
         WHERE task_id = $1`,
        [taskId],
      );

      const row = result.rows[0];
      return row === undefined ? null : toStoredTask(row);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async listTasksForRun(runId: string): Promise<readonly StoredOperatorTask[]> {
    try {
      const result = await this.executor.query<OperatorTaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM operator_tasks
         WHERE run_id = $1
         ORDER BY item_index ASC`,
        [runId],
      );

      return result.rows.map((row) => toStoredTask(row));
    } catch (error) {
      return mapPgError(error);
    }
  }

  async lookupRunByIdempotencyKey(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): Promise<StoredOperatorRun | null> {
    try {
      const result = await this.executor.query<OperatorRunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM operator_runs
         WHERE conversation_id = $1
           AND idempotency_key = $2`,
        [conversationId, idempotencyKey],
      );

      const row = result.rows[0];
      return row === undefined ? null : toStoredRun(row);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async claimTaskLease(input: ClaimTaskLeaseInput): Promise<StoredOperatorTask | null> {
    try {
      return await withPgTransaction(this.executor, async (client) => {
        const allowedStatuses = input.allowedStatuses ?? ['pending', 'retryable_failure'];
        const result = await client.query<OperatorTaskRow>(
          `WITH candidate AS (
             SELECT task.task_id, task.run_id
             FROM operator_tasks AS task
             JOIN operator_runs AS run ON run.run_id = task.run_id
             WHERE (
                 task.status = ANY($1::operator_task_status[])
                 OR (
                   task.status = 'running'::operator_task_status
                   AND task.lease_expires_at IS NOT NULL
                   AND task.lease_expires_at <= $2
                 )
               )
               AND (
                 task.status <> 'retryable_failure'::operator_task_status
                 OR task.next_retry_at IS NULL
                 OR task.next_retry_at <= $2
               )
               AND (
                 SELECT COUNT(*)
                 FROM operator_tasks AS active
                 WHERE active.run_id = task.run_id
                   AND active.status = 'running'::operator_task_status
                   AND active.lease_expires_at IS NOT NULL
                   AND active.lease_expires_at > $2
               ) < run.concurrency_limit
             ORDER BY task.item_index ASC
             FOR UPDATE OF run, task SKIP LOCKED
             LIMIT 1
           ),
           updated AS (
             UPDATE operator_tasks AS task
             SET status = 'running'::operator_task_status,
                 attempt_count = task.attempt_count + 1,
                 lease_owner = $3,
                 lease_expires_at = $2 + ($4 * interval '1 second'),
                 next_retry_at = NULL,
                 last_error = NULL
             FROM candidate
             WHERE task.task_id = candidate.task_id
             RETURNING ${TASK_COLUMNS_FOR_ALIAS('task')}
           )
           SELECT ${TASK_COLUMNS}
           FROM updated`,
          [allowedStatuses, input.now, input.workerId, input.leaseDurationSeconds],
        );

        const row = result.rows[0];
        if (row === undefined) {
          return null;
        }

        await this.refreshRunFromTasks(client, row.run_id);
        return toStoredTask(row);
      });
    } catch (error) {
      return mapPgError(error);
    }
  }

  async recordTaskSuccess(input: {
    taskId: string;
    output: unknown;
    completedAt: ReturnType<typeof createTimestamp>;
    resultArtifactId?: StoredOperatorTask['resultArtifactId'];
  }): Promise<void> {
    try {
      await withPgTransaction(this.executor, async (client) => {
        const updated = await client.query<Pick<OperatorTaskRow, 'run_id'>>(
          `UPDATE operator_tasks
           SET status = 'succeeded'::operator_task_status,
               lease_owner = NULL,
               lease_expires_at = NULL,
               next_retry_at = NULL,
               result_json = $2::jsonb,
               result_artifact_id = $3,
               last_error = NULL,
               last_failure_at = NULL
           WHERE task_id = $1
           RETURNING run_id`,
          [input.taskId, JSON.stringify(input.output), input.resultArtifactId ?? null],
        );

        const row = updated.rows[0];
        if (row === undefined) {
          throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
        }

        await this.refreshRunFromTasks(client, row.run_id);
        void input.completedAt;
      });
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async recordTaskFailure(input: {
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'] extends infer T ? Exclude<T, undefined> : never;
    completedAt: ReturnType<typeof createTimestamp>;
  }): Promise<void> {
    try {
      await withPgTransaction(this.executor, async (client) => {
        const updated = await client.query<Pick<OperatorTaskRow, 'run_id'>>(
          `UPDATE operator_tasks
           SET status = 'failed'::operator_task_status,
               lease_owner = NULL,
               lease_expires_at = NULL,
               next_retry_at = NULL,
               last_error = $2::jsonb,
               last_failure_at = $3,
               result_json = NULL
           WHERE task_id = $1
           RETURNING run_id`,
          [input.taskId, JSON.stringify(input.failure), input.completedAt],
        );

        const row = updated.rows[0];
        if (row === undefined) {
          throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
        }

        await this.refreshRunFromTasks(client, row.run_id);
      });
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async markTaskRetryableFailure(input: {
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'] extends infer T ? Exclude<T, undefined> : never;
    nextRetryAt: ReturnType<typeof createTimestamp>;
  }): Promise<void> {
    try {
      await withPgTransaction(this.executor, async (client) => {
        const updated = await client.query<Pick<OperatorTaskRow, 'run_id'>>(
          `UPDATE operator_tasks
           SET status = 'retryable_failure'::operator_task_status,
               lease_owner = NULL,
               lease_expires_at = NULL,
               next_retry_at = $3,
               last_error = $2::jsonb,
               result_json = NULL
           WHERE task_id = $1
           RETURNING run_id`,
          [input.taskId, JSON.stringify(input.failure), input.nextRetryAt],
        );

        const row = updated.rows[0];
        if (row === undefined) {
          throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
        }

        await this.refreshRunFromTasks(client, row.run_id);
      });
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async assignTaskChildConversation(input: AssignTaskChildConversationInput): Promise<ConversationId> {
    try {
      const result = await this.executor.query<Pick<OperatorTaskRow, 'child_conversation_id'>>(
        `UPDATE operator_tasks
         SET child_conversation_id = COALESCE(child_conversation_id, $2)
         WHERE task_id = $1
         RETURNING child_conversation_id`,
        [input.taskId, input.childConversationId],
      );

      const row = result.rows[0];
      if (row === undefined || row.child_conversation_id === null) {
        throw new OperatorBootstrapStateError(input.taskId, `Operator task not found: ${input.taskId}`);
      }

      return row.child_conversation_id as ConversationId;
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async getTaskBootstrapState(taskId: string): Promise<StoredOperatorTask['bootstrapState']> {
    try {
      const result = await this.executor.query<Pick<OperatorTaskRow, 'bootstrap_state'>>(
        `SELECT bootstrap_state
         FROM operator_tasks
         WHERE task_id = $1`,
        [taskId],
      );

      const row = result.rows[0];
      if (row === undefined) {
        throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
      }

      return row.bootstrap_state;
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async markBootstrapStarted(taskId: string): Promise<void> {
    try {
      const result = await this.executor.query<Pick<OperatorTaskRow, 'bootstrap_state'>>(
        `UPDATE operator_tasks
         SET bootstrap_state = CASE
           WHEN bootstrap_state = 'bootstrap_completed'::operator_bootstrap_state
             THEN bootstrap_state
           ELSE 'bootstrap_in_progress'::operator_bootstrap_state
         END
         WHERE task_id = $1
         RETURNING bootstrap_state`,
        [taskId],
      );

      if (result.rows[0] === undefined) {
        throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
      }
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async markBootstrapCompleted(taskId: string): Promise<void> {
    try {
      const result = await this.executor.query(
        `UPDATE operator_tasks
         SET bootstrap_state = 'bootstrap_completed'::operator_bootstrap_state
         WHERE task_id = $1`,
        [taskId],
      );

      if (toRowCount(result.rowCount) === 0) {
        throw new OperatorBootstrapStateError(taskId, `Operator task not found: ${taskId}`);
      }
    } catch (error) {
      if (error instanceof OperatorBootstrapStateError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async claimRunForFinalizationRetry(input: ClaimRunForFinalizationRetryInput): Promise<StoredOperatorRun | null> {
    try {
      const result = await this.executor.query<OperatorRunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM operator_runs
         WHERE needs_finalization_retry = TRUE
           AND finalization_stage <> 'completed'::operator_finalization_stage
         ORDER BY updated_at ASC, created_at ASC
         LIMIT 1`,
        [],
      );

      void input.workerId;
      void input.now;
      const row = result.rows[0];
      return row === undefined ? null : toStoredRun(row);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async advanceFinalizationStage(input: AdvanceFinalizationStageInput): Promise<StoredOperatorRun['finalizationStage']> {
    try {
      return await withPgTransaction(this.executor, async (client) => {
        const run = await this.getRunRow(client, input.runId);
        if (run === null) {
          throw new OperatorRunNotFoundError(input.runId);
        }

        if (run.finalization_stage === 'completed') {
          return 'completed';
        }

        if (run.finalization_stage !== input.from) {
          return run.finalization_stage;
        }

        const updated = await client.query<Pick<OperatorRunRow, 'finalization_stage'>>(
          `UPDATE operator_runs
           SET finalization_stage = $2,
               updated_at = now(),
               parent_handle_appended_at = CASE
                 WHEN $2 = 'handle_appended'::operator_finalization_stage
                   THEN COALESCE(parent_handle_appended_at, now())
                 ELSE parent_handle_appended_at
               END
           WHERE run_id = $1
           RETURNING finalization_stage`,
          [input.runId, input.to],
        );

        return updated.rows[0]?.finalization_stage ?? input.to;
      });
    } catch (error) {
      if (error instanceof OperatorRunNotFoundError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async finalizeRun(input: FinalizeRunInput): Promise<StoredOperatorRun> {
    try {
      return await withPgTransaction(this.executor, async (client) => {
        const run = await this.getRunRow(client, input.runId);
        if (run === null) {
          throw new OperatorRunNotFoundError(input.runId);
        }

        if (run.finalization_stage === 'completed') {
          return toStoredRun(run);
        }

        if (run.finalization_stage === 'not_started') {
          throw new OperatorFinalizationError(
            input.runId,
            'not_started',
            'Finalization must advance through stages before completion.',
          );
        }

        const refreshed = await this.refreshRunFromTasks(client, input.runId);
        const updated = await client.query<OperatorRunRow>(
          `UPDATE operator_runs
           SET status = $2,
               completed_at = $3,
               output_artifact_id = $4,
               terminal_failure_summary = $5::jsonb,
               finalization_stage = 'completed'::operator_finalization_stage,
               needs_finalization_retry = FALSE,
               updated_at = now()
           WHERE run_id = $1
           RETURNING ${RUN_COLUMNS}`,
          [
            input.runId,
            input.status,
            input.completedAt,
            input.outputArtifactId ?? refreshed.outputArtifactId ?? null,
            JSON.stringify(input.terminalFailureSummary ?? refreshed.terminalFailureSummary ?? null),
          ],
        );

        const row = updated.rows[0];
        if (row === undefined) {
          throw new OperatorRunNotFoundError(input.runId);
        }

        return toStoredRun(row);
      });
    } catch (error) {
      if (error instanceof OperatorRunNotFoundError || error instanceof OperatorFinalizationError) {
        throw error;
      }

      return mapPgError(error);
    }
  }
}
