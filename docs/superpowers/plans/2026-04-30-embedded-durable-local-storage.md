# Embedded Durable Local Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SQLite-backed local durable storage path so LedgerMind continuity survives process restarts without requiring manually managed PostgreSQL.

**Architecture:** Implement SQLite in `packages/infrastructure` as a full persistence adapter for the existing driven ports: conversations, ledger append/read, context projection, summary DAG, artifacts, operator execution, and unit of work. Wire it through the SDK and runtime configs as a third storage type while keeping domain/application unchanged and preserving PostgreSQL/in-memory behavior. SQLite becomes the default durable local backend only after it passes the shared conformance suite and a restart persistence smoke.

**Tech Stack:** TypeScript strict ESM, Node.js >=22.16.0, built-in `node:sqlite` `DatabaseSync`, Vitest, existing Clean Architecture packages, existing persistence conformance suite, existing CLI/MCP/Claude Code config parsers.

---

## Product Contract

Task 19 is complete when this is true:

1. `createSqliteMemoryEngine({ path })` persists ledger events, context, summaries, artifacts, continuity records, runtime bindings, and operator execution state across process restarts.
2. `createMemoryEngine({ storage: { type: 'sqlite', path } })` is supported by the SDK.
3. CLI, MCP server, and Claude Code hooks can use SQLite with `--storage sqlite`, `--sqlite <path>`, or `LEDGERMIND_SQLITE_PATH`.
4. Default local coding-agent setups use `.ledgermind/memory.sqlite` instead of in-memory storage when a writable workspace is available.
5. SQLite passes the same conformance suite as in-memory and PostgreSQL, except corruption injection that requires direct test-only SQL.
6. Documentation no longer says durable local memory requires PostgreSQL.

## Driver Decision

Use Node's built-in `node:sqlite` module first on Node.js >=22.16.0. Node's official docs show `DatabaseSync`, `StatementSync`, file-backed paths, prepared statements, foreign-key support, busy timeout, and no external native npm dependency. The tradeoff is that Node still labels SQLite as release-candidate/experimental, and the current bundled SQLite build does not expose FTS5. This adapter must be isolated behind `packages/infrastructure/src/sqlite/*` and all public APIs must remain storage-port based.

Do not introduce `better-sqlite3` in this task. Revisit that only if `node:sqlite` fails project verification on the supported Node 22 runtime.

SQLite V1 text search uses deterministic mirror tables plus `LIKE`/JavaScript regex filtering instead of FTS5 `MATCH`. This keeps local durability dependency-free. The conformance adapter must report `fullTextSearch: false` until a verified FTS backend is available.

## File Structure

Create:

- `packages/infrastructure/src/sqlite/sqlite-types.ts` - narrow wrapper types over `DatabaseSync`, statements, result rows, and SQLite values.
- `packages/infrastructure/src/sqlite/sqlite-connection.ts` - opens file-backed databases, creates parent directories, applies PRAGMAs, runs migrations, and closes handles.
- `packages/infrastructure/src/sqlite/sqlite-schema.ts` - schema version and ordered SQL migration strings.
- `packages/infrastructure/src/sqlite/sqlite-json.ts` - JSON parsing/stringifying helpers and safe integer conversion.
- `packages/infrastructure/src/sqlite/sqlite-conversation-store.ts` - `ConversationPort`.
- `packages/infrastructure/src/sqlite/sqlite-ledger-store.ts` - `LedgerAppendPort` and `LedgerReadPort`.
- `packages/infrastructure/src/sqlite/sqlite-context-projection.ts` - `ContextProjectionPort`.
- `packages/infrastructure/src/sqlite/sqlite-artifact-store.ts` - `ArtifactStorePort`.
- `packages/infrastructure/src/sqlite/sqlite-summary-dag.ts` - `SummaryDagPort`.
- `packages/infrastructure/src/sqlite/sqlite-operator-execution-store.ts` - `OperatorExecutionPort`.
- `packages/infrastructure/src/sqlite/sqlite-unit-of-work.ts` - `UnitOfWorkPort`.
- `packages/infrastructure/src/sqlite/index.ts` - local exports.
- `packages/infrastructure/src/sqlite/__tests__/sqlite-connection.test.ts`
- `packages/infrastructure/src/sqlite/__tests__/sqlite-restart.test.ts`
- `packages/infrastructure/src/sqlite/__tests__/sqlite-unit-of-work.test.ts`
- `tests/conformance/sqlite-adapter.ts` - conformance factory shared by the cross-adapter suite.

Modify:

- `packages/infrastructure/src/index.ts` - export SQLite adapter and factory APIs.
- `packages/sdk/src/index.ts` - add `sqlite` storage config and `createSqliteMemoryEngine`.
- `packages/sdk/src/index.test.ts` - cover SDK config validation and restart persistence.
- `packages/mcp-server/src/config.ts` - parse SQLite storage flags/env and help text.
- `packages/mcp-server/src/cli.ts` or server composition file - create SQLite engine when selected.
- `packages/mcp-server/src/__tests__/server.integration.test.ts` - cover SQLite config parsing and current-state persistence.
- `packages/cli/src/config.ts` - parse SQLite storage flags/env.
- `packages/cli/src/runtime.ts` - create SQLite engine when selected.
- `packages/cli/src/__tests__/cli.test.ts` and `packages/cli/src/__tests__/commands.test.ts` - cover SQLite CLI continuity restart.
- `packages/claude-code/src/config.ts` - default to SQLite path when no Postgres URL is set.
- `packages/claude-code/src/runtime.ts` - create SQLite engine when selected and stop warning about non-durable storage.
- `packages/claude-code/src/__tests__/session-start.test.ts`, `stop.test.ts`, `user-prompt-submit.test.ts` - cover default SQLite durability.
- `tests/conformance/__tests__/conformance.cross-adapter.test.ts` - include SQLite adapter.
- `docs/agent-continuity-layer.md`, `docs/claude-code-integration.md`, `README.md`, `examples/continuity/*`, `examples/claude-code/*`, `examples/ampcode/*` - document SQLite local default and Postgres as optional server durability.

Do not modify:

- `packages/domain` - SQLite is infrastructure only.
- `packages/application` port definitions - existing ports are sufficient.
- PostgreSQL schema semantics except where tests reveal an existing conformance bug unrelated to SQLite.

## Schema Contract

Use SQLite tables that mirror the existing PostgreSQL model:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES conversations(id),
  model_name TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  soft_threshold REAL NOT NULL,
  hard_threshold REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (soft_threshold < hard_threshold)
) STRICT;

CREATE TABLE ledger_events (
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
) STRICT;

