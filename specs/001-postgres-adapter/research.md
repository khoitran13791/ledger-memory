# Research: PostgreSQL Adapter for Phase 1 Core Engine

## Decision 1: Keep PostgreSQL persistence implementations in `packages/infrastructure/src/postgres/**`

- **Decision**: Keep concrete PostgreSQL adapter logic under infrastructure (`packages/infrastructure/src/postgres/**`), while preserving application-layer port ownership in `packages/application/src/ports/**`.
- **Rationale**:
  - Existing repository layout and active implementations already place PG-specific behavior in infrastructure (`pg-ledger-store.ts`, `pg-context-projection.ts`, `pg-summary-dag.ts`, `pg-artifact-store.ts`, `pg-conversation-store.ts`, `pg-unit-of-work.ts`).
  - This preserves Clean Architecture dependency direction and avoids outer concerns leaking into domain/application.
  - Plan scope in `specs/001-postgres-adapter/plan.md` explicitly targets this structure.
- **Alternatives considered**:
  - Move PG implementations into application.
    - Rejected because it would violate dependency inversion and introduce storage coupling into use-case boundaries.

## Decision 2: Preserve `UnitOfWorkPort` as the only atomic mutation boundary

- **Decision**: Keep all multi-record mutation paths dependent on `UnitOfWorkPort.execute`, implemented by `PgUnitOfWork` + `withPgTransaction` (`BEGIN`/`COMMIT`/`ROLLBACK`).
- **Rationale**:
  - `packages/application/src/ports/driven/persistence/unit-of-work.port.ts` requires all-or-nothing commit semantics.
  - `packages/infrastructure/src/postgres/pg-unit-of-work.ts` composes all required PG stores from one transaction-scoped executor.
  - `packages/infrastructure/src/postgres/transaction.ts` already provides explicit rollback behavior on failure.
- **Alternatives considered**:
  - Independent per-port writes without shared transaction.
    - Rejected because it would violate FR-011 atomicity and risk partial state corruption.

## Decision 3: Treat optimistic concurrency as mandatory for context replacement

- **Decision**: Continue requiring caller-supplied `expectedVersion` for replacement operations and fail on mismatch with `StaleContextVersionError`.
- **Rationale**:
  - `packages/application/src/ports/driven/persistence/context-projection.port.ts` forbids silent overwrite behavior.
  - `packages/infrastructure/src/postgres/pg-context-projection.ts` enforces compare-and-swap semantics using version-gated update logic.
  - This matches addendum requirements for optimistic concurrency and FR-006/FR-007.
- **Alternatives considered**:
  - Last-write-wins replacement.
    - Rejected because it would violate stale-write conflict semantics and determinism requirements.

## Decision 4: Keep immutable ledger append semantics with conversation-local monotonic ordering

- **Decision**: Enforce append-only ledger persistence with strict sequence monotonicity checks in PostgreSQL adapter behavior.
- **Rationale**:
  - `pg-ledger-store.ts` validates gap-free sequence progression per conversation and throws `NonMonotonicSequenceError` on mismatch.
  - Reads (`getEvents`, search methods) preserve ascending sequence ordering.
  - Aligns with FR-002/FR-003 and SC-003 determinism expectations.
- **Alternatives considered**:
  - Allow sparse or corrected sequence repair in adapter.
    - Rejected because it introduces ambiguity and weakens append ordering guarantees.

## Decision 5: Keep conversation-scoped keyword/regex retrieval as Phase 1 search contract

- **Decision**: Preserve conversation-scoped retrieval with ordered results for range, full-text, and regex search.
- **Rationale**:
  - `packages/application/src/ports/driven/persistence/ledger-read.port.ts` defines conversation-scoped read/search APIs.
  - `pg-ledger-store.ts` implements FTS (`plainto_tsquery`) and regex search with optional summary scope traversal.
  - Matches accepted scope limitations in previous feature artifacts and current spec FR-005.
- **Alternatives considered**:
  - Add semantic/vector retrieval in this feature.
    - Rejected as out-of-scope for Phase 1 PostgreSQL adapter delivery.

## Decision 6: Keep Summary DAG integrity verification in adapter surface and validate all 8 checks

- **Decision**: Maintain `SummaryDagPort.checkIntegrity` as a first-class adapter responsibility and ensure PostgreSQL implementation reports per-check pass/fail details.
- **Rationale**:
  - `packages/application/src/ports/driven/persistence/summary-dag.port.ts` requires `IntegrityReport` with detailed check payloads.
  - `pg-summary-dag.ts` already implements all required integrity families (orphans, cycles, coverage, contiguity, sequence, artifact propagation).
  - Supports SC-005 and FR-014 acceptance behavior.
