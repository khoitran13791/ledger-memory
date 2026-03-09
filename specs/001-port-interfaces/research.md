# Research: Port Interface Contracts

## Decision 1: Define all Phase 1 ports in `packages/application` and keep them framework-agnostic

- **Decision**: Place the full driving/driven port contract surface under `packages/application/src/ports/**` and ensure contracts reference only domain and application contract types.
- **Rationale**:
  - HLD defines ports as application-layer abstractions owned by use-case boundaries.
  - Clean Architecture dependency rule requires inner-layer ownership of abstractions.
  - Spec FR-015 requires framework/runtime/storage agnosticism.
- **Alternatives considered**:
  - Define some ports in adapters package for convenience.
    - Rejected because it inverts dependency ownership and weakens DIP.
  - Centralize all capabilities into one broad interface.
    - Rejected because FR-013 and HLD ISP guidance require segregated contracts.

## Decision 2: Remove standalone sequence allocation operation from Phase 1 contracts

- **Decision**: `LedgerAppendPort` contracts will not expose `getNextSequence`; sequence assignment is part of append behavior.
- **Rationale**:
  - Clarification in spec explicitly removes separate next-sequence operation.
  - FR-008 requires append behavior to encapsulate sequence allocation.
  - Keeps atomicity and ordering semantics cohesive for conformance planning.
- **Alternatives considered**:
  - Keep `getNextSequence` as a read/utility operation.
    - Rejected because it introduces split responsibility and stale allocation race ambiguity.

## Decision 3: Use explicit optimistic-concurrency conflict signaling on versioned mutations

- **Decision**: Versioned mutation contracts (especially context replacement) must require caller-provided expected version and return explicit stale-version conflicts.
- **Rationale**:
  - Addendum section on context projection concurrency mandates expected version checks and stale conflict behavior.
  - Spec FR-007 and FR-007a require explicit signaling and prohibit silent overwrite.
  - Enables deterministic conformance assertions across adapters.
- **Alternatives considered**:
  - Silent last-write-wins semantics.
    - Rejected because it violates clarified requirements and undermines correctness guarantees.

## Decision 4: Keep retrieval/search contracts conversation-scoped and Phase-1 search limited to keyword + regex

- **Decision**: Retrieval and search interfaces are scoped to a single conversation in Phase 1 and only require keyword/full-text + regex behaviors.
- **Rationale**:
  - Clarification in spec restricts operations to conversation scope.
  - FR-010 and FR-010a explicitly bound scope and search semantics.
  - Avoids premature expansion into cross-conversation and semantic/vector concerns.
- **Alternatives considered**:
  - Add global/cross-conversation query ports now.
    - Rejected as out-of-scope for Phase 1 and likely to over-couple adapter design early.
  - Require vector search contract now.
    - Rejected per explicit clarification and FR-010a.

## Decision 5: Keep expansion authorization gated, but artifact metadata/content open in Phase 1

- **Decision**: Preserve explicit authorization contract for guarded expansion while allowing artifact metadata and raw content access for normal callers in Phase 1.
- **Rationale**:
  - FR-012 keeps gated expansion as a first-class contract concern.
  - Clarification + FR-012a explicitly open artifact metadata/content access in this phase.
  - Maintains a clear separation between expansion controls and artifact access policy.
- **Alternatives considered**:
  - Gate all artifact content reads behind authorization.
    - Rejected for this feature because accepted clarification explicitly chooses open access in Phase 1.

## Decision 6: Normalize binary payload and hashing contracts using addendum updates

- **Decision**: Use `Uint8Array` in relevant content/hash contracts and include dedicated `HashPort` abstraction under driven infrastructure capabilities.
- **Rationale**:
  - Addendum minor fix replaces buffer usage with `Uint8Array` for portability.
  - Addendum defines `HashPort` as an abstraction to prevent runtime crypto coupling in inner layers.
  - Aligns with clean architecture guardrails and FR-016.
- **Alternatives considered**:
  - Use runtime-specific binary types (e.g., `Buffer`) in core contracts.
    - Rejected due to portability and framework-agnostic constraints.

## Decision 7: Use contract-level verification artifacts instead of implementation tests for this feature scope

- **Decision**: Verification for this feature centers on traceability review, contract completeness checks, and conformance-test derivation readiness; implementation-level tests are deferred to subsequent build phases.
- **Rationale**:
  - Feature scope is contract definition only (no concrete adapters/use-cases).
  - FR-014 + SC-005 require behavior clarity sufficient for conformance planning.
  - Constitution testing gate is satisfied via explicit and testable contract behavior definitions plus static quality checks once interfaces are implemented.
- **Alternatives considered**:
  - Add adapter-level integration tests in this feature.
    - Rejected as out-of-scope and dependent on future implementation work.

## Decision 8: Keep UnitOfWork as the atomic persistence boundary contract

- **Decision**: Preserve `UnitOfWorkPort.execute(work)` and `UnitOfWork` capability bundle contract as the atomic transaction abstraction for grouped persistence operations.
- **Rationale**:
  - HLD and ports-and-adapters guidance identify UnitOfWork as the canonical atomic boundary.
  - FR-003 requires transaction contracts over grouped persistence capabilities.
  - Supports conformance parity across in-memory and PostgreSQL adapters.
- **Alternatives considered**:
  - Omit UnitOfWork and rely on independent port methods only.
    - Rejected because it weakens atomicity guarantees and complicates use-case orchestration contracts.