CREATE TABLE ledger_events_fts (
  rowid INTEGER PRIMARY KEY,
  content TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sqlite_ledger_events_fts_content
  ON ledger_events_fts(content);

CREATE TRIGGER ledger_events_ai AFTER INSERT ON ledger_events BEGIN
  INSERT INTO ledger_events_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER ledger_events_ad AFTER DELETE ON ledger_events BEGIN
  DELETE FROM ledger_events_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER ledger_events_au AFTER UPDATE OF content ON ledger_events BEGIN
  DELETE FROM ledger_events_fts WHERE rowid = old.rowid;
  INSERT INTO ledger_events_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE summary_nodes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
  content TEXT NOT NULL,
  retrieval_text TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE summary_nodes_fts (
  rowid INTEGER PRIMARY KEY,
  retrieval_text TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sqlite_summary_nodes_fts_retrieval_text
  ON summary_nodes_fts(retrieval_text);

CREATE TABLE summary_message_edges (
  summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (summary_id, message_id)
) STRICT;

CREATE UNIQUE INDEX idx_sqlite_summary_message_edges_summary_ord
  ON summary_message_edges(summary_id, ord);

CREATE TABLE summary_parent_edges (
  summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (summary_id, parent_summary_id),
  CHECK (summary_id <> parent_summary_id)
) STRICT;

CREATE UNIQUE INDEX idx_sqlite_summary_parent_edges_summary_ord
  ON summary_parent_edges(summary_id, ord);

CREATE TABLE context_items (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  message_id TEXT REFERENCES ledger_events(id) ON DELETE RESTRICT,
  summary_id TEXT REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  PRIMARY KEY (conversation_id, position),
  CHECK ((message_id IS NOT NULL) <> (summary_id IS NOT NULL))
) STRICT;

CREATE TABLE context_versions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
) STRICT;

CREATE TABLE artifacts (
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
) STRICT;
```

Operator tables should mirror `0003_operator_execution_schema.sql` with enum columns represented as constrained `TEXT`, JSON fields as `TEXT` containing canonical JSON, timestamps as ISO strings, and the same unique indexes from `0004_operator_execution_indexes.sql`.

---

## Task 1: SQLite Connection, Schema, and Smoke Tests

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-types.ts`
- Create: `packages/infrastructure/src/sqlite/sqlite-json.ts`
- Create: `packages/infrastructure/src/sqlite/sqlite-schema.ts`
- Create: `packages/infrastructure/src/sqlite/sqlite-connection.ts`
- Create: `packages/infrastructure/src/sqlite/index.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-connection.test.ts`
- Modify: `packages/infrastructure/src/index.ts`

- [ ] **Step 1: Write the failing connection test**

Create `packages/infrastructure/src/sqlite/__tests__/sqlite-connection.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SQLITE_SCHEMA_VERSION, SQLITE_TEXT_SEARCH_MODE } from '../sqlite-schema';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openSqliteDatabase', () => {
  it('creates parent directories, applies schema, and enables foreign keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-'));
    tempDirs.push(dir);
    const path = join(dir, 'nested', 'memory.sqlite');

    const database = await openSqliteDatabase({ path });

    try {
      expect(database.path).toBe(path);
      expect(database.db.prepare('PRAGMA user_version').get()).toEqual({
        user_version: SQLITE_SCHEMA_VERSION,
      });
      expect(database.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(
        database.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events'")
          .get(),
      ).toEqual({
        name: 'ledger_events',
      });
      expect(SQLITE_TEXT_SEARCH_MODE).toBe('mirror-table');
      expect(
        database.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events_fts'",
          )
          .get(),
      ).toEqual({ name: 'ledger_events_fts' });
      expect(
        database.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_events_fts' AND sql LIKE '%USING fts5%'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-connection
```

Expected: FAIL with a module resolution error for `../sqlite-connection`.

- [ ] **Step 3: Add SQLite helper types**

Create `packages/infrastructure/src/sqlite/sqlite-types.ts`:

```ts
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export type SqliteValue = string | number | bigint | Uint8Array | null;
export type SqliteParams = readonly SqliteValue[] | Record<string, SqliteValue>;
export type SqliteRow = Record<string, unknown>;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export type SqliteStatement<Row extends SqliteRow = SqliteRow> = StatementSync & {
  get(...params: SqliteValue[]): Row | undefined;
  get(params: Record<string, SqliteValue>): Row | undefined;
  all(...params: SqliteValue[]): Row[];
  all(params: Record<string, SqliteValue>): Row[];
  run(...params: SqliteValue[]): SqliteRunResult;
  run(params: Record<string, SqliteValue>): SqliteRunResult;
};

export interface SqliteDatabase {
  readonly path: string;
  readonly db: DatabaseSync;
  close(): void;
}
```

- [ ] **Step 4: Add JSON and integer helpers**

Create `packages/infrastructure/src/sqlite/sqlite-json.ts`:

```ts
import { InvariantViolationError } from '@ledgermind/domain';

export const parseSqliteJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

export const parseSqliteJsonArray = (value: unknown): unknown[] => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
};

export const stringifySqliteJson = (value: unknown): string => JSON.stringify(value ?? null);

export const parseSqliteInteger = (value: unknown, fieldName: string): number => {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : Number.NaN;

  if (!Number.isSafeInteger(parsed)) {
    throw new InvariantViolationError(`Invalid ${fieldName} from SQLite row.`);
  }

  return parsed;
};
```

- [ ] **Step 5: Add schema migration constants**

Create `packages/infrastructure/src/sqlite/sqlite-schema.ts` with:

```ts
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
  `CREATE INDEX IF NOT EXISTS idx_sqlite_ledger_events_conv_seq ON ledger_events(conversation_id, seq)`,
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
  `CREATE INDEX IF NOT EXISTS idx_sqlite_summary_nodes_conv ON summary_nodes(conversation_id)`,
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
  `CREATE INDEX IF NOT EXISTS idx_sqlite_artifacts_conv ON artifacts(conversation_id)`,
] as const;
```

Add operator execution table SQL in Task 8, not in this first migration step, so the first test stays small.

- [ ] **Step 6: Add connection opening and migration**

Create `packages/infrastructure/src/sqlite/sqlite-connection.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';
import { SQLITE_SCHEMA_SQL, SQLITE_SCHEMA_VERSION } from './sqlite-schema';
import type { SqliteDatabase } from './sqlite-types';

export interface OpenSqliteDatabaseOptions {
  readonly path: string;
  readonly readOnly?: boolean;
}

export const openSqliteDatabase = async ({
  path,
  readOnly = false,
}: OpenSqliteDatabaseOptions): Promise<SqliteDatabase> => {
  if (path.trim().length === 0) {
    throw new Error('SQLite path is required and cannot be empty.');
  }

  if (!readOnly && path !== ':memory:') {
    await mkdir(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path, {
    readOnly,
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });

  try {
    const versionRow = db.prepare('PRAGMA user_version').get() as
      | { readonly user_version: unknown }
      | undefined;
    const existingVersion = parseSqliteInteger(versionRow?.user_version, 'pragma user_version');

    if (existingVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite database schema version ${existingVersion} is newer than supported version ${SQLITE_SCHEMA_VERSION}.`,
      );
    }

    if (readOnly && existingVersion === 0) {
      throw new Error('SQLite database schema has not been initialized.');
    }

    if (!readOnly) {
      for (const statement of SQLITE_SCHEMA_SQL) {
        db.exec(statement);
      }

      if (existingVersion === 0) {
        db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      }
    }

    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    path,
    db,
    close() {
      db.close();
    },
  };
};
```

- [ ] **Step 7: Export SQLite connection APIs**

Create `packages/infrastructure/src/sqlite/index.ts`:

```ts
export { openSqliteDatabase, type OpenSqliteDatabaseOptions } from './sqlite-connection';
export { SQLITE_SCHEMA_VERSION, SQLITE_TEXT_SEARCH_MODE } from './sqlite-schema';
export type { SqliteDatabase, SqliteRow, SqliteValue } from './sqlite-types';
```

Modify `packages/infrastructure/src/index.ts`:

```ts
export {
  openSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
  SQLITE_TEXT_SEARCH_MODE,
  type OpenSqliteDatabaseOptions,
} from './sqlite';
```

- [ ] **Step 8: Run the focused test**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-connection
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/infrastructure/src/sqlite packages/infrastructure/src/index.ts
git commit -m "feat: add sqlite connection and schema foundation"
```

## Task 2: SQLite Conversation Store

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-conversation-store.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-conversation-store.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Write the failing conversation store tests**

Create `packages/infrastructure/src/sqlite/__tests__/sqlite-conversation-store.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteConversationStore } from '../sqlite-conversation-store';

const tempDirs: string[] = [];

const createConfig = () =>
  createConversationConfig({
    modelName: 'sqlite-local',
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteConversationStore', () => {
  it('creates, reads, and restores ancestor chains after reopening the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-conversations-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');

    const firstDb = await openSqliteDatabase({ path });
    const firstStore = new SqliteConversationStore(firstDb.db);
    const parent = await firstStore.create(createConfig());
    const child = await firstStore.create(createConfig(), parent.id);
    firstDb.close();

    const secondDb = await openSqliteDatabase({ path });
    const secondStore = new SqliteConversationStore(secondDb.db);

    try {
      expect(await secondStore.get(parent.id)).toMatchObject({ id: parent.id, parentId: null });
      expect(await secondStore.get(child.id)).toMatchObject({ id: child.id, parentId: parent.id });
      expect(await secondStore.getAncestorChain(child.id)).toEqual([parent.id]);
    } finally {
      secondDb.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-conversation-store
```

Expected: FAIL with module resolution error for `../sqlite-conversation-store`.

- [ ] **Step 3: Implement `SqliteConversationStore`**

