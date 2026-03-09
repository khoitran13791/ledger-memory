# Data Model: Port Interface Contracts

This feature defines contract-level models used by application-layer ports. Models below are behavioral/interface models, not persistence schemas.

## 1) Driving Port Contract Model

### Description
Represents outward-facing capabilities exposed to runtimes integrating LedgerMind.

### Components
- `MemoryEngine` contract
  - `append(...)`
  - `materializeContext(...)`
  - `runCompaction(...)`
  - `checkIntegrity(...)`
  - `grep(...)`
  - `describe(...)`
  - `expand(...)`
  - `storeArtifact(...)`
  - `exploreArtifact(...)`
- `ToolProviderPort` contract
  - framework tool definition creation from `MemoryEngine`
- `DomainEventSubscriber` contract
  - event subscription callback

### Invariants / Behavioral Rules
- Driving contracts must remain framework-agnostic.
- Driving contracts must map to Phase 1 use-case responsibilities without leaking adapter details.
- Inputs/outputs must be sufficient to express bounded-token context operations.

---

## 2) Driven Persistence Contract Model

### Description
Segregated inbound capabilities required by application use cases.

### Contract Families
- `LedgerAppendPort`
  - append operation with internal sequence assignment semantics
- `LedgerReadPort`
  - ordered event retrieval + keyword/full-text + regex search contracts (conversation-scoped)
- `ContextProjectionPort`
  - read current context snapshot and mutate via append/replace semantics with explicit expected version behavior
- `SummaryDagPort`
  - create/retrieve summary nodes, edge creation, expansion, search, integrity report retrieval
- `ArtifactStorePort`
  - metadata/content storage and retrieval for text/binary payloads with platform-neutral representation
- `ConversationPort`
  - conversation creation and lineage retrieval

### Invariants / Behavioral Rules
- Interface segregation is mandatory: unrelated concerns must not merge into one contract.
- Retrieval/search contracts are conversation-scoped in Phase 1.
- Search requirement scope: keyword/full-text + regex only (no semantic/vector contract requirement).
- Ordering semantics must be explicit where sequence/position is involved.
- Versioned mutation paths must signal stale conflicts explicitly and must not silently overwrite.
- Artifact metadata/content access is open to normal callers in Phase 1.

---

## 3) Transaction Boundary Contract Model

### Description
Atomic execution boundary for grouped persistence capabilities.

### Components
- `UnitOfWorkPort`
  - `execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>`
- `UnitOfWork`
  - capability bundle for persistence concerns used in one transactional scope

### Invariants / Behavioral Rules
- Work callback executes as one atomic logical unit.
- All contained capability operations share one consistency boundary.
- Contract must support deterministic failure propagation for conflict/error cases.

---

## 4) LLM and Tokenization Contract Model

### Description
Provider-agnostic abstractions for summarization and token accounting.

### Components
- `SummarizerPort`
  - summarization operation with mode/target semantics
- `TokenizerPort`
  - token counting and byte-length estimation

### Invariants / Behavioral Rules
- Contracts must not depend on concrete model SDK types.
- Token counts are represented by domain-safe token value contracts.

---

## 5) Explorer Contract Model

### Description
Type-aware artifact exploration capability and registry resolution.

### Components
- `ExplorerPort`
  - capability scoring and exploration operation
- `ExplorerRegistryPort`
  - registration and deterministic resolution

### Invariants / Behavioral Rules
- Explorer contracts are independent from storage/provider internals.
- Registry resolution semantics must be explicit and deterministic.

---

## 6) Infrastructure Capability Contract Model

### Description
Supporting external capabilities required by application orchestration.

### Components
- `JobQueuePort`
  - enqueue and completion subscription semantics
- `AuthorizationPort`
  - guarded operation permission checks (expansion gating required)
- `ClockPort`
  - stable time source abstraction
- `HashPort`
  - SHA-256 abstraction over `Uint8Array`

### Invariants / Behavioral Rules
- Infrastructure capabilities are modeled as abstractions owned by application contracts.
- Expansion authorization must be explicitly represented.
- Hash contract must remain runtime-independent and binary-type portable.

---

## 7) Cross-Contract Supporting Types

### Description
Shared contract entities required for compile-time compatibility and conformance planning.

### Types in Scope
- Input/output DTO shapes for driving operations
- `CallerContext` shape for guarded operations
- `IntegrityReport` and `IntegrityCheckResult` contract shape
- Sequence/position/version-related value-object usage

### Invariants / Behavioral Rules
- Supporting types must be sufficient to derive conformance checks without implementation-specific assumptions.
- Integrity report shape must carry pass/fail status and per-check detail payload.

---

## 8) Relationship Map

- `MemoryEngine` depends on all required use-case DTO contracts.
- Use-case orchestration depends on driven port families (`persistence`, `llm`, `explorer`, `jobs`, `auth`, `clock`, `crypto`).
- `UnitOfWorkPort` composes persistence capabilities into a single transactional boundary.
- `AuthorizationPort` directly constrains guarded expansion behavior.
- `HashPort` and binary content contracts align with addendum portability decisions.

---

## 9) Validation Matrix (Spec Requirement Mapping)

- FR-001: Section 1 (driving contracts)
- FR-002: Section 2 (segregated persistence driven contracts)
- FR-003: Section 3 (transaction boundary)
- FR-004: Section 4 (summarizer/tokenizer abstractions)
- FR-005: Section 5 (explorer + registry)
- FR-006: Section 6 (jobs/auth/clock/hash)
- FR-007 + FR-007a: Section 2 (versioned mutation + stale conflict signaling)
- FR-008: Section 2 (`LedgerAppendPort` append-internal sequence assignment semantics)
- FR-009: Sections 2 + 7 (ordering/position expectations)
- FR-010 + FR-010a: Section 2 (conversation scope + keyword/regex search only)
- FR-011: Sections 2 + 6 (`Uint8Array`/platform-neutral binary handling)
- FR-012 + FR-012a: Section 6 + Section 2 (expansion authorization + open artifact access)
- FR-013: Section 2 (interface segregation)
- FR-014: Sections 1-7 (conformance derivation readiness)
- FR-015: All sections (framework-agnostic contract modeling)
- FR-016: Sections 2 + 6 + 7 (addendum alignment)
