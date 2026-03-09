# Feature Specification: PostgreSQL Adapter for Phase 1 Core Engine

**Feature Branch**: `[001-postgres-adapter]`
**Created**: 2026-03-02
**Status**: Draft
**Input**: User description: "i would like to implement `PostgreSQL adapter` section in `Phase 1 — Core Engine (Extract + Stabilize)` of @docs/high-level-design.md and @docs/design-decisions-addendum.md"

## Clarifications

### Session 2026-03-02

- Q: Should this feature include PostgreSQL schema and migration delivery, or only adapter code that assumes an existing schema? → A: Include adapter implementation and required schema/migrations for Phase 1.
- Q: Should this feature require PostgreSQL-only conformance now, or include cross-backend parity checks in this scope? → A: Require PostgreSQL-complete implementation and PostgreSQL conformance only; cross-backend parity is deferred.
- Q: For transient database failures, should the adapter fail immediately, retry internally, or defer writes asynchronously? → A: Perform bounded internal retry for transient failures, then return typed retryable errors if still failing.
- Q: Should this feature include a hard availability objective now, or defer uptime/SLO commitments to a later phase? → A: Keep reliability scope to correctness, atomicity, retries, and recovery behavior; defer uptime/SLO targets.
- Q: What validation scale should this feature assume for acceptance and performance checks? → A: Use small-scale validation up to 10k events per conversation and up to 100 concurrent conversations.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persistent Memory Operations (Priority: P1)

As an SDK integrator, I want the memory engine to persist and retrieve conversation data through PostgreSQL so that agent sessions can continue reliably across process restarts.

**Why this priority**: Without reliable persistence, Phase 1 core memory behavior is not usable in real workflows.

**Independent Test**: Create a conversation, append events, stop and restart the runtime, then materialize context and verify the same conversation state is recovered.

**Acceptance Scenarios**:

1. **Given** an empty database and a valid conversation request, **When** events are appended and later read back, **Then** the system returns the same events in the correct order.
2. **Given** a previously active conversation, **When** the runtime restarts and requests context, **Then** the latest persisted context is available without data loss.

---

### User Story 2 - Compaction and Retrieval Integrity (Priority: P2)

As an agent runtime developer, I want compaction outputs and retrieval paths to remain correct in PostgreSQL so that compressed context remains usable and traceable.

**Why this priority**: Compaction and retrieval are core product promises; persistence must preserve summary lineage and recoverability.

**Independent Test**: Run compaction on an over-budget conversation, then validate summary references, expansion behavior, and integrity checks using only PostgreSQL-backed data.

**Acceptance Scenarios**:

1. **Given** a conversation that exceeds threshold limits, **When** compaction runs, **Then** summary records and lineage links are persisted and can be used for later retrieval.
2. **Given** a summary reference produced by compaction, **When** a caller expands it, **Then** the original covered messages are returned in sequence order.

---

### User Story 3 - Safe Concurrency and Atomic Writes (Priority: P3)

As a platform operator, I want concurrent updates and failures to be handled safely so that data consistency is preserved under load and partial failures.

**Why this priority**: Data corruption or partial writes would break trust in memory behavior and block production use.

**Independent Test**: Execute concurrent context updates and forced failure scenarios, then verify stale-write detection, rollback behavior, and invariant preservation.

**Acceptance Scenarios**:

1. **Given** two concurrent context replacement attempts using the same prior version, **When** both are submitted, **Then** only one succeeds and the other returns a stale-write failure without corrupting context positions.
2. **Given** a multi-step persistence operation that fails mid-flight, **When** the operation ends, **Then** no partial state is visible and all affected records remain consistent.

---

### Edge Cases

