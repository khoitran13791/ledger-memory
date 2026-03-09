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
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  ON summary_nodes USING GIN (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_context_items_conv
  ON context_items(conversation_id, position);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv
  ON artifacts(conversation_id);
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