Create `packages/infrastructure/src/sqlite/sqlite-conversation-store.ts`:

```ts
import type { ConversationPort } from '@ledgermind/application';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createTokenCount,
  InvariantViolationError,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';

interface ConversationRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly model_name: string;
  readonly context_window: number;
  readonly soft_threshold: number;
  readonly hard_threshold: number;
  readonly created_at: string;
}

const toConversation = (row: ConversationRow): Conversation =>
  createConversation({
    id: createConversationId(row.id),
    parentId: row.parent_id === null ? null : createConversationId(row.parent_id),
    config: createConversationConfig({
      modelName: row.model_name,
      contextWindow: createTokenCount(row.context_window),
      thresholds: createCompactionThresholds(row.soft_threshold, row.hard_threshold),
    }),
    createdAt: new Date(row.created_at) as never,
  });

const createNextConversationId = (nextOrdinal: number): ConversationId =>
  createConversationId(`conv_${String(nextOrdinal).padStart(6, '0')}`);

export class SqliteConversationStore implements ConversationPort {
  constructor(private readonly db: DatabaseSync) {}

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
    const parentConversationId = parentId ?? null;

    if (parentConversationId !== null) {
      const parent = this.db
        .prepare('SELECT id FROM conversations WHERE id = ?')
        .get(parentConversationId);
      if (parent === undefined) {
        throw new InvariantViolationError('Parent conversation does not exist.');
      }
    }

    const ordinalRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(SUBSTR(id, 6) AS INTEGER)), 0) + 1 AS next_ordinal
         FROM conversations
         WHERE id GLOB 'conv_[0-9][0-9][0-9][0-9][0-9][0-9]'`,
      )
      .get() as { readonly next_ordinal: number };
    const id = createNextConversationId(
      parseSqliteInteger(ordinalRow.next_ordinal, 'conversations.next_ordinal'),
    );

    this.db
      .prepare(
        `INSERT INTO conversations (
          id, parent_id, model_name, context_window, soft_threshold, hard_threshold
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        parentConversationId,
        config.modelName,
        config.contextWindow.value,
        config.thresholds.soft,
        config.thresholds.hard,
      );

    const created = await this.get(id);
    if (created === null) {
      throw new Error('Failed to insert conversation row.');
    }

    return created;
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    const row = this.db
      .prepare(
        `SELECT id, parent_id, model_name, context_window, soft_threshold, hard_threshold, created_at
         FROM conversations
         WHERE id = ?`,
      )
      .get(id) as ConversationRow | undefined;

    return row === undefined ? null : toConversation(row);
  }

  async getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 AS depth FROM conversations WHERE id = ?
          UNION ALL
          SELECT parent.id, parent.parent_id, chain.depth + 1
          FROM conversations parent
          JOIN chain ON parent.id = chain.parent_id
        )
        SELECT id FROM chain WHERE depth > 0 ORDER BY depth DESC`,
      )
      .all(id) as Array<{ readonly id: string }>;

    return rows.map((row) => createConversationId(row.id));
  }
}
```

If TypeScript rejects `new Date(row.created_at) as never`, replace it with `createTimestamp(new Date(row.created_at))` and import `createTimestamp` from `@ledgermind/domain`.

- [ ] **Step 4: Export the store**

Modify `packages/infrastructure/src/sqlite/index.ts`:

```ts
export { SqliteConversationStore } from './sqlite-conversation-store';
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-conversation-store
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite conversation store"
```

## Task 3: SQLite Ledger Store

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-ledger-store.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-ledger-store.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Write failing ledger persistence tests**

Create `packages/infrastructure/src/sqlite/__tests__/sqlite-ledger-store.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCompactionThresholds,
  createConversationConfig,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createTokenCount,
  createTimestamp,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteConversationStore } from '../sqlite-conversation-store';
