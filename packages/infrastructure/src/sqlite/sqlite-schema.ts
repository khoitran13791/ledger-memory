export const SQLITE_SCHEMA_VERSION = 1;
export const SQLITE_TEXT_SEARCH_MODE = 'mirror-table' as const;

export const SQLITE_SCHEMA_SQL = [
  `PRAGMA foreign_keys = ON`,
  `PRAGMA journal_mode = WAL`,
  `PRAGMA busy_timeout = 5000`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES conversations(id),
    model_name TEXT NOT NULL,
    context_window INTEGER NOT NULL CHECK (context_window > 0),
    soft_threshold REAL NOT NULL,
    hard_threshold REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (soft_threshold < hard_threshold)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS ledger_events (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    occurred_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT,
    idempotency_digest TEXT,
    UNIQUE (conversation_id, seq),
    UNIQUE (conversation_id, idempotency_key)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_ledger_events_conv_seq
    ON ledger_events(conversation_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_ledger_events_continuity_kind
    ON ledger_events(conversation_id, json_extract(metadata_json, '$.continuityKind'))
    WHERE json_extract(metadata_json, '$.kind') = 'continuity_record'`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_ledger_events_continuity_record_id
    ON ledger_events(conversation_id, json_extract(metadata_json, '$.recordId'))
    WHERE json_extract(metadata_json, '$.kind') = 'continuity_record'`,
  `CREATE TABLE IF NOT EXISTS ledger_events_fts (
    rowid INTEGER PRIMARY KEY,
    content TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_ledger_events_fts_content
    ON ledger_events_fts(content)`,
  `CREATE TRIGGER IF NOT EXISTS ledger_events_ai AFTER INSERT ON ledger_events BEGIN
    INSERT INTO ledger_events_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS ledger_events_ad AFTER DELETE ON ledger_events BEGIN
    DELETE FROM ledger_events_fts WHERE rowid = old.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS ledger_events_au AFTER UPDATE OF content ON ledger_events BEGIN
    DELETE FROM ledger_events_fts WHERE rowid = old.rowid;
    INSERT INTO ledger_events_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE TABLE IF NOT EXISTS summary_nodes (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
    content TEXT NOT NULL,
    retrieval_text TEXT NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_summary_nodes_conv
    ON summary_nodes(conversation_id)`,
  `CREATE TABLE IF NOT EXISTS summary_nodes_fts (
    rowid INTEGER PRIMARY KEY,
    retrieval_text TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_summary_nodes_fts_retrieval_text
    ON summary_nodes_fts(retrieval_text)`,
  `CREATE TRIGGER IF NOT EXISTS summary_nodes_ai AFTER INSERT ON summary_nodes BEGIN
    INSERT INTO summary_nodes_fts(rowid, retrieval_text) VALUES (new.rowid, new.retrieval_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS summary_nodes_ad AFTER DELETE ON summary_nodes BEGIN
    DELETE FROM summary_nodes_fts WHERE rowid = old.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS summary_nodes_au AFTER UPDATE OF retrieval_text ON summary_nodes BEGIN
    DELETE FROM summary_nodes_fts WHERE rowid = old.rowid;
    INSERT INTO summary_nodes_fts(rowid, retrieval_text) VALUES (new.rowid, new.retrieval_text);
  END`,
  `CREATE TABLE IF NOT EXISTS summary_message_edges (
    summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,
    ord INTEGER NOT NULL,
    PRIMARY KEY (summary_id, message_id)
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sqlite_summary_message_edges_summary_ord
    ON summary_message_edges(summary_id, ord)`,
  `CREATE TABLE IF NOT EXISTS summary_parent_edges (
    summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
    parent_summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE RESTRICT,
    ord INTEGER NOT NULL,
    PRIMARY KEY (summary_id, parent_summary_id),
    CHECK (summary_id <> parent_summary_id)
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sqlite_summary_parent_edges_summary_ord
    ON summary_parent_edges(summary_id, ord)`,
  `CREATE TABLE IF NOT EXISTS context_items (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    message_id TEXT REFERENCES ledger_events(id) ON DELETE RESTRICT,
    summary_id TEXT REFERENCES summary_nodes(id) ON DELETE RESTRICT,
    PRIMARY KEY (conversation_id, position),
    CHECK ((message_id IS NOT NULL) <> (summary_id IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_context_items_conv
    ON context_items(conversation_id, position)`,
  `CREATE TABLE IF NOT EXISTS context_versions (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('path', 'inline_text', 'inline_binary')),
    original_path TEXT,
    mime_type TEXT NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    exploration_summary TEXT,
    explorer_used TEXT,
    content_text TEXT,
    content_binary BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
      (storage_kind = 'path' AND original_path IS NOT NULL AND content_text IS NULL AND content_binary IS NOT NULL)
      OR (storage_kind = 'inline_text' AND original_path IS NULL AND content_text IS NOT NULL AND content_binary IS NULL)
      OR (storage_kind = 'inline_binary' AND original_path IS NULL AND content_text IS NULL AND content_binary IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_artifacts_conv
    ON artifacts(conversation_id)`,
  `CREATE TABLE IF NOT EXISTS operator_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    operator_kind TEXT NOT NULL CHECK (operator_kind IN ('llmMap', 'agenticMap')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'completed_with_failures', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    prompt TEXT,
    task_prompt TEXT,
    output_schema_json TEXT NOT NULL,
    concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit > 0),
    retry_policy_json TEXT NOT NULL,
    delegated_scope_json TEXT,
    kept_work_json TEXT,
    idempotency_key TEXT,
    normalized_input_digest TEXT,
    input_artifact_id TEXT,
    output_artifact_id TEXT,
    finalization_stage TEXT NOT NULL CHECK (finalization_stage IN ('not_started', 'artifact_written', 'handle_appended', 'completed')),
    needs_finalization_retry INTEGER NOT NULL DEFAULT 0 CHECK (needs_finalization_retry IN (0, 1)),
    parent_handle_appended_at TEXT,
    task_count INTEGER NOT NULL CHECK (task_count >= 0),
    succeeded_task_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_task_count >= 0),
    failed_task_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_task_count >= 0),
    retryable_failure_task_count INTEGER NOT NULL DEFAULT 0 CHECK (retryable_failure_task_count >= 0),
    running_task_count INTEGER NOT NULL DEFAULT 0 CHECK (running_task_count >= 0),
    pending_task_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_task_count >= 0),
    terminal_failure_summary_json TEXT,
    CHECK ((prompt IS NOT NULL) <> (task_prompt IS NOT NULL)),
    CHECK (succeeded_task_count + failed_task_count + retryable_failure_task_count + running_task_count + pending_task_count = task_count)
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sqlite_operator_runs_conversation_idempotency_key_unique
    ON operator_runs(conversation_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS operator_tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES operator_runs(run_id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retryable_failure', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner TEXT,
    lease_expires_at TEXT,
    next_retry_at TEXT,
    child_conversation_id TEXT,
    bootstrap_state TEXT NOT NULL CHECK (bootstrap_state IN ('bootstrap_not_started', 'bootstrap_in_progress', 'bootstrap_completed')),
    result_json TEXT,
    result_artifact_id TEXT,
    last_error_json TEXT,
    last_failure_at TEXT,
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    UNIQUE (run_id, item_index)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_operator_tasks_claimable
    ON operator_tasks(status, next_retry_at, lease_expires_at, run_id, item_index)`,
  `CREATE INDEX IF NOT EXISTS idx_sqlite_operator_runs_finalization_retry
    ON operator_runs(needs_finalization_retry, status, updated_at)
    WHERE needs_finalization_retry = 1`,
] as const;
