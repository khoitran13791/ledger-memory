import { randomUUID } from 'node:crypto';

import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  type ConversationId,
} from '@ledgermind/domain';
import { Pool, type PoolClient } from 'pg';

import { PgArtifactStore } from '../pg-artifact-store';
import { PgContextProjection } from '../pg-context-projection';
import { PgConversationStore } from '../pg-conversation-store';
import { PgLedgerStore } from '../pg-ledger-store';
import { PgOperatorExecutionStore } from '../pg-operator-execution-store';
import { PgSummaryDag } from '../pg-summary-dag';
import { createPgUnitOfWork } from '../pg-unit-of-work';
import { asPgExecutor, type PgExecutor } from '../types';

const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const SCHEMA_SQL = `
DO $$
BEGIN
  CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE summary_kind AS ENUM ('leaf', 'condensed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE storage_kind AS ENUM ('path', 'inline_text', 'inline_binary');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES conversations(id),
  model_name TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  soft_threshold REAL NOT NULL,
  hard_threshold REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (soft_threshold < hard_threshold)
);

CREATE TABLE IF NOT EXISTS ledger_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  role message_role NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS summary_nodes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind summary_kind NOT NULL,
  content TEXT NOT NULL,
  retrieval_text TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retrieval_text_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', retrieval_text)) STORED
);

CREATE TABLE IF NOT EXISTS summary_message_edges (
  summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (summary_id, message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_message_edges_summary_ord
  ON summary_message_edges(summary_id, ord);

CREATE TABLE IF NOT EXISTS summary_parent_edges (
  summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (summary_id, parent_summary_id),
  CHECK (summary_id <> parent_summary_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_parent_edges_summary_ord
  ON summary_parent_edges(summary_id, ord);

CREATE TABLE IF NOT EXISTS context_items (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  message_id TEXT REFERENCES ledger_events(id) ON DELETE RESTRICT,
  summary_id TEXT REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  PRIMARY KEY (conversation_id, position),
  CONSTRAINT context_items_exactly_one_ref CHECK (
    (message_id IS NOT NULL) <> (summary_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS context_versions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  storage_kind storage_kind NOT NULL,
  original_path TEXT,
  mime_type TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  exploration_summary TEXT,
  explorer_used TEXT,
  content_text TEXT,
  content_binary BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      storage_kind = 'path'
      AND original_path IS NOT NULL
      AND content_text IS NULL
      AND content_binary IS NOT NULL
    )
    OR (
      storage_kind = 'inline_text'
      AND original_path IS NULL
      AND content_text IS NOT NULL
      AND content_binary IS NULL
    )
    OR (
      storage_kind = 'inline_binary'
      AND original_path IS NULL
      AND content_text IS NULL
      AND content_binary IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_events_conv_seq
  ON ledger_events(conversation_id, seq);

CREATE INDEX IF NOT EXISTS idx_ledger_events_tsv
  ON ledger_events USING GIN(content_tsv);

CREATE INDEX IF NOT EXISTS idx_summary_nodes_conv
  ON summary_nodes(conversation_id);

CREATE INDEX IF NOT EXISTS idx_summary_nodes_tsv
  ON summary_nodes USING GIN (retrieval_text_tsv);

CREATE INDEX IF NOT EXISTS idx_context_items_conv
  ON context_items(conversation_id, position);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv
  ON artifacts(conversation_id);

DO $$
BEGIN
  CREATE TYPE operator_run_status AS ENUM ('pending', 'running', 'completed', 'completed_with_failures', 'failed');
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
  CREATE TYPE operator_task_status AS ENUM ('pending', 'running', 'retryable_failure', 'succeeded', 'failed');
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
  CREATE TYPE operator_finalization_stage AS ENUM ('not_started', 'artifact_written', 'handle_appended', 'completed');
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
`;

const createDefaultConversationConfig = () => {
  return createConversationConfig({
    modelName: 'test-model',
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });
};

export interface PostgresTestHarness {
  readonly pool: Pool;
  readonly schemaName: string;
  readonly conversationId: ConversationId;
  readonly ledger: PgLedgerStore;
  readonly context: PgContextProjection;
  readonly dag: PgSummaryDag;
  readonly artifacts: PgArtifactStore;
  readonly conversations: PgConversationStore;
  readonly operators: PgOperatorExecutionStore;
  readonly unitOfWork: ReturnType<typeof createPgUnitOfWork>;
  withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

const quoteIdentifier = (value: string): string => {
  return `"${value.replaceAll('"', '""')}"`;
};

export const createPostgresTestHarness = async (): Promise<PostgresTestHarness> => {
  const connectionString = process.env.LEDGERMIND_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const pool = new Pool({ connectionString });
  const schemaName = `lm_${randomUUID().replaceAll('-', '_')}`;

  const adminClient = await pool.connect();

  try {
    await adminClient.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await adminClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await adminClient.query(SCHEMA_SQL);
  } catch (error) {
    adminClient.release();
    await pool.end();
    throw error;
  }

  adminClient.release();

  const executor: PgExecutor = {
    query: async <Row extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
      const client = await pool.connect();

      try {
        await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
        const result = await client.query<Row>(text, params as unknown[] | undefined);
        return {
          rows: result.rows,
          rowCount: result.rowCount,
        };
      } finally {
        client.release();
      }
    },
    connect: async () => {
      const client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

      return {
        query: async <Row extends object = Record<string, unknown>>(
          text: string,
          params?: readonly unknown[],
        ) => {
          const result = await client.query<Row>(text, params as unknown[] | undefined);
          return {
            rows: result.rows,
            rowCount: result.rowCount,
          };
        },
        release: () => {
          client.release();
        },
      };
    },
  };

  const conversationStore = new PgConversationStore(executor);
  const conversation = await conversationStore.create(createDefaultConversationConfig());

  return {
    pool,
    schemaName,
    conversationId: conversation.id,
    ledger: new PgLedgerStore(executor),
    context: new PgContextProjection(executor),
    dag: new PgSummaryDag(executor),
    artifacts: new PgArtifactStore(executor),
    conversations: conversationStore,
    operators: new PgOperatorExecutionStore(executor),
    unitOfWork: createPgUnitOfWork(executor),
    withClient: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();

      try {
        await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
        return await work(client);
      } finally {
        client.release();
      }
    },
    destroy: async (): Promise<void> => {
      const cleanupClient = await pool.connect();

      try {
        await cleanupClient.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      } finally {
        cleanupClient.release();
      }

      await pool.end();
    },
  };
};

export const createExecutorForClient = (client: PoolClient): PgExecutor => {
  return asPgExecutor(client);
};
