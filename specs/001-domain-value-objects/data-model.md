# Data Model: Domain Package Foundations

## 1) Conversation (Aggregate Root)

### Description
Represents a single memory timeline and root configuration for context and compaction behavior.

### Fields
- `id: ConversationId`
- `parentId: ConversationId | null`
- `config: ConversationConfig`
- `createdAt: Timestamp`

### Nested Types
- `ConversationConfig`
  - `modelName: string`
  - `contextWindow: TokenCount`
  - `thresholds: CompactionThresholds`

### Invariants
- `contextWindow.value > 0`
- `thresholds.soft < thresholds.hard`
- `thresholds.soft > 0` and `thresholds.hard > 0`

### Related Domain Errors
- `InvariantViolationError` for invalid threshold ordering / non-positive context window.

---

## 2) LedgerEvent (Immutable Entity)

### Description
Atomic historical entry (system/user/assistant/tool) in append-only ledger semantics.

### Fields
- `id: EventId`
- `conversationId: ConversationId`
- `sequence: SequenceNumber`
- `role: MessageRole` (`system | user | assistant | tool`)
- `content: string`
- `tokenCount: TokenCount`
- `occurredAt: Timestamp`
- `metadata: EventMetadata` (shape kept domain-safe and serializable)

### Invariants
- `tokenCount.value >= 0`
- `sequence` must represent a positive monotonic domain value
- Entity is immutable after creation

### Identity Rule (Authoritative)
- Prefix: `evt_`
- Canonical hashed fields: `{ content, conversationId, role, sequence }`
- Excluded fields: `occurredAt`, `metadata`

### Related Domain Errors
- `HashMismatchError` when reconstructed ID and payload mismatch.
- `NonMonotonicSequenceError` when sequence semantics are violated.

---

## 3) SummaryNode (Entity)

### Description
DAG node for compaction output. Can summarize raw events (`leaf`) or parent summaries (`condensed`).

### Fields
- `id: SummaryNodeId`
- `conversationId: ConversationId`
- `kind: SummaryKind` (`leaf | condensed`)
- `content: string`
- `tokenCount: TokenCount`
- `artifactIds: ArtifactId[]`
- `createdAt: Timestamp`

### Invariants
- `tokenCount.value >= 0`
- `leaf` nodes must have >=1 covered message edge (validated by integrity flow)
- `condensed` nodes must have >=1 covered parent-summary edge (validated by integrity flow)
- `artifactIds` must preserve source-union semantics

### Identity Rule
- Prefix: `sum_`
- Canonical hashed fields: `{ content, conversationId, kind }`
- Excluded fields: `createdAt`, `tokenCount`, `artifactIds`

### Related Domain Errors
- `InvalidDagEdgeError` for invalid edge semantics.
- `InvariantViolationError` for invalid kind/content/token state.

---

## 4) DagEdge (Entity/Union)

### Description
Directed provenance relationship used by summary DAG.

### Variants
- Leaf edge:
  - `summaryId: SummaryNodeId`
  - `messageId: EventId`
  - `order: number`
- Condensed edge:
  - `summaryId: SummaryNodeId`
  - `parentSummaryId: SummaryNodeId`
  - `order: number`

### Invariants
- Exactly one source reference kind per edge variant.
- `order` is contiguous and non-negative within a summary edge set.

### Related Domain Errors
- `InvalidDagEdgeError`

---

## 5) ContextItem (Projection Entity)

### Description
Ordered active-context pointer to either raw message or summary node.

### Fields
- `conversationId: ConversationId`
- `position: number`
- `ref: ContextItemRef`

### Ref Variants
- `{ type: "message", messageId: EventId }`
- `{ type: "summary", summaryId: SummaryNodeId }`

### Invariants
- Position is non-negative.
- Context positions are contiguous without gaps (integrity contract).
- Ref points to an existing target at adapter/application validation time.

### Related Domain Errors
- `InvariantViolationError` (invalid position/ref shape)

---

## 6) Artifact (Entity)

### Description
Reference to large externalized content or inline payload with exploration metadata.