- What happens when the same idempotency key is retried with identical content versus conflicting content?
- How does the system behave when context replacement is attempted with an outdated version?
- How are reads handled when search queries return zero matches across events and summaries?
- When transient database unavailability occurs during append, compaction persistence, or context materialization, bounded retries are attempted before returning a typed retryable failure.
- How does the system handle integrity validation when encountering malformed or orphaned references introduced by prior bad state?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist and retrieve all Phase 1 memory records required for conversations, events, context projection, summary lineage, and artifacts using PostgreSQL.
- **FR-002**: The system MUST preserve append-only event history semantics after records are written.
- **FR-003**: The system MUST enforce deterministic per-conversation ordering of events and prevent duplicate position assignment.
- **FR-004**: The system MUST support idempotent event append behavior for repeated submissions and reject conflicting submissions that reuse the same idempotency key.
- **FR-005**: The system MUST support history retrieval by ordered range, full-text query, and pattern query, including optional summary-scoped search.
- **FR-006**: The system MUST return context snapshots with a version indicator and require version matching for context replacement operations.
- **FR-007**: The system MUST reject stale context replacement attempts without modifying persisted context state.
- **FR-008**: The system MUST persist both leaf and condensed summary lineage relationships and make them retrievable for downstream use cases.
- **FR-009**: The system MUST support expansion of stored summaries back to ordered source messages.
- **FR-010**: The system MUST persist artifact metadata and content references and preserve artifact linkage through compaction outputs.
- **FR-011**: The system MUST execute multi-record write operations atomically so that partial writes are not observable after failures.
- **FR-012**: The system MUST provide typed persistence error outcomes that distinguish retryable failures from non-retryable failures.
- **FR-013**: The system MUST support conversation lineage lookup for parent-child conversation chains.
- **FR-014**: The PostgreSQL adapter behavior MUST satisfy Phase 1 conformance and golden behavior expectations for persistence-related use cases.
- **FR-015**: The feature MUST deliver and maintain the required PostgreSQL schema and migration artifacts needed for Phase 1 persistence behavior, including required structural constraints and indexes referenced by acceptance tests.
- **FR-016**: The feature MUST validate conformance and golden persistence behavior for PostgreSQL within this scope; cross-backend parity validation is explicitly out of scope for this feature.
- **FR-017**: For transient persistence failures classified as retryable, the system MUST perform bounded internal retries before returning a typed retryable error to the caller.
- **FR-018**: Reliability validation in this feature MUST focus on correctness, atomicity, bounded retry behavior, and recovery outcomes; formal uptime/SLO commitments are out of scope for this feature.
- **FR-019**: Acceptance and performance validation for this feature MUST be executed at a scale of up to 10,000 events per conversation and up to 100 concurrent conversations.

### Key Entities *(include if feature involves data)*

- **Conversation Record**: Represents a memory session configuration and optional parent linkage for session ancestry.
- **Ledger Event Record**: Represents immutable chronological interaction history entries with role, content, token count, and idempotency metadata.
- **Context Projection Snapshot**: Represents the current ordered context pointers and a concurrency version value used for safe replacement.
- **Summary Node and Lineage Links**: Represents compacted memory outputs and their traceability back to source messages or parent summaries.
- **Artifact Record**: Represents stored external or inline content references used by summaries and retrieval workflows.
- **Integrity Report**: Represents pass/fail results for all required structural and consistency checks across persisted memory data.

### Dependencies

- Phase 1 domain and application contracts for persistence ports, use-case orchestration, and typed error taxonomy.
- Existing compaction, materialization, and retrieval behavior definitions in project design documents.
- Automated conformance, golden, and regression test suites used for Phase 1 validation.

### Assumptions

- Scope includes delivery of Phase 1 PostgreSQL schema and migration artifacts required by the adapter.
- Scope is limited to Phase 1 PostgreSQL persistence support and does not include SQLite or other backend parity work in this feature.
- Scope is limited to single deployment ownership and does not include multi-tenant access control.
- Formal availability objectives and uptime service levels are out of scope for this feature.
- Existing use-case interfaces remain stable during this feature and are treated as the adapter contract boundary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of required Phase 1 persistence behaviors pass conformance checks for the selected persistence backend.
- **SC-002**: In repeated restart-and-recovery validation runs, persisted conversation state is recovered without data loss in 100% of runs.
- **SC-003**: In concurrency validation scenarios, stale-write conflicts are detected and handled without context corruption in 100% of tested cases.
- **SC-004**: Under expected Phase 1 workload, at least 95% of append, context retrieval, and summary expansion operations complete in 1 second or less.
- **SC-005**: All required data integrity checks report pass for every Phase 1 golden fixture run against the selected persistence backend.
- **SC-006**: Zero open high-severity persistence regressions remain in the Phase 1 regression catalog at feature sign-off.
- **SC-007**: In transient failure test scenarios, at least 99% of operations either succeed within the bounded retry policy or return the expected typed retryable error without partial writes.
- **SC-008**: At the defined validation scale (up to 10,000 events per conversation and up to 100 concurrent conversations), all required acceptance scenarios pass and SC-004 latency targets are maintained.