import { SqliteLedgerStore } from '../sqlite-ledger-store';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteLedgerStore', () => {
  it('appends events, preserves metadata, searches content, and survives reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-ledger-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const firstDb = await openSqliteDatabase({ path });
    const conversations = new SqliteConversationStore(firstDb.db);
    const ledger = new SqliteLedgerStore(firstDb.db);
    const conversation = await conversations.create(
      createConversationConfig({
        modelName: 'sqlite-ledger',
        contextWindow: createTokenCount(8192),
        thresholds: createCompactionThresholds(0.6, 0.9),
      }),
    );

    await ledger.appendEvents(conversation.id, [
      createLedgerEvent({
        id: createEventId('evt_sqlite_001'),
        conversationId: conversation.id,
        sequence: createSequenceNumber(1),
        role: 'user',
        content: 'Choose SQLite for local continuity.',
        tokenCount: createTokenCount(6),
        occurredAt: createTimestamp(new Date('2026-04-30T00:00:00.000Z')),
        metadata: {
          kind: 'continuity_record',
          continuityKind: 'decision',
          recordId: 'rec_sqlite_decision',
          __ledgermind_idempotencyKey: 'decision:sqlite',
          __ledgermind_idempotencyDigest: 'digest-a',
        },
      }),
    ]);
    firstDb.close();

    const secondDb = await openSqliteDatabase({ path });
    const reopened = new SqliteLedgerStore(secondDb.db);

    try {
      const events = await reopened.getEvents(conversation.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toMatchObject({
        continuityKind: 'decision',
        recordId: 'rec_sqlite_decision',
      });
      expect(await reopened.getNextSequence(conversation.id)).toBe(2);
      expect(
        (await reopened.searchEvents(conversation.id, 'SQLite')).map((event) => event.id),
      ).toEqual([createEventId('evt_sqlite_001')]);
      expect(
        (
          await reopened.regexSearchEvents(conversation.id, 'local continuity', {
            offset: 0,
            limit: 10,
          })
        ).totalMatchCount,
      ).toBe(1);
    } finally {
      secondDb.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-ledger-store
```

Expected: FAIL with module resolution error for `../sqlite-ledger-store`.

- [ ] **Step 3: Implement ledger row mapping and append**

Create `packages/infrastructure/src/sqlite/sqlite-ledger-store.ts` with these public pieces:

```ts
import type {
  LedgerAppendPort,
  LedgerReadPort,
  RegexSearchPageInput,
  RegexSearchPageOutput,
  SequenceRange,
} from '@ledgermind/application';
import { IdempotencyConflictError, type LedgerReadGrepMatch } from '@ledgermind/application';
import {
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNodeId,
  createTokenCount,
  createTimestamp,
  type ConversationId,
  type EventMetadata,
  type LedgerEvent,
  type SequenceNumber,
  type SummaryNodeId,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger, parseSqliteJsonObject, stringifySqliteJson } from './sqlite-json';

const IDEMPOTENCY_KEY_METADATA_FIELD = '__ledgermind_idempotencyKey';
const IDEMPOTENCY_DIGEST_METADATA_FIELD = '__ledgermind_idempotencyDigest';

interface LedgerEventRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly seq: number;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly token_count: number;
  readonly occurred_at: string;
  readonly metadata_json: string;
}

const toMetadata = (value: unknown): EventMetadata => Object.freeze(parseSqliteJsonObject(value));

const toEvent = (row: LedgerEventRow): LedgerEvent =>
  createLedgerEvent({
    id: createEventId(row.id),
    conversationId: row.conversation_id as ConversationId,
    sequence: createSequenceNumber(parseSqliteInteger(row.seq, 'ledger_events.seq')),
    role: row.role,
    content: row.content,
    tokenCount: createTokenCount(row.token_count),
    occurredAt: createTimestamp(new Date(row.occurred_at)),
    metadata: toMetadata(row.metadata_json),
  });

const readMetadataString = (metadata: EventMetadata, key: string): string | null => {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export class SqliteLedgerStore implements LedgerAppendPort, LedgerReadPort {
  constructor(private readonly db: DatabaseSync) {}

  async appendEvents(
    conversationId: ConversationId,
    events: readonly LedgerEvent[],
  ): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO ledger_events (
        id, conversation_id, seq, role, content, token_count, occurred_at, metadata_json, idempotency_key, idempotency_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const event of events) {
      if (event.conversationId !== conversationId) {
        throw new Error('Ledger event conversation mismatch during append.');
      }

      const idempotencyKey = readMetadataString(event.metadata, IDEMPOTENCY_KEY_METADATA_FIELD);
      const idempotencyDigest = readMetadataString(
        event.metadata,
        IDEMPOTENCY_DIGEST_METADATA_FIELD,
      );

      try {
        insert.run(
          event.id,
          conversationId,
          event.sequence,
          event.role,
          event.content,
          event.tokenCount.value,
          event.occurredAt.toISOString(),
          stringifySqliteJson(event.metadata),
          idempotencyKey,
          idempotencyDigest,
        );
      } catch (error) {
        const existing = idempotencyKey
          ? (this.db
              .prepare(
                `SELECT idempotency_digest FROM ledger_events WHERE conversation_id = ? AND idempotency_key = ?`,
              )
              .get(conversationId, idempotencyKey) as
              | { readonly idempotency_digest: string | null }
              | undefined)
          : undefined;

        if (existing !== undefined && existing.idempotency_digest !== idempotencyDigest) {
          throw new IdempotencyConflictError(conversationId, idempotencyKey);
        }

        throw error;
      }
    }
  }

  async getNextSequence(conversationId: ConversationId): Promise<SequenceNumber> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence FROM ledger_events WHERE conversation_id = ?`,
      )
      .get(conversationId) as { readonly next_sequence: number };

    return createSequenceNumber(
      parseSqliteInteger(row.next_sequence, 'ledger_events.next_sequence'),
    );
  }

  async getEvents(
    conversationId: ConversationId,
    range?: SequenceRange,
  ): Promise<readonly LedgerEvent[]> {
    const start = range?.start ?? null;
    const end = range?.end ?? null;
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, seq, role, content, token_count, occurred_at, metadata_json
         FROM ledger_events
         WHERE conversation_id = ?
           AND (? IS NULL OR seq >= ?)
           AND (? IS NULL OR seq <= ?)
         ORDER BY seq ASC`,
      )
      .all(conversationId, start, start, end, end) as LedgerEventRow[];

    return rows.map(toEvent);
  }

  private getScopedMessageIds(scope: SummaryNodeId | undefined): Set<string> | null {
    if (scope === undefined) {
      return null;
    }

    const rows = this.db
      .prepare(
        `WITH RECURSIVE covered_summaries(id) AS (
          SELECT ?
          UNION
          SELECT spe.parent_summary_id
          FROM summary_parent_edges spe
          JOIN covered_summaries cs ON spe.summary_id = cs.id
        )
        SELECT sme.message_id AS id
        FROM summary_message_edges sme
        WHERE sme.summary_id IN (SELECT id FROM covered_summaries)`,
      )
      .all(scope) as Array<{ readonly id: string }>;

    return new Set(rows.map((row) => row.id));
  }

  async searchEvents(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly LedgerEvent[]> {
    const scopedMessageIds = this.getScopedMessageIds(scope);
    const rows = this.db
      .prepare(
        `SELECT le.id, le.conversation_id, le.seq, le.role, le.content, le.token_count, le.occurred_at, le.metadata_json
         FROM ledger_events le
         JOIN ledger_events_fts mirror ON mirror.rowid = le.rowid
         WHERE le.conversation_id = ?
           AND LOWER(mirror.content) LIKE LOWER(?)
         ORDER BY le.seq ASC`,
      )
      .all(conversationId, `%${query}%`) as LedgerEventRow[];

    return rows
      .filter((row) => scopedMessageIds === null || scopedMessageIds.has(row.id))
      .map(toEvent);
  }

  async regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    page: RegexSearchPageInput,
  ): Promise<RegexSearchPageOutput> {
    const scopedMessageIds = this.getScopedMessageIds(page.scope);
    const events = await this.getEvents(conversationId);
    const regex = new RegExp(pattern, 'i');
    const matches = events.flatMap((event): LedgerReadGrepMatch[] => {
      if (scopedMessageIds !== null && !scopedMessageIds.has(event.id)) {
        return [];
      }

      const match = regex.exec(event.content);
      if (match === null) {
        return [];
      }
      const start = match.index;
      return [
        {
          eventId: event.id,
          sequence: event.sequence,
          excerpt: event.content.slice(
            Math.max(0, start - 24),
            Math.min(event.content.length, start + match[0].length + 24),
          ),
          ...(page.scope === undefined
            ? {}
            : { coveringSummaryId: createSummaryNodeId(page.scope) }),
        },
      ];
    });

    return {
      matches: matches.slice(page.offset, page.offset + page.limit),
      totalMatchCount: matches.length,
    };
  }
}
```

This implementation keeps unscoped mirror-table text search in SQLite and applies scope filtering from the DAG edge tables before returning results.

- [ ] **Step 4: Export the store**

Modify `packages/infrastructure/src/sqlite/index.ts`:

```ts
export { SqliteLedgerStore } from './sqlite-ledger-store';
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-ledger-store
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite ledger store"
```

## Task 4: SQLite Context Projection Store

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-context-projection.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-context-projection.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Write failing context projection tests**

Create `packages/infrastructure/src/sqlite/__tests__/sqlite-context-projection.test.ts` with two tests:

```ts
it('appends context items with contiguous positions and survives reopen', async () => {
  // Arrange a conversation and one ledger event.
  // Append createContextItem({ conversationId, position: 99, ref: createMessageContextItemRef(event.id) }).
  // Assert stored position is 0, token count equals the event token count, and reopen returns version 1.
});

it('throws StaleContextVersionError when replacing with an old version', async () => {
  // Arrange two current context items.
  // Call replaceContextItems(conversation.id, createContextVersion(0), [0], replacement).
  // Assert StaleContextVersionError has actualVersion 1.
});
```

Use the setup pattern from `sqlite-ledger-store.test.ts` and import `StaleContextVersionError` from `@ledgermind/application`.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-context-projection
```

Expected: FAIL with module resolution error for `../sqlite-context-projection`.

- [ ] **Step 3: Implement context projection**

Create `packages/infrastructure/src/sqlite/sqlite-context-projection.ts`:

