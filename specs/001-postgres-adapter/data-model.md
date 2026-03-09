# Data Model: PostgreSQL Adapter for Phase 1 Core Engine

This document defines the PostgreSQL persistence data model for `001-postgres-adapter` using the current application port contracts and infrastructure implementation as the source of truth.

## 1) Persistence Boundary Model

### Description
The PostgreSQL adapter persists all Phase 1 memory state for a single conversation scope:
- conversation lifecycle
- immutable ledger append/read/search
- mutable context projection + optimistic versioning
- summary DAG lineage + integrity
- artifact metadata/content
- atomic multi-record mutation via unit of work

### Architectural ownership
- **Port ownership**: `packages/application/src/ports/driven/persistence/**`
- **PostgreSQL implementation ownership**: `packages/infrastructure/src/postgres/**`
- **Schema/migrations ownership**: `packages/infrastructure/src/sql/postgres/migrations/**`

---

## 2) Conversation Record Model (`conversations`)

### Row shape
- `id: text` (PK)
- `parent_id: text | null` (self-reference)
- `model_name: text`
- `context_window: integer > 0`
- `soft_threshold: real`
- `hard_threshold: real`
- `created_at: timestamptz`

### Constraints and invariants
- `id` uniquely identifies one conversation.
- `parent_id` must reference an existing conversation if present.
- `soft_threshold < hard_threshold`.

### Behavioral rules
- Conversation IDs are generated deterministically by ordinal format in current adapter behavior (`conv_000001`, ...).
- Ancestor chain queries return root-to-parent ordering.

---

## 3) Ledger Event Persistence Model (`ledger_events`)

### Row shape
- `id: text` (PK)
- `conversation_id: text` (FK -> `conversations.id`)
- `seq: bigint`
- `role: message_role`
- `content: text`
- `token_count: integer >= 0`
- `occurred_at: timestamptz`
- `metadata: jsonb`
- `idempotency_key: text | null`
- `content_tsv: tsvector` (generated)

### Constraints and indexes
- `UNIQUE (conversation_id, seq)`
- `UNIQUE (conversation_id, idempotency_key)`
- GIN index on `content_tsv`
- btree index on `(conversation_id, seq)`

### Behavioral rules
- Append-only semantics (no adapter path mutates/deletes existing events).
- Sequence remains strictly monotonic and gap-free per conversation.
- Read APIs always return ascending sequence order.
- Search supports:
  - full-text (`plainto_tsquery`) within conversation
  - regex within conversation, optionally scoped by summary subtree

### Idempotency model (required)
- Same idempotency key + same payload => no-op success.
- Same idempotency key + different payload => typed conflict.
- Current schema already supports this model via `UNIQUE (conversation_id, idempotency_key)`.

---

## 4) Context Projection Model (`context_items`, `context_versions`)

### `context_items` row shape
- `conversation_id: text` (FK)
- `position: integer >= 0`
- `message_id: text | null` (FK -> `ledger_events.id`)
- `summary_id: text | null` (FK -> `summary_nodes.id`)

### `context_versions` row shape
- `conversation_id: text` (PK/FK)
- `version: bigint >= 0`

### Constraints and invariants
- `PRIMARY KEY (conversation_id, position)`.
- Exactly one reference target:
  - message ref xor summary ref.
- Position set is contiguous `[0..N-1]`.
- Version increments atomically with each successful append/replace mutation.

### Behavioral rules
- `getCurrentContext()` returns ordered items + version.
- `appendContextItems()` appends to tail and returns new version.
- `replaceContextItems()` requires `expectedVersion` and must throw `StaleContextVersionError` on mismatch.

---

## 5) Summary DAG Persistence Model (`summary_nodes`, `summary_message_edges`, `summary_parent_edges`)

### `summary_nodes` row shape
- `id: text` (PK)
- `conversation_id: text` (FK)
- `kind: summary_kind` (`leaf` | `condensed`)
- `content: text`
- `token_count: integer >= 0`
- `artifact_ids: jsonb` (string array)
- `created_at: timestamptz`

### `summary_message_edges` row shape (leaf -> message)
- `summary_id: text` (FK)
- `message_id: text` (FK)
- `ord: integer`
- PK `(summary_id, message_id)`
- unique ord index `(summary_id, ord)`

### `summary_parent_edges` row shape (condensed -> parent summary)
- `summary_id: text` (FK)
- `parent_summary_id: text` (FK)
- `ord: integer`
- PK `(summary_id, parent_summary_id)`
- unique ord index `(summary_id, ord)`
- `CHECK (summary_id <> parent_summary_id)`

