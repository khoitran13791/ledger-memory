# Research: Phase 1 Core Use Cases

## Decision 1: Implement core use-case orchestration in `packages/application/src/use-cases` using existing ports

- **Decision**: Build all Phase 1 core use cases (`append`, `materializeContext`, `runCompaction`, `grep`, `describe`, `expand`, `storeArtifact`, `exploreArtifact`, `checkIntegrity`) inside `packages/application/src/use-cases`, consuming already-defined driving/driven ports.
- **Rationale**:
  - The repository already contains stable driving contracts in `packages/application/src/ports/driving/memory-engine.port.ts` and driven contracts in `packages/application/src/ports/driven/**`.
  - Clean Architecture ownership is preserved: use cases depend on domain + application ports only.
  - Spec FR-001..FR-016 explicitly target orchestration behavior, not contract redefinition.
- **Alternatives considered**:
  - Implement core logic directly in adapters or sdk.
    - Rejected because it violates dependency inversion and would couple business rules to outer layers.

## Decision 2: Treat domain + port contracts as fixed Phase 1 anchors

- **Decision**: Reuse existing domain primitives and application contracts without changing their conceptual boundaries.
- **Rationale**:
  - Domain package is already implemented with entities/services/events/errors and deterministic ID primitives.
  - Application ports already encode key clarified constraints: no standalone sequence allocation, explicit stale version conflict, conversation-scoped search, open artifact metadata/content in Phase 1, `Uint8Array` contracts.
  - Reducing contract churn lowers risk and keeps implementation focused on behavior.
- **Alternatives considered**:
  - Redesign port families before use-case work.
    - Rejected as unnecessary scope expansion and a source of avoidable rework.

## Decision 3: Preserve idempotent append semantics with conflict signaling

- **Decision**: `append` behavior must support idempotency key semantics with deterministic no-op vs conflict outcomes.
- **Rationale**:
  - Spec FR-002 and edge cases require:
    - same key + same payload => no-op success,
    - same key + different payload => explicit conflict.
  - This must be observable at use-case level while preserving immutable event semantics (FR-001).
- **Alternatives considered**:
  - Best-effort dedup by content only.
    - Rejected because it cannot satisfy explicit key-reuse conflict semantics.

## Decision 4: Use optimistic context versioning and typed stale conflicts during compaction

- **Decision**: `runCompaction` and any context replacement flow must rely on `expectedVersion` and handle `StaleContextVersionError` explicitly.
- **Rationale**:
  - Addendum requires optimistic locking semantics for context projection.
  - Existing contract in `context-projection.port.ts` requires stale conflict signaling and forbids silent overwrite.
  - Spec FR-016 requires typed failures without partial state corruption.
- **Alternatives considered**:
  - Last-write-wins replacement for context mutations.
    - Rejected because it breaks correctness guarantees and deterministic failure behavior.

## Decision 5: Enforce compaction escalation contract with deterministic fallback termination

- **Decision**: Compaction must enforce L1 normal -> L2 aggressive -> L3 deterministic fallback, accepting L1/L2 only when they shrink token size.
- **Rationale**:
  - Spec FR-008..FR-010 and addendum define escalation and non-convergence behavior.
  - Deterministic fallback provides guaranteed bounded output and convergence properties for hard-trigger paths.
  - Regression tests must verify escalation behavior for non-shrinking outputs.
- **Alternatives considered**:
  - Retry normal summarization multiple times.
    - Rejected because retries do not provide deterministic convergence guarantees.

## Decision 6: Keep retrieval workflow conversation-scoped with explicit authorization gate on `expand`

- **Decision**: Implement retrieval flows as:
  - `grep` => regex/pattern search with optional summary scope,
  - `describe` => metadata for summary/artifact IDs,
  - `expand` => source message recovery with authorization checks.
- **Rationale**:
  - Spec FR-012 and user story 2 acceptance scenarios require searchable, auditable, recoverable compacted history.
  - Existing `AuthorizationPort.canExpand` is the guardrail for authorized callers.
  - Clarification keeps artifact metadata/content access open in Phase 1, but expansion remains gated.
- **Alternatives considered**:
  - Gate all retrieval operations behind authorization.
    - Rejected because it exceeds accepted Phase 1 scope and contradicts clarified artifact access behavior.

## Decision 7: Preserve artifact ID union across all summary generations

- **Decision**: Summary creation and condensation must preserve the full union of source artifact IDs.
- **Rationale**:
  - Spec FR-013 and SC-007 require zero artifact reference loss across multi-round compaction.
  - Addendum integrity check #8 explicitly validates artifact propagation.
  - This must be encoded in both compaction behavior and integrity verification tests.
- **Alternatives considered**:
  - Preserve only directly referenced artifacts for current compaction block.
    - Rejected because transitive artifact lineage would be lost during condensation.

## Decision 8: Keep persistence validation scope to in-memory and PostgreSQL only

- **Decision**: Phase 1 conformance and regression validation target exactly two backends: in-memory and PostgreSQL.
- **Rationale**:
  - Explicit clarification in `spec.md` sets backend scope.
  - Keeps implementation tractable while still validating adapter parity across ephemeral and persistent stores.
- **Alternatives considered**:
  - Include SQLite now.
    - Rejected as out of scope for this feature.

## Decision 9: Use deterministic test doubles for golden/replay stability

- **Decision**: Use `DeterministicSummarizer` and `SimpleTokenizer` for deterministic replay, golden, and escalation-path tests.
- **Rationale**:
  - Addendum specifies deterministic stubs and behavior expectations.
  - Spec SC-003 and SC-004 require deterministic replay and escalation correctness.
  - Reduces flakiness while validating algorithmic behavior.
- **Alternatives considered**:
  - Use live provider-backed summarization in all tests.
    - Rejected due to nondeterminism and inability to prove replay stability.

## Decision 10: Keep transaction boundaries explicit with UnitOfWork

- **Decision**: Use `UnitOfWorkPort.execute` as the atomic boundary for multi-port mutations (append + context updates + dag edges + artifact updates).
- **Rationale**:
  - Existing contract in `unit-of-work.port.ts` defines rollback/commit semantics.
  - Spec FR-016 requires no partial state corruption on failure.
  - Ensures parity between in-memory and PostgreSQL mutation behavior.
- **Alternatives considered**:
  - Execute each port operation independently without shared transaction boundary.
    - Rejected because partial writes could violate integrity and failure guarantees.

## Decision 11: Phase sequence prioritizes deterministic behavior before production persistence

- **Decision**: Implement and validate in this order:
  1. in-memory adapters + deterministic stubs,
  2. core use cases,
  3. retrieval/artifact/integrity use cases,
  4. PostgreSQL adapters + migrations + parity tests,
  5. sdk composition.
- **Rationale**:
  - Earliest phases maximize feedback on core behavior and failure semantics before SQL concerns.
  - Supports incremental verification aligned to SC-001..SC-007.
- **Alternatives considered**:
  - Start with PostgreSQL schema and adapters first.
    - Rejected because behavior bugs become harder to isolate when persistence complexity is introduced too early.