```ts
import type { ContextProjectionPort } from '@ledgermind/application';
import { StaleContextVersionError } from '@ledgermind/application';
import {
  createContextItem,
  createContextVersion,
  createEventId,
  createMessageContextItemRef,
  createSummaryNodeId,
  createSummaryContextItemRef,
  createTokenCount,
  type ContextItem,
  type ContextVersion,
  type ConversationId,
  type TokenCount,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';

export class SqliteContextProjection implements ContextProjectionPort {
  constructor(private readonly db: DatabaseSync) {}

  private ensureVersionRow(conversationId: ConversationId): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO context_versions (conversation_id, version) VALUES (?, 0)`)
      .run(conversationId);
  }

  private getCurrentVersion(conversationId: ConversationId): ContextVersion {
    const row = this.db
      .prepare(`SELECT version FROM context_versions WHERE conversation_id = ?`)
      .get(conversationId) as { readonly version: number } | undefined;
    return createContextVersion(parseSqliteInteger(row?.version ?? 0, 'context_versions.version'));
  }

  async getCurrentContext(
    conversationId: ConversationId,
  ): Promise<{ readonly items: readonly ContextItem[]; readonly version: ContextVersion }> {
    this.ensureVersionRow(conversationId);
    const rows = this.db
      .prepare(
        `SELECT position, message_id, summary_id FROM context_items WHERE conversation_id = ? ORDER BY position ASC`,
      )
      .all(conversationId) as Array<{
      readonly position: number;
      readonly message_id: string | null;
      readonly summary_id: string | null;
    }>;

    return {
      version: this.getCurrentVersion(conversationId),
      items: rows.map((row, index) =>
        createContextItem({
          conversationId,
          position: index,
          ref:
            row.message_id !== null
              ? createMessageContextItemRef(createEventId(row.message_id))
              : createSummaryContextItemRef(createSummaryNodeId(String(row.summary_id))),
        }),
      ),
    };
  }

  async getContextTokenCount(conversationId: ConversationId): Promise<TokenCount> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
          CASE
            WHEN ci.message_id IS NOT NULL THEN le.token_count
            WHEN ci.summary_id IS NOT NULL THEN sn.token_count
            ELSE 0
          END
        ), 0) AS total_tokens
        FROM context_items ci
        LEFT JOIN ledger_events le ON le.id = ci.message_id
        LEFT JOIN summary_nodes sn ON sn.id = ci.summary_id
        WHERE ci.conversation_id = ?`,
      )
      .get(conversationId) as { readonly total_tokens: number };

    return createTokenCount(parseSqliteInteger(row.total_tokens, 'context token count'));
  }

  async appendContextItems(
    conversationId: ConversationId,
    items: readonly ContextItem[],
  ): Promise<ContextVersion> {
    this.ensureVersionRow(conversationId);
    if (items.length === 0) {
      return this.getCurrentVersion(conversationId);
    }

    const startRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as { readonly next_position: number };
    let position = parseSqliteInteger(startRow.next_position, 'context_items.next_position');
    const insert = this.db.prepare(
      `INSERT INTO context_items (conversation_id, position, message_id, summary_id) VALUES (?, ?, ?, ?)`,
    );

    for (const item of items) {
      insert.run(
        conversationId,
        position,
        item.ref.type === 'message' ? item.ref.messageId : null,
        item.ref.type === 'summary' ? item.ref.summaryId : null,
      );
      position += 1;
    }

    this.db
      .prepare(`UPDATE context_versions SET version = version + 1 WHERE conversation_id = ?`)
      .run(conversationId);
    return this.getCurrentVersion(conversationId);
  }

  async replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: readonly number[],
    replacement: ContextItem,
  ): Promise<ContextVersion> {
    this.ensureVersionRow(conversationId);
    const currentVersion = this.getCurrentVersion(conversationId);
    if (currentVersion !== expectedVersion) {
      throw new StaleContextVersionError(expectedVersion, currentVersion);
    }

    const current = await this.getCurrentContext(conversationId);
    const remove = new Set(positionsToRemove);
    const kept = current.items.filter((item) => !remove.has(item.position));
    const next = [...kept, replacement].map((item, index) =>
      createContextItem({ conversationId, position: index, ref: item.ref }),
    );

    this.db.prepare(`DELETE FROM context_items WHERE conversation_id = ?`).run(conversationId);
    const insert = this.db.prepare(
      `INSERT INTO context_items (conversation_id, position, message_id, summary_id) VALUES (?, ?, ?, ?)`,
    );
    for (const item of next) {
      insert.run(
        conversationId,
        item.position,
        item.ref.type === 'message' ? item.ref.messageId : null,
        item.ref.type === 'summary' ? item.ref.summaryId : null,
      );
    }

    this.db
      .prepare(`UPDATE context_versions SET version = version + 1 WHERE conversation_id = ?`)
      .run(conversationId);
    return this.getCurrentVersion(conversationId);
  }
}
```

- [ ] **Step 4: Export and verify**

Export:

```ts
export { SqliteContextProjection } from './sqlite-context-projection';
```

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-context-projection
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite context projection"
```

## Task 5: SQLite Artifact Store

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-artifact-store.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-artifact-store.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Write failing artifact tests**

Create tests covering:

```ts
it('stores inline text and returns false for duplicate artifact ids', async () => {
  // Store createArtifact({ storageKind: 'inline_text', ... }) with content "hello".
  // Assert first store returns true, second returns false, metadata round trips, getContent returns "hello".
});

it('stores binary path snapshots as Uint8Array and survives reopen', async () => {
  // Store createArtifact({ storageKind: 'path', originalPath: '/tmp/a.ts', ... }) with new Uint8Array([1, 2, 3]).
  // Reopen database and assert getContent returns a new Uint8Array([1, 2, 3]).
});

it('updates exploration summary', async () => {
  // Store an artifact, call updateExploration(id, 'summary', 'markdown'), assert metadata includes both fields.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-artifact-store
```

Expected: FAIL with module resolution error for `../sqlite-artifact-store`.

- [ ] **Step 3: Implement artifact storage**

Create `packages/infrastructure/src/sqlite/sqlite-artifact-store.ts` using the same conversion rules as `PgArtifactStore`: `inline_text` requires text content, `inline_binary` requires binary content, and `path` stores a snapshot in `content_binary` when content is provided.

The class signature must be:

```ts
export class SqliteArtifactStore implements ArtifactStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<boolean>;
  async getMetadata(id: ArtifactId): Promise<Artifact | null>;
  async getContent(id: ArtifactId): Promise<string | Uint8Array | null>;
  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void>;
}
```

Use `INSERT OR IGNORE` and return `result.changes > 0`. Convert BLOB rows with `new Uint8Array(row.content_binary as Uint8Array)` so callers cannot mutate stored buffers.

- [ ] **Step 4: Export and verify**

Export:

```ts
export { SqliteArtifactStore } from './sqlite-artifact-store';
```

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-artifact-store
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite artifact store"
```

## Task 6: SQLite Summary DAG Store

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-summary-dag.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-summary-dag.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Write failing summary DAG tests**

Create tests covering:

```ts
it('creates leaf nodes, adds leaf edges, and expands to messages in sequence order', async () => {
  // Create two ledger events and one leaf summary.
  // addLeafEdges(summary.id, [event2.id, event1.id]).
  // expandToMessages(summary.id) must return events sorted by sequence, not edge input order.
});

it('rejects condensed self-cycles and detects orphan/cycle integrity failures', async () => {
  // addCondensedEdges(summary.id, [summary.id]) rejects with InvalidDagEdgeError.
  // checkIntegrity(conversation.id) passes for valid DAG.
});

it('searches retrieval text through FTS and returns summary artifact ids', async () => {
  // Create summary with retrievalText "sqlite continuity local recall" and artifactIds ["art_1"].
  // searchSummaries(conversation.id, "sqlite") returns the summary with artifact ids.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-summary-dag
```

Expected: FAIL with module resolution error for `../sqlite-summary-dag`.

- [ ] **Step 3: Implement DAG operations**

Create `SqliteSummaryDag` with the same public methods as `SummaryDagPort`.

Important SQL shapes:

```sql
INSERT INTO summary_nodes (
  id, conversation_id, kind, content, retrieval_text, token_count, artifact_ids_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

```sql
WITH RECURSIVE covered_summaries(id) AS (
  SELECT ?
  UNION
  SELECT spe.parent_summary_id
  FROM summary_parent_edges spe
  JOIN covered_summaries cs ON cs.id = spe.summary_id
)
SELECT le.*
FROM summary_message_edges sme
JOIN ledger_events le ON le.id = sme.message_id
WHERE sme.summary_id IN (SELECT id FROM covered_summaries)
ORDER BY le.seq ASC
```

```sql
WITH RECURSIVE walk(id, path) AS (
  SELECT ? AS id, json_array(?)
  UNION ALL
  SELECT spe.parent_summary_id, json_insert(walk.path, '$[#]', spe.parent_summary_id)
  FROM summary_parent_edges spe
  JOIN walk ON spe.summary_id = walk.id
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(walk.path) WHERE value = spe.parent_summary_id
  )
)
SELECT EXISTS(SELECT 1 FROM walk WHERE id = ?) AS reaches_summary
```

Reuse the 8 integrity check names from `PgSummaryDag`; SQLite must produce the same `IntegrityReport` shape.

- [ ] **Step 4: Export and verify**

Export:

```ts
export { SqliteSummaryDag } from './sqlite-summary-dag';
```

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-summary-dag
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite summary dag"
```

## Task 7: SQLite Unit of Work

**Files:**

- Create: `packages/infrastructure/src/sqlite/sqlite-unit-of-work.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-unit-of-work.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Write failing transaction tests**

Create `packages/infrastructure/src/sqlite/__tests__/sqlite-unit-of-work.test.ts`:

```ts
it('commits all mutations on success', async () => {
  // Use SqliteUnitOfWork.execute to create a conversation and append one event.
  // Assert the event exists after execute resolves.
});

it('rolls back all mutations when work throws', async () => {
  // Use SqliteUnitOfWork.execute to create a conversation and append one event, then throw new Error('rollback').
  // Assert conversations and ledger_events are empty after the rejection.
});

