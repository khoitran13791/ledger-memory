# Research: Domain Package Foundations

## Decision 1: Domain package remains dependency-free and framework-independent

- **Decision**: Implement all Phase 1 domain artifacts in `packages/domain` with zero runtime dependencies and no imports from Node built-ins, DB drivers, schema validators, or framework SDKs.
- **Rationale**:
  - Feature FR-011 requires domain to be dependency-free.
  - Clean Architecture in HLD enforces inward dependency direction and explicitly marks `domain` as zero-dep.
  - Existing monorepo scaffold already models the dependency rule via package references and workspace boundaries.
- **Alternatives considered**:
  - Add runtime validators (e.g., zod) to domain for invariants.
    - Rejected because boundary validation belongs to adapters, and domain must remain zero-dep.
  - Use Node `crypto` directly in domain ID service.
    - Rejected because hashing is a port concern and addendum requires `HashPort` abstraction.

## Decision 2: Canonical deterministic ID rules follow addendum as authoritative source

- **Decision**: Use `docs/design-decisions-addendum.md` hashing inputs as the binding source for this feature:
  - `LedgerEvent` hash fields: `{ content, conversationId, role, sequence }`
  - `SummaryNode` hash fields: `{ content, conversationId, kind }`
  - `Artifact` hash fields: `{ contentHash }`
  - Canonical serialization: sorted keys, JSON default escaping, UTF-8 bytes, omitted `undefined`.
- **Rationale**:
  - Spec FR-005/FR-006 require alignment with approved design decisions.
  - Addendum is explicitly published to resolve pre-implementation ambiguities.
  - Including `sequence` in event hashes prevents same-content collisions within a conversation.
- **Alternatives considered**:
  - Use skills shorthand that excludes `sequence` for `LedgerEvent`.
    - Rejected for this feature because addendum has higher authority and explicit collision rationale.

## Decision 3: Domain model scope is full Phase 1 foundation, not only value objects

- **Decision**: Include entities, value objects, domain services, domain events, and domain errors in `packages/domain` now.
- **Rationale**:
  - Clarification answer in `spec.md` sets full domain package in scope.
  - FR-001, FR-002, FR-008, FR-009, and FR-010 collectively require all five domain building blocks.
  - Enables stable contracts for downstream `application` and `adapters` phases.
- **Alternatives considered**:
  - Implement only value objects first.
    - Rejected because it would leave events/errors/services undefined and break Phase 1 contract completeness (SC-001, SC-005).

## Decision 4: Invariant enforcement is explicit and constructor/factory-centered

- **Decision**: Each domain concept exposes explicit creation/validation paths that reject invalid state with typed domain errors.
- **Rationale**:
  - FR-003 and FR-004 require strict token and threshold invariants.
  - User stories demand invalid construction failure with no partial state.
  - Testing strategy prioritizes deterministic domain unit tests for invariants.
- **Alternatives considered**:
  - Defer invariant checks to application layer.
    - Rejected because invariants belong to domain semantics and must be guaranteed independently.

## Decision 5: Domain services stay pure and deterministic

- **Decision**: Domain services in scope:
  - `TokenBudgetService` for budget arithmetic and threshold checks.
  - `CompactionPolicyService` for candidate/escalation decisions at policy level.
  - `IdService` for canonical ID derivation using injected hashing primitive.
- **Rationale**:
  - FR-008 requires these service categories.
  - HLD and addendum define deterministic policies and fallback semantics that can be represented as pure domain logic.
- **Alternatives considered**:
  - Put all policy logic into use cases only.
    - Rejected because policy rules are domain-level business semantics reused by multiple use cases.

## Decision 6: Domain event contract and error taxonomy follow design docs

- **Decision**:
  - Events: append, compaction trigger/completion, summary creation, artifact storage, context materialization contract types.
  - Errors: base `DomainError` + specialized invariant/integrity/hash/sequence/budget violations.
- **Rationale**:
  - FR-009 and FR-010 require explicit shared contracts.
  - HLD and addendum provide required categories and naming direction.
- **Alternatives considered**:
  - Keep events/errors implicit until use case implementation.
    - Rejected because downstream layers need stable compile-time contracts now.

## Decision 7: Testing baseline for this feature is deterministic domain unit tests

- **Decision**: Primary verification for this feature is `packages/domain` unit tests in Vitest, covering valid/invalid invariants, deterministic ID behavior, and service decision rules.
- **Rationale**:
  - SC-002 and SC-003 are directly about invariant and deterministic behavior.
  - Testing strategy places domain unit tests as the largest and first validation layer.
  - Domain package currently has no implementation; test-first acceptance criteria can be made explicit in quickstart.
- **Alternatives considered**:
  - Skip tests until application adapters exist.
    - Rejected because domain contracts must be proven independently and early.

## Decision 8: Scope boundary for this planning cycle

- **Decision**: This feature does not implement persistence schemas, use case orchestration, framework adapters, or external transport APIs.
- **Rationale**:
  - Spec out-of-scope section explicitly excludes those concerns.
  - Keeps implementation minimal and constitution-compliant for simplicity.
- **Alternatives considered**:
  - Add preliminary ports or application stubs in same change.
    - Rejected to avoid broadening scope beyond requested domain foundation.