### Fields
- `id: ArtifactId`
- `conversationId: ConversationId`
- `storageKind: StorageKind` (`path | inline_text | inline_binary`)
- `originalPath: string | null`
- `mimeType: MimeType`
- `tokenCount: TokenCount`
- `explorationSummary: string | null`
- `explorerUsed: string | null`

### Invariants
- `tokenCount.value >= 0`
- If `storageKind === "path"`, then `originalPath` must be non-null and non-empty.

### Identity Rule
- Prefix: `file_`
- Canonical hashed fields: `{ contentHash }`, where `contentHash` is SHA-256 of raw bytes.
- Excluded fields: `originalPath`, `mimeType`, `tokenCount`

### Related Domain Errors
- `HashMismatchError`
- `InvariantViolationError`

---

## 7) Value Objects

## 7.1 Branded IDs / Scalars
- `ConversationId`
- `EventId`
- `SummaryNodeId`
- `ArtifactId`
- `SequenceNumber`
- `ContextVersion`
- `MimeType`
- `Timestamp`

## 7.2 Token and Budget Objects
- `TokenCount { value: number }`
  - Invariant: `value >= 0`
- `TokenBudget`
  - `contextWindow`
  - `overhead`
  - `reserve`
  - `available`
  - Invariant: `available.value >= 0`
- `CompactionThresholds`
  - `soft: number`
  - `hard: number`
  - Invariant: `0 < soft < hard`

## 7.3 Enumerations / Unions
- `MessageRole = "system" | "user" | "assistant" | "tool"`
- `SummaryKind = "leaf" | "condensed"`
- `StorageKind = "path" | "inline_text" | "inline_binary"`

---

## 8) Domain Services

## 8.1 TokenBudgetService

### Responsibilities
- Compute available budget from config and overhead.
- Evaluate soft/hard threshold crossings.
- Compute target free tokens per policy.

### Determinism
Pure arithmetic and comparisons; no external side effects.

## 8.2 CompactionPolicyService

### Responsibilities
- Select compaction candidates from ordered context and pin rules.
- Decide escalation (`shouldEscalate`) based on input/output token comparison.

### Rules
- Candidate block formed from oldest non-pinned contiguous items.
- `minBlockSize` and token-target fraction enforced.
- Escalate when `outputTokens >= inputTokens`.

## 8.3 IdService

### Responsibilities
- Canonical serialization of hashing payloads.
- Prefix + SHA-256 ID derivation for events, summaries, artifacts.

### Dependencies
- Abstract hashing primitive (`HashPort` contract) consumed without importing runtime crypto in domain.

---

## 9) Domain Events

### Event Types in Scope
- `LedgerEventAppended`
- `CompactionTriggered`
- `SummaryNodeCreated`
- `CompactionCompleted`
- `ArtifactStored`
- `ContextMaterialized`

### Shared Characteristics
- Immutable payloads
- Branded IDs and value objects in payload
- Semantically stable type names for application-layer consumption

---

## 10) Domain Errors

### Base
- `DomainError` with stable `code`

### Specialized
- `InvalidDagEdgeError`
- `HashMismatchError`
- `BudgetExceededError` (negative/unusable budget semantics)
- `InvariantViolationError`
- `NonMonotonicSequenceError`

---

## 11) Key Relationships

- `Conversation` 1 -> N `LedgerEvent`
- `Conversation` 1 -> N `SummaryNode`
- `SummaryNode` 1 -> N `DagEdge`
- `Conversation` 1 -> N ordered `ContextItem`
- `Conversation` 1 -> N `Artifact`
- `SummaryNode.artifactIds` derives from source `LedgerEvent`/parent `SummaryNode` lineage

---

## 12) Validation Matrix (Requirement Mapping)

- FR-001: Covered by entity sections 1-6.
- FR-002: Covered by value-object section 7.
- FR-003: Token non-negativity in entities/value objects.
- FR-004: Conversation config invariants.
- FR-005/FR-006/FR-007: ID rules and deterministic canonicalization.
- FR-008: Domain service responsibilities in section 8.
- FR-009: Domain event contract in section 9.
- FR-010: Domain error taxonomy in section 10.
- FR-011: Dependency-free domain constraint reflected in all design choices.
- FR-012: Context versioning + artifact propagation semantics represented across sections 7, 3, 11.