### Constraints and invariants
- Leaf summaries must cover at least one message edge.
- Condensed summaries must cover at least one parent-summary edge.
- All edges remain conversation-local.
- Parent edges must remain acyclic.
- `artifact_ids` must preserve propagated unions from lineage.

### Behavioral rules
- `expandToMessages()` performs recursive lineage walk and returns messages in ascending sequence.
- `checkIntegrity()` returns per-check results for all 8 integrity families.

---

## 6) Artifact Persistence Model (`artifacts`)

### Row shape
- `id: text` (PK)
- `conversation_id: text` (FK)
- `storage_kind: storage_kind` (`path` | `inline_text` | `inline_binary`)
- `original_path: text | null`
- `mime_type: text`
- `token_count: integer >= 0`
- `exploration_summary: text | null`
- `explorer_used: text | null`
- `content_text: text | null`
- `content_binary: bytea | null`
- `created_at: timestamptz`

### Constraints and invariants
- Storage-kind/content shape checks enforce valid payload combinations.
- Artifact metadata access and content access remain open in Phase 1.
- Binary payload reads return defensive clones (`Uint8Array`) to prevent caller mutation leaks.

---

## 7) Atomic Mutation Model (`UnitOfWorkPort` + transaction)

### Transaction boundary
- `UnitOfWorkPort.execute(work)` is the single atomic mutation contract.
- PostgreSQL implementation composes one transaction-scoped executor into:
  - ledger
  - context
  - DAG
  - artifact
  - conversation stores

### Current transaction semantics
- `BEGIN` before callback work.
- `COMMIT` on success.
- `ROLLBACK` on failure.
- map database failures through typed PostgreSQL error mapping.

### Required extension in this feature
- Add bounded internal retry for transient failures before final typed retryable outcome (FR-017 / SC-007).

---

## 8) Error and Retry Classification Model

### Current typed mapping at boundary
- `23505` (unique constraint family)
  - sequence unique => `NonMonotonicSequenceError`
  - other unique violations => `InvariantViolationError`
- `23503` (foreign key) => `InvariantViolationError`
- `23514`, `22P02` => `InvariantViolationError`

### Required additions for this feature
- Explicit transient classification (retryable vs non-retryable).
- Bounded retry policy at transaction/execution boundary.
- Typed retryable failure surface after retry exhaustion.

---

## 9) Integrity Report Model

### Type shape
- `IntegrityReport`
  - `passed: boolean`
  - `checks: IntegrityCheckResult[]`
- `IntegrityCheckResult`
  - `name`
  - `passed`
  - optional `details`
  - optional `affectedIds`

### Required check families
1. `no_orphan_edges`
2. `no_orphan_context_refs`
3. `acyclic_dag`
4. `leaf_coverage`
5. `condensed_coverage`
6. `contiguous_positions`
7. `monotonic_sequence`
8. `artifact_propagation`

---

## 10) Relationship Map

- `conversations` 1 -> N `ledger_events`
- `conversations` 1 -> N ordered `context_items`
- `conversations` 1 -> N `summary_nodes`
- `summary_nodes` (leaf) 1 -> N `summary_message_edges` -> `ledger_events`
- `summary_nodes` (condensed) 1 -> N `summary_parent_edges` -> `summary_nodes`
- `conversations` 1 -> 1 `context_versions`
- `conversations` 1 -> N `artifacts`

---

## 11) Implementation Deltas to Close in This Feature

1. **Idempotency-key enforcement delta**
   - Schema supports `idempotency_key`, but current event insert path writes `NULL`.
   - Feature must align persisted writes with FR-004 idempotency-key semantics.

2. **Bounded retry delta**
   - Current transaction orchestration rolls back and maps errors immediately.
   - Feature must introduce deterministic bounded retry for transient failures (FR-017).

3. **Retryability typing delta**
   - Current mapping covers invariant/constraint families.
   - Feature must add explicit retryable classification and typed exhausted-retry behavior (FR-012/FR-017).

---

## 12) Requirement Mapping Matrix

- FR-001, FR-013 -> Sections 2, 10
- FR-002, FR-003, FR-005 -> Section 3
- FR-004 -> Sections 3, 11
- FR-006, FR-007 -> Section 4
- FR-008, FR-009, FR-014 -> Sections 5, 9
- FR-010 -> Section 6
- FR-011 -> Section 7
- FR-012, FR-017 -> Section 8
- FR-015 -> Sections 2-6
- FR-016 -> Validation scope (PostgreSQL only)
- FR-018 -> Sections 7-8 (correctness/recovery focus)
- FR-019 -> Validation scale applied to Sections 3-7 operations
