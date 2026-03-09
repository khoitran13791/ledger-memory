# Data Model: Phase 1 Core Use Cases

This feature uses the existing domain model and application contract types to define executable behavior for append, compaction, materialization, retrieval, artifact flows, and integrity checks.

## 1) Conversation Runtime Context

### Description
Conversation is the runtime boundary for all Phase 1 operations (append/materialize/compaction/retrieval/artifact/integrity).

### Core Fields (existing domain type)
- `id: ConversationId`
- `parentId: ConversationId | null`
- `config: ConversationConfig`
  - `modelName: string`
  - `contextWindow: TokenCount`
  - `thresholds: CompactionThresholds`

### Behavioral Rules in this feature
- Every use-case call is scoped by `conversationId`.
- Budget math for materialization and compaction uses conversation config.
- Parent lineage can be consulted for authorization/context inheritance where required.

---

## 2) Ledger Event Append Flow Model

### Description
Represents immutable event intake from callers and its transformation into ordered persisted ledger records and active context entries.

### Input Model
- `AppendLedgerEventsInput`
  - `conversationId: ConversationId`
  - `events: NewLedgerEvent[]`
  - `idempotencyKey?: string`

### Derived/Persisted Model
- `LedgerEvent`
  - deterministic `id` from canonical hash fields
  - conversation-local sequence ordering
  - immutable content + metadata

### Output Model
- `AppendLedgerEventsOutput`
  - `appendedEvents: LedgerEvent[]`
  - `contextTokenCount: TokenCount`

### Behavioral Rules
- Append operations are atomic per call.
- Duplicate idempotency with same payload is treated as no-op success.
- Key reuse with different payload returns typed conflict.
- Successful append may trigger non-blocking compaction scheduling when soft threshold is crossed.

---

## 3) Active Context Projection Model

### Description
Represents mutable, ordered model-input projection over ledger events and summary nodes.

### Core Types
- `ContextItem`
  - `conversationId`
  - `position`
  - `ref` => message or summary
- Context snapshot contract:
  - `items: ContextItem[]`
  - `version: ContextVersion`

### Behavioral Rules
- Positions remain contiguous.
- Replacement operations require `expectedVersion`.
- Version mismatch raises explicit stale conflict and must not silently overwrite.
- Projection state is treated as mutable view, not source of truth.

---

## 4) Compaction Candidate and Escalation Model

### Description
Defines the decision model for selecting compaction blocks and generating accepted replacement summaries.

### Candidate Model
- Ordered context items with token counts
- Pin inputs:
  - system message pinning
  - tail window pinning
  - caller-provided `PinRule[]`
- Candidate block must be:
  - oldest contiguous non-pinned items
  - size >= `minBlockSize`
  - token target guided by configured fraction of available budget

### Escalation Model
- Summarization modes:
  - `normal`
  - `aggressive`
  - deterministic fallback
- Acceptance rule:
  - accept L1/L2 only when `outputTokens < inputTokens`
  - otherwise escalate

### Round Output Model
- `RunCompactionOutput`
  - `rounds`
  - `nodesCreated: SummaryNodeId[]`
  - `tokensFreed: TokenCount`
  - `converged: boolean`

### Behavioral Rules
- Hard-trigger compaction returns typed non-convergence failure when max rounds reached without budget satisfaction.
- Deterministic fallback guarantees bounded output and termination path.

---

## 5) Materialized Context Model

### Description
Represents final model-ready payload for runtime inference calls.

### Input Model
- `MaterializeContextInput`
  - `conversationId`
  - `budgetTokens`
  - `overheadTokens`
  - optional `pinRules`
  - optional `retrievalHints`

### Output Model
- `MaterializeContextOutput`
  - `systemPreamble: string`
  - `modelMessages: ModelMessage[]`
  - `summaryReferences: SummaryReference[]`
  - `artifactReferences: ArtifactReference[]`
  - `budgetUsed: TokenCount`

### Behavioral Rules
- Available budget computed before output assembly.
- If over hard threshold, blocking compaction runs before final materialization.
- Output is never above available budget unless typed budget/convergence error is returned.

---

## 6) Retrieval Workflow Model (`grep` -> `describe` -> `expand`)

### Description
Provides discoverability and recoverability over compacted history.

### `grep` Model
- Input: `conversationId`, regex/pattern, optional summary scope
- Output: `GrepMatch[]` with sequence, excerpt, and optional covering summary

### `describe` Model
- Input: `SummaryNodeId | ArtifactId`
- Output:
  - kind (`summary` | `artifact`)
  - metadata payload
  - token count
  - optional parent IDs / exploration summary

### `expand` Model
- Input: `summaryId`, `callerContext`
- Output: ordered source `LedgerEvent[]`

### Behavioral Rules
- Retrieval remains conversation-scoped.
- Expand requires positive authorization decision.
- Unknown IDs return explicit typed invalid-reference failures.

---

## 7) Artifact Storage and Exploration Model

### Description
Represents externalized large content references and exploration metadata used during compaction and retrieval.

### Storage Input Model
- `StoreArtifactInput`
  - `conversationId`
  - `source` (`path` | `text` | `binary`)
  - optional `mimeType`

### Storage Output Model
- `StoreArtifactOutput`
  - `artifactId`
  - `tokenCount`

### Exploration Input/Output Model
- `ExploreArtifactInput`
  - `artifactId`
  - optional explorer hints
- `ExploreArtifactOutput`
  - `explorerUsed`
  - `summary`
  - `metadata`
  - `tokenCount`

### Behavioral Rules
- Artifact IDs are stable/content-addressed by design primitives.
- Metadata/content access is open in Phase 1.
- Compaction-generated summaries preserve artifact ID unions from source lineage.

---

## 8) Integrity Report Model

### Description
Represents verification status for DAG/projection/sequence/artifact-propagation invariants.

### Types
- `IntegrityReport`
  - `passed: boolean`
  - `checks: IntegrityCheckResult[]`
- `IntegrityCheckResult`
  - `name`
  - `passed`
  - optional `details`
  - optional `affectedIds`

### Behavioral Rules
- Report contains per-check status, not a single opaque boolean.
- Phase 1 validates all defined checks across in-memory and PostgreSQL implementations.

---

## 9) Application Failure Model (Typed Failures)

### Description
Captures explicit failure families required by Phase 1 orchestration.

### Failure Families in Scope
- Invalid reference (unknown summary/artifact/event references)
- Stale context version conflict
- Authorization denial for guarded expansion
- Budget exceeded / compaction non-convergence
- Idempotency conflict (same key, different payload)

### Behavioral Rules
- Failures are explicit and typed.
- Failure paths must not leave partial/corrupted state.
- Errors should be transport-agnostic (application/domain level).

---

## 10) Relationship Map

- `Conversation` 1 -> N `LedgerEvent`
- `Conversation` 1 -> N ordered `ContextItem`
- `Conversation` 1 -> N `SummaryNode`
- `SummaryNode` DAG edges -> source messages or parent summaries
- `SummaryNode` artifact IDs = union of artifact IDs reachable from covered lineage
- `MaterializeContextOutput` references both summary and artifact IDs for downstream retrieval flows

---

## 11) Requirement Mapping Matrix

- FR-001, FR-002 => Sections 2, 9
- FR-003 => Section 3
- FR-004, FR-011 => Section 5
- FR-005, FR-006 => Sections 2, 5
- FR-007, FR-008, FR-009, FR-010 => Section 4
- FR-012 => Section 6
- FR-013 => Section 7
- FR-014 => Section 8
- FR-015 => Sections 2, 4, 5, 7
- FR-016 => Section 9
