-- Up Migration

BEGIN;

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

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS context_versions;
DROP TABLE IF EXISTS context_items;
DROP INDEX IF EXISTS idx_summary_parent_edges_summary_ord;
DROP TABLE IF EXISTS summary_parent_edges;
DROP INDEX IF EXISTS idx_summary_message_edges_summary_ord;
DROP TABLE IF EXISTS summary_message_edges;
DROP TABLE IF EXISTS summary_nodes;
DROP TABLE IF EXISTS ledger_events;
DROP TABLE IF EXISTS conversations;

DROP TYPE IF EXISTS storage_kind;
DROP TYPE IF EXISTS summary_kind;
DROP TYPE IF EXISTS message_role;

COMMIT;
