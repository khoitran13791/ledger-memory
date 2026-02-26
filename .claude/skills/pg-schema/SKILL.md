---
name: pg-schema
description: PostgreSQL schema definitions, constraints, indexes, custom types, migration conventions (node-pg-migrate), and transaction safety rules for LedgerMind.
disable-model-invocation: true
---

# PostgreSQL Schema & Migrations

## Custom Types

```sql
CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
CREATE TYPE summary_kind AS ENUM ('leaf', 'condensed');
CREATE TYPE storage_kind AS ENUM ('path', 'inline_text', 'inline_binary');
```

## Tables

### conversations
```sql
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES conversations(id),
  model_name      TEXT NOT NULL,
  context_window  INTEGER NOT NULL CHECK (context_window > 0),
  threshold_soft  REAL NOT NULL,
  threshold_hard  REAL NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (threshold_soft < threshold_hard)
);
```

### ledger_events (append-only)
```sql
CREATE TABLE ledger_events (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  role            message_role NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL CHECK (token_count >= 0),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, idempotency_key)
);
```

### summary_nodes
```sql
CREATE TABLE summary_nodes (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            summary_kind NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL CHECK (token_count >= 0),
  artifact_ids    JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### summary_message_edges + summary_parent_edges
```sql
CREATE TABLE summary_message_edges (
  summary_id  TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE CASCADE,
  edge_order  INTEGER NOT NULL,
  PRIMARY KEY (summary_id, message_id)
);

CREATE TABLE summary_parent_edges (
  summary_id        TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  edge_order        INTEGER NOT NULL,
  PRIMARY KEY (summary_id, parent_summary_id)
);
```

### context_items + context_versions
```sql
CREATE TABLE context_items (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  message_id      TEXT REFERENCES ledger_events(id),
  summary_id      TEXT REFERENCES summary_nodes(id),
  PRIMARY KEY (conversation_id, position),
  CHECK ((message_id IS NOT NULL) != (summary_id IS NOT NULL))
);

CREATE TABLE context_versions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version         BIGINT NOT NULL DEFAULT 0
);
```

### artifacts
```sql
CREATE TABLE artifacts (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  storage_kind         storage_kind NOT NULL,
  original_path        TEXT,
  mime_type            TEXT NOT NULL,
  token_count          INTEGER NOT NULL CHECK (token_count >= 0),
  exploration_summary  TEXT,
  explorer_used        TEXT,
  content_text         TEXT,
  content_binary       BYTEA
);
```

## Key Indexes
```sql
CREATE INDEX idx_ledger_events_conv_seq ON ledger_events(conversation_id, seq);
CREATE INDEX idx_ledger_events_tsv ON ledger_events USING GIN(content_tsv);
CREATE INDEX idx_summary_nodes_conv ON summary_nodes(conversation_id);
CREATE INDEX idx_context_items_conv ON context_items(conversation_id, position);
CREATE INDEX idx_artifacts_conv ON artifacts(conversation_id);
```

## Migration Conventions (node-pg-migrate)

- Location: `packages/infrastructure/migrations/`
- Naming: `NNNN_description.sql` (sequential)
- All migrations must be idempotent (running twice doesn't error)
- Use `IF NOT EXISTS` for CREATE statements in up migrations
- Always provide down migrations

## Transaction Safety

- Partial DAG writes (orphan edges) must NEVER persist
- Use `BEGIN/COMMIT/ROLLBACK` via UnitOfWorkPort
- Version check + context mutation must be atomic
- Use parameterized queries only (never string interpolation)