it('does not nest transactions silently', async () => {
  // Call execute inside execute and assert it throws "Nested SQLite unit of work is not supported."
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-unit-of-work
```

Expected: FAIL with module resolution error for `../sqlite-unit-of-work`.

- [ ] **Step 3: Implement unit of work**

Create `packages/infrastructure/src/sqlite/sqlite-unit-of-work.ts`:

```ts
import type { UnitOfWork, UnitOfWorkPort } from '@ledgermind/application';
import type { DatabaseSync } from 'node:sqlite';

import { SqliteArtifactStore } from './sqlite-artifact-store';
import { SqliteContextProjection } from './sqlite-context-projection';
import { SqliteConversationStore } from './sqlite-conversation-store';
import { SqliteLedgerStore } from './sqlite-ledger-store';
import { SqliteOperatorExecutionStore } from './sqlite-operator-execution-store';
import { SqliteSummaryDag } from './sqlite-summary-dag';

const createUnitOfWork = (db: DatabaseSync): UnitOfWork => ({
  ledger: new SqliteLedgerStore(db),
  context: new SqliteContextProjection(db),
  dag: new SqliteSummaryDag(db),
  artifacts: new SqliteArtifactStore(db),
  conversations: new SqliteConversationStore(db),
  operators: new SqliteOperatorExecutionStore(db),
});

export class SqliteUnitOfWork implements UnitOfWorkPort {
  private active = false;

  constructor(private readonly db: DatabaseSync) {}

  async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    if (this.active) {
      throw new Error('Nested SQLite unit of work is not supported.');
    }

    this.active = true;
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = await work(createUnitOfWork(this.db));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.active = false;
    }
  }
}

export const createSqliteUnitOfWork = (db: DatabaseSync): SqliteUnitOfWork =>
  new SqliteUnitOfWork(db);
```

`SqliteOperatorExecutionStore` is created in Task 8. Until Task 8 lands, make this file compile by adding a temporary `packages/infrastructure/src/sqlite/sqlite-operator-execution-store.ts` class that extends `NoopOperatorExecutionPort` is forbidden because conformance must eventually cover operators. Instead, implement Task 8 immediately after this task before running package-wide typecheck.

- [ ] **Step 4: Export the unit of work**

Export:

```ts
export { SqliteUnitOfWork, createSqliteUnitOfWork } from './sqlite-unit-of-work';
```

- [ ] **Step 5: Run the focused test after Task 8 exists**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-unit-of-work
```

Expected: PASS.

- [ ] **Step 6: Commit after Task 8**

Commit Task 7 together with Task 8 if `SqliteOperatorExecutionStore` is required for compilation:

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite unit of work"
```

## Task 8: SQLite Operator Execution Store

**Files:**

- Modify: `packages/infrastructure/src/sqlite/sqlite-schema.ts`
- Create: `packages/infrastructure/src/sqlite/sqlite-operator-execution-store.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/sqlite-operator-execution-store.test.ts`
- Modify: `packages/infrastructure/src/sqlite/index.ts`

- [ ] **Step 1: Add failing operator store tests**

Create tests covering:

```ts
it('creates a run with tasks and finds it by idempotency key', async () => {
  // createRunWithTasks with two items.
  // getRun returns taskCount 2 and pendingTaskCount 2.
  // lookupRunByIdempotencyKey returns the same run.
});

it('claims a task lease and records success', async () => {
  // claimTaskLease({ workerId: 'w1', now, leaseDurationSeconds: 60 }).
  // recordTaskSuccess for claimed task with output { ok: true }.
  // listTasksForRun shows one succeeded task.
});

it('persists retryable failures and finalization state across reopen', async () => {
  // markTaskRetryableFailure then close/reopen.
  // claimRunForFinalizationRetry and finalizeRun round trip state.
});
```

- [ ] **Step 2: Extend SQLite schema with operator tables**

Append these SQL statements to `SQLITE_SCHEMA_SQL` after the artifact schema statements:

```sql
CREATE TABLE IF NOT EXISTS operator_runs (
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
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sqlite_operator_runs_conversation_idempotency_key_unique
  ON operator_runs(conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_tasks (
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
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sqlite_operator_tasks_claimable
  ON operator_tasks(status, next_retry_at, lease_expires_at, run_id, item_index);

CREATE INDEX IF NOT EXISTS idx_sqlite_operator_runs_finalization_retry
  ON operator_runs(needs_finalization_retry, status, updated_at)
  WHERE needs_finalization_retry = 1;
```

- [ ] **Step 3: Implement operator execution store**

Create `SqliteOperatorExecutionStore` by porting `PgOperatorExecutionStore` method-for-method and translating:

- `$1` placeholders to `?`.
- JSONB columns to `*_json` text columns using `stringifySqliteJson`.
- booleans to `0`/`1`.
- `FOR UPDATE SKIP LOCKED` lease claiming to a single `BEGIN IMMEDIATE` protected `SELECT` followed by conditional `UPDATE`.
- `RETURNING` clauses to SQLite `RETURNING`, which is available in current SQLite builds used by Node.

The exported class must be:

```ts
export class SqliteOperatorExecutionStore implements OperatorExecutionPort {
  constructor(private readonly db: DatabaseSync) {}
}
```

Keep row mappers local to this file and return the exact DTO shapes from `OperatorExecutionPort`.

- [ ] **Step 4: Export and verify operator tests**

Export:

```ts
export { SqliteOperatorExecutionStore } from './sqlite-operator-execution-store';
```

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite-operator-execution-store sqlite-unit-of-work
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/sqlite
git commit -m "feat: add sqlite operator execution"
```

## Task 9: Add SQLite to Conformance

**Files:**

- Create: `tests/conformance/sqlite-adapter.ts`
- Modify: `tests/conformance/__tests__/conformance.cross-adapter.test.ts`

- [ ] **Step 1: Create SQLite conformance adapter**

Create `tests/conformance/sqlite-adapter.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteArtifactStore,
  SqliteContextProjection,
  SqliteConversationStore,
  SqliteLedgerStore,
  SqliteOperatorExecutionStore,
  SqliteSummaryDag,
  SqliteUnitOfWork,
  openSqliteDatabase,
} from '@ledgermind/infrastructure';
import { InvariantViolationError, type EventId, type SummaryNodeId } from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from './run-conformance';

export const createSqliteAdapter = (): ConformanceAdapterDefinition => ({
  adapterName: 'sqlite',
  capabilities: {
    fullTextSearch: false,
    regexSearch: true,
    recursiveCTE: true,
    concurrentWrites: false,
  },
  createRuntime: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-conformance-'));
    const database = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });
    const conversations = new SqliteConversationStore(database.db);
    const ledger = new SqliteLedgerStore(database.db);
    const context = new SqliteContextProjection(database.db);
    const dag = new SqliteSummaryDag(database.db);
    const artifacts = new SqliteArtifactStore(database.db);
    const operators = new SqliteOperatorExecutionStore(database.db);
    const unitOfWork = new SqliteUnitOfWork(database.db);

    const { createCompactionThresholds, createConversationConfig, createTokenCount } =
      await import('@ledgermind/domain');
    const conversation = await conversations.create(
      createConversationConfig({
        modelName: 'conformance-sqlite',
        contextWindow: createTokenCount(8192),
        thresholds: createCompactionThresholds(0.6, 1),
      }),
    );

    return {
      defaultConversationId: conversation.id,
      unitOfWork,
      ledger,
      context,
      dag,
      artifacts,
      conversations,
      operators,
      corruption: {
        canInjectOrphanSummaryMessageEdge: true,
        async injectOrphanSummaryMessageEdge(input: {
          readonly summaryId: SummaryNodeId;
          readonly missingMessageId: EventId;
        }): Promise<void> {
          database.db.exec('PRAGMA foreign_keys = OFF');
          try {
            database.db
              .prepare(
                `INSERT INTO summary_message_edges (summary_id, message_id, ord)
                 VALUES (?, ?, (
                   SELECT COALESCE(MAX(ord), -1) + 1
                   FROM summary_message_edges
                   WHERE summary_id = ?
                 ))`,
              )
              .run(input.summaryId, input.missingMessageId, input.summaryId);
          } finally {
            database.db.exec('PRAGMA foreign_keys = ON');
          }
        },
      },
      destroy: async () => {
        database.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
});
```

Remove the unused `InvariantViolationError` import if TypeScript reports it.

- [ ] **Step 2: Register SQLite in the cross-adapter suite**

Modify `tests/conformance/__tests__/conformance.cross-adapter.test.ts`:

```ts
import { createSqliteAdapter } from '../sqlite-adapter';

const adapters: readonly ConformanceAdapterDefinition[] = [
  createInMemoryAdapter(),
  createPostgresAdapter(),
  createSqliteAdapter(),
];
```

- [ ] **Step 3: Run conformance**

Run:

```bash
pnpm vitest run --root . tests/conformance --exclude '**/.tmp/**' --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**'
```

Expected: all in-memory and SQLite tests pass locally; PostgreSQL tests pass when the existing Postgres harness is available.

- [ ] **Step 4: Fix failures only in SQLite or tests that assumed PostgreSQL**

For every failure:

1. Identify the failing port.
2. Add a focused SQLite regression test beside the adapter file.
3. Fix the SQLite implementation.
4. Re-run the focused test.
5. Re-run conformance.

- [ ] **Step 5: Commit**

```bash
git add tests/conformance packages/infrastructure/src/sqlite
git commit -m "test: add sqlite persistence conformance"
```

## Task 10: SDK SQLite Storage Surface

**Files:**

- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/index.test.ts`

- [ ] **Step 1: Write failing SDK tests**

Add to `packages/sdk/src/index.test.ts`:

```ts
it('creates a sqlite engine that persists continuity across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sdk-sqlite-'));
  tempDirs.push(dir);
  const path = join(dir, 'memory.sqlite');
  const first = createSqliteMemoryEngine({ path });
  const conversation = await first.append({
    conversationId: undefined,
    messages: [{ role: 'user', content: 'Use SQLite local durability.' }],
    idempotencyKey: 'sqlite-sdk-memory',
  });

  await first.recordContinuity({
    conversationId: conversation.conversationId,
    kind: 'decision',
    title: 'Use SQLite',
    content: 'SQLite is the default local durable backend.',
  });

  const second = createSqliteMemoryEngine({ path });
  const state = await second.getCurrentState({ conversationId: conversation.conversationId });

  expect(state.decisions.map((record) => record.title)).toContain('Use SQLite');
});

