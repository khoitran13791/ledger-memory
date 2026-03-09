# Feature Specification: Domain Package Foundations

**Feature Branch**: `001-domain-value-objects`
**Created**: 2026-02-27
**Status**: Draft
**Input**: User description: "i want to implement the the first section `| Domain model + value objects | `domain` | Pure TypeScript, zero deps |` in phase 1 of @docs/high-level-design.md and @docs/design-decisions-addendum.md"

## Clarifications

### Session 2026-02-27

- Q: For this feature, what should be in scope right now? → A: Implement full domain package now: model + value objects + domain services + domain events + domain errors.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Define canonical domain model (Priority: P1)

As a LedgerMind maintainer, I want a complete and explicit domain model so all later layers can rely on one consistent business vocabulary and invariant set.

**Why this priority**: This is the foundation for all Phase 1 work. If the domain model is incomplete or inconsistent, every downstream use case and adapter becomes unstable.

**Independent Test**: Can be fully tested by validating that each required domain concept is represented and that invalid data is rejected while valid data is accepted.

**Acceptance Scenarios**:

1. **Given** the Phase 1 scope documents, **When** the domain surface is reviewed, **Then** all required core concepts are present with explicit attributes and invariants.
2. **Given** invalid inputs for core concepts (for example invalid thresholds or negative token values), **When** domain objects are created or validated, **Then** creation fails with explicit domain-level failures and no partial state is accepted.

---

### User Story 2 - Ensure deterministic identity and value semantics (Priority: P2)

As an adapter engineer, I want deterministic identifier and value semantics so the same logical content always produces the same identity and cross-run behavior stays consistent.

**Why this priority**: Deterministic identities are required for idempotency, reproducibility, and stable DAG references across compaction and retrieval operations.

**Independent Test**: Can be tested by running repeated identity generation and value computations against fixed fixtures and verifying stable output.

**Acceptance Scenarios**:

1. **Given** the same logical input content, **When** identity generation is executed repeatedly, **Then** the same identifier is produced each time.
2. **Given** changes only to fields excluded from hashing rules, **When** identity generation is executed, **Then** the identifier remains unchanged.
3. **Given** changes to fields included in hashing rules, **When** identity generation is executed, **Then** a different identifier is produced.

---

### User Story 3 - Provide shared domain events and error taxonomy (Priority: P2)

As an application-layer developer, I want consistent domain events and domain error types so orchestration logic can react predictably to success and invariant violations.

**Why this priority**: Event and error contracts are required for reliable orchestration, observability, and testing, but depend on the core domain model being established first.

**Independent Test**: Can be tested by executing representative domain operations and checking that emitted events and raised errors match defined contracts.

**Acceptance Scenarios**:

1. **Given** a successful domain operation, **When** a domain event is produced, **Then** required payload fields are present and semantically correct.
2. **Given** an invariant violation, **When** the same operation is evaluated, **Then** the defined domain error category is returned.

---

### Edge Cases

- What happens when token-related values are negative, non-numeric, or overflow expected bounds?
- How does the system handle invalid threshold combinations where soft threshold is not lower than hard threshold?
- How does the domain behave when identical logical content is provided repeatedly (idempotent identity behavior)?
- How are hashing and identity rules applied to Unicode-heavy content and structurally equivalent payloads with different field orderings?
- What happens when an artifact declared as path-backed has no path metadata?
- What happens when a summary kind and its coverage references are logically inconsistent (for example, a leaf summary without covered messages)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define domain representations for all Phase 1 core concepts: Conversation, Ledger Event, Summary Node, DAG Edge, Context Item, and Artifact.
- **FR-002**: The system MUST define value-object representations for identity, sequencing, token accounting, thresholds, roles, timestamps, MIME types, and context versioning needed by Phase 1.
- **FR-003**: The system MUST enforce non-negative token value rules across all domain objects that carry token counts.
- **FR-004**: The system MUST enforce conversation configuration invariants, including positive context window and valid threshold ordering.
- **FR-005**: The system MUST provide deterministic content-addressed identity generation aligned with canonical serialization and hashing rules in the approved design decisions.
- **FR-006**: The identity generation behavior MUST include only designated identity fields and MUST ignore explicitly excluded fields.
- **FR-007**: The system MUST treat repeated identity generation for logically identical inputs as idempotent behavior.
- **FR-008**: The system MUST provide domain services for token budget computation, compaction candidate policy decisions, and identity generation logic.
- **FR-009**: The system MUST define a domain event contract that includes event types required for append, compaction trigger, summary creation, artifact storage, and context materialization flows.
- **FR-010**: The system MUST define a domain error taxonomy for invariant violations and integrity-related failures relevant to Phase 1 domain scope.
- **FR-011**: The domain package MUST remain dependency-free and framework-independent.
- **FR-012**: The domain contract MUST support all accepted Phase 1 design decisions for deterministic IDs, context versioning representation, and artifact propagation semantics.

### Key Entities *(include if feature involves data)*

- **Conversation**: Aggregate root representing one memory timeline, including context limits and compaction thresholds.
- **Ledger Event**: Immutable historical record containing role, content, sequencing, and token accounting metadata.
- **Summary Node**: DAG node representing either leaf-level compression of raw events or condensed compression of prior summaries.
- **DAG Edge**: Directed provenance relationship between summaries and their covered source events or parent summaries.
- **Context Item**: Ordered active-context projection entry referencing either a raw event or a summary.
- **Artifact**: Externalized large-content reference carrying identity, storage semantics, and exploration metadata.
- **Identity and Token Value Objects**: Strongly constrained value semantics for IDs, sequence values, token values, thresholds, and versions.

### Assumptions

- The feature scope includes full Phase 1 domain package foundations: entities, value objects, domain services, domain events, and domain errors.
- Persistence, transport, framework integration, and migration concerns are outside this feature and addressed in later phases.
- Existing design documents are the authoritative source for required invariants and identity rules.

### Out of Scope

- Application use case orchestration.
- Storage adapter behavior and SQL schema execution.
- Framework-specific tool mappings and runtime wiring.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of Phase 1 domain concepts listed in the accepted design documents are represented in the domain contract with explicit invariants.
- **SC-002**: Automated tests demonstrate invariant enforcement for each domain concept with at least one valid and one invalid case per invariant group.
- **SC-003**: Deterministic identity tests show identical outputs for identical canonical inputs across repeated runs, and differing outputs when hashed fields change.
- **SC-004**: Dependency audit confirms the domain package introduces zero external runtime dependencies.
- **SC-005**: Downstream consumers can reference all required domain events and domain error categories for Phase 1 without defining ad-hoc replacements.