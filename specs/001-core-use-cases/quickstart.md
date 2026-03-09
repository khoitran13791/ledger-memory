# Quickstart: Phase 1 Core Use Cases

This quickstart describes how to implement and validate the Phase 1 core use-case layer for LedgerMind using the existing domain model and application port contracts.

## Prerequisites

- Node.js 22+
- pnpm 9.x
- repository bootstrap complete (`pnpm install`)
- PostgreSQL available for parity validation (in-memory + PostgreSQL only)

## 1) Confirm baseline workspace state

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: workspace is in a valid baseline state before starting Phase 1 implementation.

## 2) Implement deterministic foundation for Phase 1 behavior

Implement deterministic runtime dependencies required by the use-case contract:

- in-memory persistence adapters for the driven persistence ports
- deterministic summarizer/tokenizer test doubles for replay and escalation testing
- explicit stale-version conflict behavior in context projection replacement

Validate foundation behavior with package-level and workspace tests.

## 3) Implement core use cases in `packages/application/src/use-cases/`

Implement these orchestrations against existing ports:

- `append-ledger-events.ts`
- `materialize-context.ts`
- `run-compaction.ts`
- `grep.ts`
- `describe.ts`
- `expand.ts`
- `store-artifact.ts`
- `explore-artifact.ts`
- `check-integrity.ts`

Implementation rules to enforce:

- all multi-persistence mutations execute inside `UnitOfWorkPort.execute`
- context replacement operations pass `expectedVersion`
- all failure classes are explicit typed failures (idempotency conflict, stale version, invalid reference, authorization denial, budget/non-convergence, integrity failure)
- no partial state corruption on failure paths

## 4) Validate User Story 1 (budget-safe active context)

Run acceptance validation for append/materialization behavior:

1. append ordered immutable events to a conversation
2. verify active context projection includes appended events
3. trigger hard-threshold materialization and verify blocking compaction runs
4. verify returned materialized context never exceeds available budget
5. verify deterministic typed non-convergence error when hard-trigger compaction cannot meet budget within max rounds

Covers: SC-001, SC-002.

## 5) Validate deterministic replay + escalation behavior

Run deterministic fixtures and regression scenarios:

- repeated execution with same fixture yields stable IDs/lineage
- compaction escalation follows `normal -> aggressive -> deterministic fallback`
- L1/L2 outputs are accepted only when shrinking tokens
- deterministic fallback guarantees bounded output and termination path

Covers: SC-003, SC-004.

## 6) Validate retrieval workflow (`grep -> describe -> expand`)

After compaction:

1. run `grep` and verify matches include sequence/excerpt and covering summary linkage where available
2. run `describe` for summary and artifact IDs and verify provenance metadata + token count payload
3. run `expand` with authorized caller and verify ordered source message recovery
4. run `expand` with unauthorized caller and verify explicit authorization error

Validation target: retrieval workflow success >= 90%.

Covers: SC-006.

## 7) Validate artifact flow + propagation guarantees

1. store artifacts from `path`, `text`, and `binary` inputs
2. explore artifacts through registry resolution and verify structured summary/metadata output
3. run multi-round compaction/condensation and verify descendant summaries preserve full artifact ID unions from source lineage

Covers: SC-007.

## 8) Validate integrity and backend parity (in-memory + PostgreSQL)

Execute conformance/integration suites for both backends and verify integrity report behavior:

- per-check `IntegrityReport` payload includes names/details/affected IDs
- append + compaction sequences pass configured integrity checks
- parity assertions hold across in-memory and PostgreSQL implementations

Covers: SC-005.

## 9) Final quality gates

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all quality gates pass with Phase 1 core use-case contracts satisfied.

## 10) Common pitfalls to avoid

- Do not silently return oversized materialized context.
- Do not silently overwrite projection state on version mismatch.
- Do not accept non-shrinking L1/L2 summary outputs.
- Do not skip deterministic fallback when escalation requires it.
- Do not drop artifact IDs during compaction/condensation.
- Do not introduce framework/runtime types into domain/application layers.
- Do not extend scope to SQLite, operator recursion, or multi-tenant/server concerns in this phase.
