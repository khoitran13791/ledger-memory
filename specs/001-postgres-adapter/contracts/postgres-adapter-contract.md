# Contract: PostgreSQL Adapter for Phase 1 Core Engine

This contract defines the required executable behavior for the PostgreSQL persistence implementation in `001-postgres-adapter`, aligned to:

- `specs/001-postgres-adapter/spec.md`
- `specs/001-postgres-adapter/plan.md`
- `specs/001-postgres-adapter/research.md`
- `specs/001-postgres-adapter/data-model.md`
- existing application persistence ports in `packages/application/src/ports/driven/persistence/**`

## 1) Scope and Ownership Contract

### In scope
PostgreSQL persistence behavior for Phase 1 memory state:

1. conversation lifecycle
2. immutable ledger append/read/search
3. context projection with optimistic concurrency
4. summary DAG persistence, expansion, and integrity validation
5. artifact metadata and payload storage
6. transaction-scoped atomic mutation via `UnitOfWorkPort`

### Ownership boundaries
- **Port contracts**: `packages/application/src/ports/driven/persistence/**`
- **PostgreSQL implementation**: `packages/infrastructure/src/postgres/**`
- **Schema/migrations**: `packages/infrastructure/src/sql/postgres/migrations/**`

All dependencies must preserve the clean-architecture rule:

`domain <- application <- adapters <- infrastructure <- sdk`

---

## 2) Port-to-Implementation Contract Map

| Application port | PostgreSQL implementation | Required contract behavior |
|---|---|---|
| `LedgerAppendPort` + `LedgerReadPort` | `pg-ledger-store.ts` | append-only writes, monotonic/gap-free sequence, ordered range/FTS/regex retrieval |
| `ContextProjectionPort` | `pg-context-projection.ts` | contiguous positions, versioned snapshots, stale-write rejection via `StaleContextVersionError` |
| `SummaryDagPort` | `pg-summary-dag.ts` | node/edge persistence, recursive expansion, all 8 integrity checks |
| `ArtifactStorePort` | `pg-artifact-store.ts` | storage-kind shape enforcement, metadata/content retrieval, defensive binary copy |
| `ConversationPort` | `pg-conversation-store.ts` | conversation create/get/ancestor-chain behavior |
| `UnitOfWorkPort` | `pg-unit-of-work.ts` + `transaction.ts` | all-or-nothing transaction boundary with typed error mapping |

---

## 3) Conversation Persistence Contract

### Required behavior
- `create(config, parentId?)` persists one conversation row with validated thresholds.
- `get(id)` returns the persisted conversation or `null`.
- `getAncestorChain(id)` returns IDs ordered root-to-parent.
- IDs remain deterministic ordinal format in current implementation behavior (`conv_000001`, `conv_000002`, ...).

### Invariants
- `context_window > 0`
- `soft_threshold < hard_threshold`
- optional `parent_id` references existing conversation

---

## 4) Ledger Persistence and Retrieval Contract

### Append contract
- `appendEvents(conversationId, events)` must preserve input order and enforce strictly monotonic, gap-free sequence per conversation.
- Existing rows are immutable; mutation/delete behavior is forbidden on ledger records.
- `getNextSequence(conversationId)` remains an active contract in Phase 1 and must be transaction-safe.

### Idempotency contract (FR-004)
- same idempotency key + same logical payload => no-op success
- same idempotency key + different payload => typed idempotency conflict

### Retrieval contract
- `getEvents` returns ascending sequence order (with inclusive range bounds when provided)
- `searchEvents` performs conversation-scoped full-text search
- `regexSearchEvents` performs conversation-scoped regex search with optional summary-subtree scope
- all retrieval outputs remain deterministic for equivalent persisted state

### Current implementation delta to close
- Schema supports `idempotency_key`, but the current event insert path writes `NULL`; feature work must align persisted write behavior to idempotency semantics.

---

## 5) Context Projection Contract

### Read contract
`getCurrentContext(conversationId)` returns:
- ordered contiguous `ContextItem[]`
- current `ContextVersion`

### Mutation contract
- `appendContextItems` appends to the tail, preserves contiguity, increments version.
- `replaceContextItems` requires `expectedVersion`.
- version mismatch must throw `StaleContextVersionError` and must not alter persisted context state.

### Invariants
- exactly one reference per row (`message_id` xor `summary_id`)
- positions are contiguous `[0..N-1]`
- every successful mutation increments version atomically

---

## 6) Summary DAG Contract