it('rejects sqlite storage with an empty path', () => {
  expect(() => createMemoryEngine({ storage: { type: 'sqlite', path: '' } })).toThrow(
    'SQLite path is required and cannot be empty.',
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @ledgermind/sdk test -- sqlite
```

Expected: FAIL because `sqlite` storage and `createSqliteMemoryEngine` are not exported.

- [ ] **Step 3: Extend SDK config and imports**

Modify `packages/sdk/src/index.ts`:

```ts
import {
  openSqliteDatabase,
  SqliteArtifactStore,
  SqliteContextProjection,
  SqliteConversationStore,
  SqliteLedgerStore,
  SqliteOperatorExecutionStore,
  SqliteSummaryDag,
  SqliteUnitOfWork,
} from '@ledgermind/infrastructure';
```

Extend storage config:

```ts
export interface SqliteStorageConfig {
  readonly type: 'sqlite';
  readonly path: string;
}

export interface MemoryEngineConfig {
  readonly storage:
    | { readonly type: 'in-memory' }
    | {
        readonly type: 'postgres';
        readonly connectionString: string;
        readonly executor?: PgExecutor;
      }
    | SqliteStorageConfig;
  // existing fields unchanged
}
```

Update `SUPPORTED_STORAGE_TYPES` to:

```ts
const SUPPORTED_STORAGE_TYPES = '"in-memory", "postgres", "sqlite"';
```

Add preset:

```ts
export type SqlitePresetConfig = Omit<MemoryEngineConfig, 'storage'> & {
  readonly path: string;
};

export const createSqliteMemoryEngine = ({ path, ...config }: SqlitePresetConfig): MemoryEngine =>
  createMemoryEngine({
    storage: { type: 'sqlite', path },
    ...config,
  });
```

- [ ] **Step 4: Compose SQLite persistence deps**

In `createMemoryEngine`, add a branch:

```ts
const persistenceDeps: MemoryEnginePersistenceDeps =
  config.storage.type === 'in-memory'
    ? createInMemoryDeps()
    : config.storage.type === 'postgres'
      ? createPostgresDeps(config.storage)
      : createSqliteDeps(config.storage.path);
```

Because `openSqliteDatabase` is async, either:

1. Add a synchronous `openSqliteDatabaseSync({ path })` wrapper for SDK composition, or
2. Make `createSqliteMemoryEngine` return a Promise and keep `createMemoryEngine` sync.

Choose option 1 for API consistency:

```ts
export const openSqliteDatabaseSync = ({
  path,
  readOnly = false,
}: OpenSqliteDatabaseOptions): SqliteDatabase => {
  // same body as openSqliteDatabase but using mkdirSync(dirname(path), { recursive: true })
};
```

Then SDK composition can use:

```ts
const sqlite = openSqliteDatabaseSync({ path: config.storage.path });
return {
  unitOfWork: new SqliteUnitOfWork(sqlite.db),
  ledgerRead: new SqliteLedgerStore(sqlite.db),
  contextProjection: new SqliteContextProjection(sqlite.db),
  summaryDag: new SqliteSummaryDag(sqlite.db),
  artifactStore: new SqliteArtifactStore(sqlite.db),
  conversations: new SqliteConversationStore(sqlite.db),
  operatorExecution: new SqliteOperatorExecutionStore(sqlite.db),
  fileReader: new NodeFileReader(),
};
```

- [ ] **Step 5: Run SDK tests**

Run:

```bash
pnpm --filter @ledgermind/sdk test -- sqlite
pnpm --filter @ledgermind/sdk typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src packages/infrastructure/src/sqlite packages/infrastructure/src/index.ts
git commit -m "feat: expose sqlite memory engine"
```

## Task 11: CLI, MCP, and Claude Storage Config

**Files:**

- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/__tests__/cli.test.ts`
- Modify: `packages/mcp-server/src/config.ts`
- Modify: `packages/mcp-server/src/server.ts` or composition file
- Modify: `packages/mcp-server/src/__tests__/server.integration.test.ts`
- Modify: `packages/claude-code/src/config.ts`
- Modify: `packages/claude-code/src/runtime.ts`
- Modify: `packages/claude-code/src/__tests__/session-start.test.ts`

- [ ] **Step 1: Write failing config parser tests**

Add tests asserting:

```ts
expect(
  parseCockpitConfig({
    argv: ['state', '--storage', 'sqlite', '--sqlite', '.ledgermind/memory.sqlite'],
    env: {},
    cwd,
  }).storage,
).toEqual({ type: 'sqlite', path: resolve(cwd, '.ledgermind/memory.sqlite') });

expect(
  parseMcpServerConfig({
    argv: ['--storage', 'sqlite', '--sqlite', '.ledgermind/memory.sqlite'],
    env: {},
  }).storage,
).toEqual({ type: 'sqlite', path: '.ledgermind/memory.sqlite' });

expect(
  parseClaudeCodeConfig({
    LEDGERMIND_WORKSPACE_ROOT: cwd,
  } as NodeJS.ProcessEnv),
).toMatchObject({
  storage: 'sqlite',
  sqlitePath: resolve(cwd, '.ledgermind/memory.sqlite'),
});
```

- [ ] **Step 2: Run config tests to verify failure**

Run:

```bash
pnpm --filter @ledgermind/cli test -- config
pnpm --filter @ledgermind/mcp-server test -- config
pnpm --filter @ledgermind/claude-code test -- config
```

Expected: FAIL because `--sqlite`, `sqlite` storage, and Claude default SQLite are unsupported.

- [ ] **Step 3: Add runtime storage config types**

Use these shapes:

```ts
export interface SqliteStorageConfig {
  readonly type: 'sqlite';
  readonly path: string;
}

export type CockpitStorageConfig =
  | InMemoryStorageConfig
  | PostgresStorageConfig
  | SqliteStorageConfig;
export type McpServerStorageConfig =
  | { readonly type: 'in-memory' }
  | { readonly type: 'postgres'; readonly connectionString: string }
  | { readonly type: 'sqlite'; readonly path: string };
```

Add `--sqlite` to options-with-values and help text. Resolve relative CLI paths against `cwd`; leave MCP paths as host-provided paths because MCP hosts control working directory.

- [ ] **Step 4: Compose SQLite engines**

In CLI runtime and MCP server composition:

```ts
const engine =
  config.storage.type === 'postgres'
    ? createPostgresMemoryEngine({ connectionString: config.storage.connectionString })
    : config.storage.type === 'sqlite'
      ? createSqliteMemoryEngine({ path: config.storage.path })
      : createInMemoryMemoryEngine();
```

In Claude runtime, compute default SQLite path:

```ts
const defaultSqlitePath = resolve(context.cwd, '.ledgermind/memory.sqlite');
```

Use Postgres if `LEDGERMIND_DB_URL` is set, explicit in-memory only if `LEDGERMIND_CLAUDE_STORAGE=in-memory`, otherwise SQLite.

- [ ] **Step 5: Update non-durable warnings**

Claude hook warning logic should become:

```ts
if (config.storage === 'in-memory') {
  stderr.write(
    'LedgerMind continuity is using in-memory storage; records will not survive process exit. Set LEDGERMIND_SQLITE_PATH or LEDGERMIND_DB_URL for durable memory.\\n',
  );
}
```

No warning should be emitted for SQLite or PostgreSQL.

- [ ] **Step 6: Run runtime tests**

Run:

```bash
pnpm --filter @ledgermind/cli test
pnpm --filter @ledgermind/mcp-server test
pnpm --filter @ledgermind/claude-code test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/mcp-server packages/claude-code
git commit -m "feat: wire sqlite into agent runtimes"
```

## Task 12: End-to-End Restart Smokes

**Files:**

- Create: `tests/regression/sqlite-local-durability.e2e.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add regression test**

Create `tests/regression/sqlite-local-durability.e2e.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteMemoryEngine } from '@ledgermind/sdk';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SQLite local durability', () => {
  it('recalls continuity state after engine recreation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-e2e-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const first = createSqliteMemoryEngine({ path });
    const append = await first.append({
      messages: [{ role: 'user', content: 'The active goal is local durable continuity.' }],
      idempotencyKey: 'sqlite-e2e-start',
    });

    await first.recordContinuity({
      conversationId: append.conversationId,
      kind: 'goal',
      title: 'Local durable continuity',
      content: 'Resume coding-agent work from SQLite after process restart.',
      importance: 'high',
    });

    const second = createSqliteMemoryEngine({ path });
    const recall = await second.recallForTask({
      conversationId: append.conversationId,
      prompt: 'resume local durable continuity task',
      budgetTokens: 600,
    });

    expect(recall.contextBlock).toContain('LedgerMind current state');
    expect(recall.contextBlock).toContain('Local durable continuity');
  });
});
```

- [ ] **Step 2: Add smoke script**

Modify root `package.json`:

```json
"sqlite:smoke": "pnpm vitest run tests/regression/sqlite-local-durability.e2e.test.ts"
```

- [ ] **Step 3: Run smoke**

Run:

```bash
pnpm sqlite:smoke
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/regression/sqlite-local-durability.e2e.test.ts
git commit -m "test: add sqlite local durability smoke"
```

## Task 13: Documentation and Examples

**Files:**

- Modify: `README.md`
- Modify: `docs/agent-continuity-layer.md`
- Modify: `docs/claude-code-integration.md`
- Modify: `docs/testing-strategy.md`
- Modify: `packages/infrastructure/src/sqlite/README.md`
- Modify: `examples/continuity/README.md`
- Modify: `examples/continuity/mcp.json`
- Modify: `examples/continuity/claude-code-settings.json`
- Modify: `examples/claude-code/.mcp.json`
- Modify: `examples/claude-code/settings.json`
- Modify: `examples/ampcode/README.md`
- Modify: `examples/ampcode/mcp-config.json`

- [ ] **Step 1: Update SQLite positioning**

Replace text that says durable memory currently requires PostgreSQL with:

```md
SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.
```

- [ ] **Step 2: Update examples**

Use `.ledgermind/memory.sqlite`:

```json
{
  "mcpServers": {
    "ledgermind": {
      "command": "pnpm",
      "args": [
        "--dir",
        "../..",
        "--filter",
        "@ledgermind/mcp-server",
        "dev",
        "--storage",
        "sqlite",
        "--sqlite",
        ".ledgermind/memory.sqlite",
        "--binding-store",
        ".ledgermind/session-bindings.json",
        "--enable-write-tools"
      ],
      "env": {
        "LEDGERMIND_MCP_RUNTIME": "claude-code"
      }
    }
  }
}
```

- [ ] **Step 3: Update testing strategy**

Change conformance wording to:

```md
Conformance runs against in-memory, PostgreSQL, and SQLite. SQLite is the release gate for the local coding-agent harness.
```

- [ ] **Step 4: Run docs checks**

Run:

```bash
pnpm exec prettier --check README.md docs/agent-continuity-layer.md docs/claude-code-integration.md docs/testing-strategy.md packages/infrastructure/src/sqlite/README.md examples/continuity/README.md examples/continuity/mcp.json examples/continuity/claude-code-settings.json examples/claude-code/.mcp.json examples/claude-code/settings.json examples/ampcode/README.md examples/ampcode/mcp-config.json
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs packages/infrastructure/src/sqlite/README.md examples
git commit -m "docs: document sqlite local durability"
```

## Task 14: Final Verification and Review

**Files:**

- All files touched by Tasks 1-13.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test -- sqlite
pnpm --filter @ledgermind/sdk test -- sqlite
pnpm --filter @ledgermind/cli test
pnpm --filter @ledgermind/mcp-server test
pnpm --filter @ledgermind/claude-code test
```

