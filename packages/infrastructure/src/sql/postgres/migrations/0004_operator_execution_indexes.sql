-- Up Migration

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_runs_conversation_idempotency_key_unique
  ON operator_runs(conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operator_tasks_claimable
  ON operator_tasks(status, next_retry_at, lease_expires_at, run_id, item_index);

CREATE INDEX IF NOT EXISTS idx_operator_runs_finalization_retry
  ON operator_runs(needs_finalization_retry, status, updated_at)
  WHERE needs_finalization_retry = TRUE;

CREATE INDEX IF NOT EXISTS idx_operator_tasks_run_item_index
  ON operator_tasks(run_id, item_index);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_operator_tasks_run_item_index;
DROP INDEX IF EXISTS idx_operator_runs_finalization_retry;
DROP INDEX IF EXISTS idx_operator_tasks_claimable;
DROP INDEX IF EXISTS idx_operator_runs_conversation_idempotency_key_unique;

COMMIT;
