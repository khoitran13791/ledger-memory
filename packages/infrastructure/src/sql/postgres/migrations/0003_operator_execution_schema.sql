-- Up Migration

BEGIN;

DO $$
BEGIN
  CREATE TYPE operator_run_status AS ENUM (
    'pending',
    'running',
    'completed',
    'completed_with_failures',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE operator_kind AS ENUM ('llmMap', 'agenticMap');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE operator_task_status AS ENUM (
    'pending',
    'running',
    'retryable_failure',
    'succeeded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE operator_bootstrap_state AS ENUM (
    'bootstrap_not_started',
    'bootstrap_in_progress',
    'bootstrap_completed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE operator_finalization_stage AS ENUM (
    'not_started',
    'artifact_written',
    'handle_appended',
    'completed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS operator_runs (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operator_kind operator_kind NOT NULL,
  status operator_run_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  prompt TEXT,
  task_prompt TEXT,
  output_schema JSONB NOT NULL,
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit > 0),
  retry_policy JSONB NOT NULL,
  delegated_scope JSONB,
  kept_work JSONB,
  idempotency_key TEXT,
  normalized_input_digest TEXT,
  input_artifact_id TEXT,
  output_artifact_id TEXT,
  finalization_stage operator_finalization_stage NOT NULL,
  needs_finalization_retry BOOLEAN NOT NULL DEFAULT FALSE,
  parent_handle_appended_at TIMESTAMPTZ,
  task_count INTEGER NOT NULL CHECK (task_count >= 0),
  succeeded_task_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_task_count >= 0),
  failed_task_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_task_count >= 0),
  retryable_failure_task_count INTEGER NOT NULL DEFAULT 0 CHECK (retryable_failure_task_count >= 0),
  running_task_count INTEGER NOT NULL DEFAULT 0 CHECK (running_task_count >= 0),
  pending_task_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_task_count >= 0),
  terminal_failure_summary JSONB,
  CHECK ((prompt IS NOT NULL) <> (task_prompt IS NOT NULL)),
  CHECK (
    succeeded_task_count + failed_task_count + retryable_failure_task_count + running_task_count + pending_task_count = task_count
  )
);

CREATE TABLE IF NOT EXISTS operator_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES operator_runs(run_id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  status operator_task_status NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  child_conversation_id TEXT,
  bootstrap_state operator_bootstrap_state NOT NULL,
  result_json JSONB,
  result_artifact_id TEXT,
  last_error JSONB,
  last_failure_at TIMESTAMPTZ,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  UNIQUE (run_id, item_index)
);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS operator_tasks;
DROP TABLE IF EXISTS operator_runs;

DROP TYPE IF EXISTS operator_finalization_stage;
DROP TYPE IF EXISTS operator_bootstrap_state;
DROP TYPE IF EXISTS operator_task_status;
DROP TYPE IF EXISTS operator_kind;
DROP TYPE IF EXISTS operator_run_status;

COMMIT;