### Node and edge contract
- `createNode` persists `leaf` and `condensed` nodes with conversation-local scope.
- `addLeafEdges` links leaf summary -> ledger messages.
- `addCondensedEdges` links condensed summary -> parent summaries.
- parent-edge cycles are forbidden.
- self-edge (`summary_id == parent_summary_id`) is forbidden.

### Expansion contract
`expandToMessages(summaryId)` must recursively resolve lineage and return source messages ordered by ascending sequence.

### Integrity contract
`checkIntegrity(conversationId)` must return `IntegrityReport` with per-check results for all required families:

1. `no_orphan_edges`
2. `no_orphan_context_refs`
3. `acyclic_dag`
4. `leaf_coverage`
5. `condensed_coverage`
6. `contiguous_positions`
7. `monotonic_sequence`
8. `artifact_propagation`

---

## 7) Artifact Store Contract

### Storage contract
- `store(artifact, content?)` persists metadata plus payload columns matching `storage_kind`.
- payload types remain platform-neutral (`string | Uint8Array`).

### Retrieval contract
- `getMetadata(id)` returns persisted metadata or `null`.
- `getContent(id)` returns persisted payload or `null`.
- binary payload reads must return defensive copies (`Uint8Array`) to prevent mutation leaks.

### Exploration metadata contract
`updateExploration(id, summary, explorerUsed)` updates exploration fields for existing artifacts; unknown IDs are typed failures.

---

## 8) Unit of Work / Transaction Contract

### Atomicity contract
`UnitOfWorkPort.execute(work)` is the only supported multi-record mutation boundary.

For each execution:
1. `BEGIN`
2. execute callback with transaction-scoped stores
3. `COMMIT` on success
4. `ROLLBACK` on failure

No partial writes may be externally visible after failed execution.

### Required retry extension (FR-017)
The PostgreSQL transaction boundary must include bounded internal retries for transient failures before returning a typed retryable failure.

### Current implementation deltas to close
1. add bounded transient retry policy in transaction orchestration
2. add explicit retryable-vs-non-retryable classification at PostgreSQL boundary
3. return typed retryable exhaustion outcome after retry limit

---

## 9) Error Mapping and Retryability Contract

### Existing mapping contract
- SQLSTATE `23505`:
  - ledger sequence unique => `NonMonotonicSequenceError`
  - other unique violations => `InvariantViolationError`
- SQLSTATE `23503` => `InvariantViolationError`
- SQLSTATE `23514` / `22P02` => `InvariantViolationError`

### Required extension
- classify transient PostgreSQL/driver failures as retryable
- retry only retryable classes under bounded policy
- keep non-retryable classes fail-fast with typed errors

---

## 10) Schema and Migration Contract

Migrations must provide and preserve these required persistence structures:

- tables: `conversations`, `ledger_events`, `summary_nodes`, `summary_message_edges`, `summary_parent_edges`, `context_items`, `context_versions`, `artifacts`
- enums: `message_role`, `summary_kind`, `storage_kind`
- key constraints:
  - `UNIQUE (conversation_id, seq)`
  - `UNIQUE (conversation_id, idempotency_key)`
  - context xor check for `message_id`/`summary_id`
  - artifact storage-kind shape checks
- key indexes:
  - ledger `(conversation_id, seq)`
  - ledger GIN on `content_tsv`
  - summary/context/artifact conversation indexes

---

## 11) Verification Contract (FR/SC Alignment)

### Functional alignment
- FR-001..FR-011, FR-013..FR-015: covered by port/store/schema behavior above
- FR-012, FR-017: covered by retryability + bounded retry extension contract
- FR-016: PostgreSQL-only conformance/golden/regression validation in this feature
- FR-018: reliability validation focuses on correctness, rollback, retry/recovery
- FR-019: validation must cover up to 10,000 events/conversation and 100 concurrent conversations

### Success criteria alignment
- SC-001/SC-005: conformance + integrity checks pass
- SC-002/SC-003: recovery and concurrency correctness without corruption
- SC-004/SC-008: latency and scale targets validated on PostgreSQL scope
- SC-006: no open high-severity persistence regressions at sign-off
- SC-007: transient failure scenarios satisfy bounded retry outcomes

---

## 12) Out-of-Scope Guardrails

This contract explicitly excludes:

- SQLite parity in this feature
- multi-tenant/server-mode concerns
- framework-specific runtime type leakage into domain/application
- expansion of non-Phase-1 persistence capabilities