- **Alternatives considered**:
  - Move integrity checks into separate test-only utilities.
    - Rejected because runtime integrity inspection is part of the explicit contract surface.

## Decision 7: Keep artifact payloads platform-neutral (`string | Uint8Array`) and preserve defensive copy semantics

- **Decision**: Preserve application port contracts that use `string | Uint8Array` payloads and keep PostgreSQL adapter returning cloned binary buffers to prevent mutation leaks.
- **Rationale**:
  - `packages/application/src/ports/driven/persistence/artifact-store.port.ts` specifies platform-neutral content types.
  - `pg-artifact-store.ts` clones binary values before returning, which aligns with immutability expectations for caller-visible data.
  - Satisfies addendum guidance replacing runtime-specific buffer semantics with portable types.
- **Alternatives considered**:
  - Expose Node-specific mutable buffer references.
    - Rejected for portability and mutation-safety reasons.

## Decision 8: Retain typed PostgreSQL error mapping at infrastructure boundary and classify retryability explicitly in design artifacts

- **Decision**: Keep SQLSTATE mapping logic in `packages/infrastructure/src/postgres/errors.ts` and explicitly classify mapped outcomes by retryability in contracts/tests.
- **Rationale**:
  - Current implementation maps integrity/constraint families (`23505`, `23503`, `23514`, `22P02`) to typed invariant/sequence errors.
  - FR-012 and FR-017 require typed retryable vs non-retryable outcomes plus bounded retry behavior.
  - Clear error classification at this boundary is necessary for deterministic conformance coverage.
- **Alternatives considered**:
  - Leak raw driver errors to application.
    - Rejected because it violates typed error surface constraints and destabilizes cross-adapter behavior.

## Decision 9: Resolve sequence-allocation contract tension explicitly in PostgreSQL adapter contract

- **Decision**: Document and enforce current practical behavior: sequence allocation helper (`getNextSequence`) remains present in `LedgerAppendPort` contract and PG implementation for Phase 1, with append operation still responsible for enforcing monotonic persisted order.
- **Rationale**:
  - Current source of truth (`packages/application/src/ports/driven/persistence/ledger-append.port.ts`) includes `getNextSequence`.
  - Existing PG implementation (`pg-ledger-store.ts`) uses sequence resolution and strict append validation.
  - Previous design artifacts indicate intent to remove standalone allocation, but code contracts currently still expose it; research resolves this by aligning to actual code boundary for this feature.
- **Alternatives considered**:
  - Remove `getNextSequence` in this feature before adapter planning.
    - Rejected for this planning scope because it introduces broad contract churn unrelated to PostgreSQL adapter completion and would invalidate existing implementations.

## Decision 10: Introduce bounded transient retry policy in PostgreSQL infrastructure execution path

- **Decision**: Add bounded internal retry behavior for transient PostgreSQL failures at transaction/execution boundary, with deterministic stop conditions and typed retryable failure return when retries are exhausted.
- **Rationale**:
  - Spec clarifications (FR-017, SC-007) explicitly require bounded retry for transient failures.
  - Current `withPgTransaction` behavior performs rollback and immediate error mapping, but no explicit bounded retry loop is present yet.
  - Retry behavior belongs in infrastructure orchestration (transaction/executor layer), not domain/application.
- **Alternatives considered**:
  - No internal retries (immediate fail).
    - Rejected because it fails clarified requirement FR-017.
  - Unbounded retry loops.
    - Rejected because they violate determinism and can compromise latency/termination guarantees.

## Decision 11: Keep PostgreSQL-only conformance/golden/regression validation for this feature

- **Decision**: Scope feature validation to PostgreSQL adapter conformance and PostgreSQL-backed golden/regression paths; defer backend parity expansion to later features.
- **Rationale**:
  - Clarification in `specs/001-postgres-adapter/spec.md` (FR-016) makes PostgreSQL-only validation explicit.
  - This keeps delivery aligned to feature scope while still preserving the existing port contracts for future backends.
- **Alternatives considered**:
  - Expand to SQLite parity now.
    - Rejected as out-of-scope for current feature delivery.

## Decision 12: Validate performance/reliability at defined scale using focused persistence operations

- **Decision**: Validate SC-004/SC-008/SC-007 using workload targets up to 10,000 events per conversation and 100 concurrent conversations with focus on append, context retrieval, summary expansion, atomic rollback, and bounded retry outcomes.
- **Rationale**:
  - Scale and reliability targets are explicit in clarified spec and plan.
  - These scenarios directly exercise persistence-critical behavior expected from PostgreSQL adapter scope.
- **Alternatives considered**:
  - Defer scale/reliability checks to a future hardening phase.
    - Rejected because these are explicit success criteria for this feature.