Expected: PASS.

- [ ] **Step 2: Run conformance**

Run:

```bash
pnpm vitest run --root . tests/conformance --exclude '**/.tmp/**' --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**'
```

Expected: PASS for in-memory and SQLite locally; PostgreSQL passes when the Postgres harness is available.

- [ ] **Step 3: Run regression smoke**

Run:

```bash
pnpm sqlite:smoke
```

Expected: PASS.

- [ ] **Step 4: Run typecheck and smoke commands**

Run:

```bash
pnpm typecheck
pnpm mcp:smoke
pnpm cockpit:smoke
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Request focused review**

Ask reviewers to check:

1. SQLite transaction semantics and rollback behavior.
2. Storage config default change from in-memory to SQLite.
3. Conformance parity with PostgreSQL and in-memory.
4. Documentation truthfulness around `node:sqlite` experimental status.

- [ ] **Step 6: Fix review findings and rerun verification**

For each accepted finding, add or update the smallest focused test that would have caught it, fix the issue, then rerun the relevant command from Steps 1-4.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: add sqlite local durability"
```

---

## Acceptance Checklist

- [ ] `createSqliteMemoryEngine({ path })` exists and is exported from `@ledgermind/sdk`.
- [ ] `createMemoryEngine({ storage: { type: 'sqlite', path } })` works.
- [ ] SQLite implements all persistence ports in `packages/application/src/ports/driven/persistence`.
- [ ] SQLite passes the shared conformance suite.
- [ ] SQLite restart smoke proves continuity recall after engine recreation.
- [ ] CLI supports `--storage sqlite --sqlite <path>`.
- [ ] MCP server supports `--storage sqlite --sqlite <path>`.
- [ ] Claude Code hooks default to `.ledgermind/memory.sqlite` when `LEDGERMIND_DB_URL` is unset.
- [ ] In-memory warnings remain for explicit in-memory mode.
- [ ] Docs position SQLite as local durable default and PostgreSQL as service/shared durability.
- [ ] No domain/application imports from `node:sqlite`, `fs`, or SQL helpers.

## Self-Review

**Spec coverage:** This plan covers the deferred local durability gap, all persistence ports, SDK/runtime wiring, conformance, restart smoke, and docs/examples.

**Placeholder scan:** The plan contains concrete file paths, code shapes, SQL, commands, and expected results for every task. Large adapter sections specify exact class names, method contracts, row mapping rules, and verification gates.

**Type consistency:** The storage type is consistently `sqlite`, the path field is consistently `path` in SDK and `sqlitePath` only in Claude config internals, and the exported preset is consistently `createSqliteMemoryEngine`.
