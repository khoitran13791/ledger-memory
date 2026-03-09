# Quickstart: PostgreSQL Adapter for Phase 1 Core Engine

This quickstart describes how to implement and validate the remaining PostgreSQL adapter work for `001-postgres-adapter`.

## Prerequisites

- Node.js >= 22
- pnpm 9.x
- PostgreSQL instance reachable from local environment
- workspace dependencies installed (`pnpm install`)

## 1) Validate baseline workspace state

From repository root:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: repository baseline is green before PostgreSQL adapter changes.

## 2) Configure PostgreSQL for migrations/tests

Set database URL for migration and test harness usage:

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/ledgermind_dev"
```

(Use project-appropriate credentials/database name.)

## 3) Verify and apply PostgreSQL migrations

```bash
pnpm --filter @ledgermind/infrastructure migrate:status
pnpm --filter @ledgermind/infrastructure migrate:up
```

Expected:
- `0001_phase1_schema.sql` and `0002_phase1_indexes.sql` are applied.
- all required tables/constraints/indexes exist.

## 4) Implement required deltas in PostgreSQL infrastructure

### Delta A — idempotency-key enforcement (FR-004)
Primary files:
- `packages/infrastructure/src/postgres/pg-ledger-store.ts`
- related append-path tests in `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

Required behavior:
- persist idempotency key on append path
- same key + same payload => no-op success
- same key + different payload => typed conflict

### Delta B — bounded transient retry (FR-017)
Primary files:
- `packages/infrastructure/src/postgres/transaction.ts`
- `packages/infrastructure/src/postgres/pg-unit-of-work.ts`
- transaction-focused tests in `packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts`

Required behavior:
- bounded retry attempts for transient failures
- rollback before retrying
- deterministic stop condition on retry exhaustion

### Delta C — retryability typing (FR-012/FR-017)
Primary files:
- `packages/infrastructure/src/postgres/errors.ts`
- tests across store/unit-of-work suites

Required behavior:
- explicit retryable vs non-retryable classification
- typed retryable failure after retry exhaustion
- preserve existing invariant/sequence typed mappings

## 5) Re-run focused PostgreSQL adapter tests

```bash
pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts
pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-context-projection.test.ts
pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-summary-dag.test.ts
pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-artifact-store.test.ts
pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-conversation-store.test.ts
pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts
```

Expected: all PostgreSQL store/unit-of-work suites pass.

## 6) Validate feature-critical behaviors against requirements

### Atomicity and rollback (FR-011, SC-003)
- force a mid-transaction failure
- verify no partial writes remain visible

### Optimistic concurrency (FR-006/FR-007, SC-003)
- run concurrent `replaceContextItems` with same `expectedVersion`
- verify one success + one `StaleContextVersionError`
- verify context positions remain contiguous

### DAG integrity + expansion (FR-008/FR-009/FR-014, SC-005)
- run append + compaction-like node/edge writes
- verify `expandToMessages` sequence ordering
- verify all 8 integrity checks

### Artifact handling (FR-010)
- verify path/inline_text/inline_binary shape enforcement
- verify binary `getContent` returns defensive copy semantics

### Retry/recovery (FR-012/FR-017/FR-018, SC-007)
- inject transient failures
- verify bounded retries then typed retryable failure on exhaustion

## 7) Run workspace quality gates after PostgreSQL changes

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all gates pass with PostgreSQL adapter behavior aligned to FR-001..FR-019.

## 8) Acceptance checklist

- [x] Idempotency semantics are enforced in persisted append path (FR-004).
- [x] Transaction boundary guarantees atomicity with rollback on failure (FR-011).
- [x] Retryable failures are classified and retried with bounded policy (FR-012, FR-017).
- [x] Stale context version conflicts are deterministic and non-destructive (FR-006, FR-007).
- [x] Summary expansion and 8 integrity checks pass for PostgreSQL scenarios (FR-008, FR-009, FR-014).
- [x] PostgreSQL-only conformance/golden/regression scope is satisfied (FR-016).
- [x] Scale/reliability validations satisfy SC-004, SC-007, SC-008 targets.

## 9) Final validation evidence (feature sign-off)

Latest coordinator validation run (repository root):

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Observed outcomes:
- `pnpm typecheck` ✅ pass
- `pnpm lint` ✅ pass
- `pnpm test` ✅ pass (includes PostgreSQL conformance, golden, regression, and scale suites)
- `pnpm build` ✅ pass

Notes:
- Environment emitted a non-blocking engine warning (`node >=22` expected, local runtime `v20.11.0`) during command execution.
- Scale validation remains covered by `tests/regression/postgres-adapter.scale.test.ts` (10k events and 100 concurrent conversations scenarios).
