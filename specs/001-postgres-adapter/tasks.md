# Tasks: PostgreSQL Adapter for Phase 1 Core Engine

**Input**: Design documents from `/specs/001-postgres-adapter/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/postgres-adapter-contract.md`, `quickstart.md`

**Tests**: Included. The specification explicitly requires conformance/golden/regression and measurable validation outcomes (FR-014, FR-016, SC-001..SC-008).

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Task can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: User story label (`[US1]`, `[US2]`, `[US3]`) for story-phase tasks only
- Every task includes explicit file path(s)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Align scripts and test harness inputs before feature implementation.

- [ ] T001 Align workspace quality gate scripts and PostgreSQL migration script references in `package.json` and `packages/infrastructure/package.json`.
- [ ] T002 Align PostgreSQL test harness configuration and environment handling in `packages/infrastructure/src/postgres/__tests__/postgres-test-harness.ts`.
- [ ] T003 [P] Align PostgreSQL adapter execution checklist and validation commands in `specs/001-postgres-adapter/quickstart.md`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core persistence prerequisites that must be complete before user stories.

**⚠️ CRITICAL**: No user story work should begin until this phase is complete.

- [ ] T004 Align Phase 1 schema constraints for idempotency/context/artifact invariants in `packages/infrastructure/src/sql/postgres/migrations/0001_phase1_schema.sql`.
- [ ] T005 [P] Align retrieval/expansion index coverage for PostgreSQL workloads in `packages/infrastructure/src/sql/postgres/migrations/0002_phase1_indexes.sql`.
- [ ] T006 Implement retryable vs non-retryable classification and typed mapping extensions in `packages/infrastructure/src/postgres/errors.ts`.
- [ ] T007 Implement bounded transaction retry with rollback-before-retry behavior in `packages/infrastructure/src/postgres/transaction.ts`.
- [ ] T008 Wire retry-enabled transaction execution policy into `packages/infrastructure/src/postgres/pg-unit-of-work.ts`.
- [ ] T009 Add foundational retry policy tests and helper scaffolding in `packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts`.

**Checkpoint**: Foundation complete — user stories can proceed.

---

## Phase 3: User Story 1 - Persistent Memory Operations (Priority: P1) 🎯 MVP

**Goal**: PostgreSQL persistence/recovery for conversation, ledger, and context core paths.

**Independent Test**: Create a conversation, append/read events, restart runtime, and verify persisted context is recovered with deterministic ordering.

### Tests for User Story 1

- [ ] T010 [P] [US1] Add idempotency no-op and idempotency conflict tests in `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`.
- [ ] T011 [P] [US1] Add conversation create/get/ancestor-chain recovery tests in `packages/infrastructure/src/postgres/__tests__/pg-conversation-store.test.ts`.
- [ ] T012 [P] [US1] Add context snapshot/version read-path tests in `packages/infrastructure/src/postgres/__tests__/pg-context-projection.test.ts`.

### Implementation for User Story 1

- [ ] T013 [US1] Persist idempotency keys and enforce conflict semantics on append path in `packages/infrastructure/src/postgres/pg-ledger-store.ts`.
- [ ] T014 [US1] Ensure deterministic ordered range/FTS/regex event retrieval behavior in `packages/infrastructure/src/postgres/pg-ledger-store.ts`.
- [ ] T015 [US1] Finalize conversation persistence and ancestor lookup behavior in `packages/infrastructure/src/postgres/pg-conversation-store.ts`.
- [ ] T016 [US1] Finalize context snapshot + version retrieval behavior in `packages/infrastructure/src/postgres/pg-context-projection.ts`.
- [ ] T017 [US1] Verify restart-and-recovery acceptance flow coverage in `packages/infrastructure/src/postgres/__tests__/pg-conversation-store.test.ts` and `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`.

**Checkpoint**: US1 is independently functional and testable.

---

## Phase 4: User Story 2 - Compaction and Retrieval Integrity (Priority: P2)

**Goal**: Preserve summary lineage, expansion correctness, and integrity guarantees in PostgreSQL.

**Independent Test**: Run compaction-style writes, then verify summary expansion ordering and all 8 integrity checks with PostgreSQL-backed data.

### Tests for User Story 2

- [ ] T018 [P] [US2] Add summary node/edge persistence and expansion ordering tests in `packages/infrastructure/src/postgres/__tests__/pg-summary-dag.test.ts`.
- [ ] T019 [P] [US2] Add full 8-family `IntegrityReport` validation tests in `packages/infrastructure/src/postgres/__tests__/pg-summary-dag.test.ts`.
- [ ] T020 [P] [US2] Add summary-scoped regex/full-text retrieval tests in `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`.
- [ ] T021 [P] [US2] Add artifact storage-shape and defensive binary clone tests in `packages/infrastructure/src/postgres/__tests__/pg-artifact-store.test.ts`.

### Implementation for User Story 2

- [ ] T022 [US2] Implement/align summary node and lineage edge persistence behavior in `packages/infrastructure/src/postgres/pg-summary-dag.ts`.
- [ ] T023 [US2] Implement recursive `expandToMessages` lineage traversal with sequence ordering in `packages/infrastructure/src/postgres/pg-summary-dag.ts`.
- [ ] T024 [US2] Implement all 8 integrity check families and report assembly in `packages/infrastructure/src/postgres/pg-summary-dag.ts`.
- [ ] T025 [US2] Implement summary-subtree-scoped regex/full-text search behavior in `packages/infrastructure/src/postgres/pg-ledger-store.ts`.
- [ ] T026 [US2] Enforce artifact storage-kind/content-shape constraints and clone-on-read semantics in `packages/infrastructure/src/postgres/pg-artifact-store.ts`.

**Checkpoint**: US2 is independently functional and testable.

---

## Phase 5: User Story 3 - Safe Concurrency and Atomic Writes (Priority: P3)

**Goal**: Preserve consistency under concurrent writes and transient failures with deterministic outcomes.

**Independent Test**: Run concurrent context replacements and injected failure scenarios to verify stale detection, rollback atomicity, and bounded retry behavior.

### Tests for User Story 3

- [ ] T027 [P] [US3] Add concurrent `expectedVersion` stale-write race tests in `packages/infrastructure/src/postgres/__tests__/pg-context-projection.test.ts`.
- [ ] T028 [P] [US3] Add transaction rollback atomicity tests across multi-store mutations in `packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts`.
- [ ] T029 [P] [US3] Add bounded retry exhaustion and typed retryable failure tests in `packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts`.

### Implementation for User Story 3

- [ ] T030 [US3] Enforce compare-and-swap replace semantics with contiguous position guarantees in `packages/infrastructure/src/postgres/pg-context-projection.ts`.
- [ ] T031 [US3] Ensure atomic unit-of-work store composition and failure rollback behavior in `packages/infrastructure/src/postgres/pg-unit-of-work.ts`.
- [ ] T032 [US3] Finalize retry loop stop conditions and retryable/non-retryable propagation in `packages/infrastructure/src/postgres/transaction.ts` and `packages/infrastructure/src/postgres/errors.ts`.
- [ ] T033 [US3] Validate no-partial-write visibility in injected failure scenarios in `packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts` and `packages/infrastructure/src/postgres/__tests__/pg-context-projection.test.ts`.

**Checkpoint**: US3 is independently functional and testable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across stories and acceptance sign-off artifacts.

- [ ] T034 [P] Add PostgreSQL persistence conformance scenarios for FR-aligned behavior in `tests/regression/postgres-adapter.conformance.test.ts`.
- [ ] T035 [P] Add PostgreSQL golden/regression scenarios for integrity and recovery in `tests/golden/postgres-adapter.golden.test.ts` and `tests/regression/postgres-adapter.regression.test.ts`.
- [ ] T036 [P] Add scale/latency validation scenario coverage (10k events / 100 conversations) in `tests/regression/postgres-adapter.scale.test.ts`.
- [ ] T037 Update acceptance checklist evidence and execution notes in `specs/001-postgres-adapter/quickstart.md`.
- [ ] T038 Execute full workspace gates defined in `package.json` and record final feature sign-off notes in `specs/001-postgres-adapter/quickstart.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: depends on Phase 2; MVP slice.
- **Phase 4 (US2)**: depends on Phase 2 (and can start after US1 if strict priority sequencing is desired).
- **Phase 5 (US3)**: depends on Phase 2 (and can start after US1 if strict priority sequencing is desired).
- **Phase 6 (Polish)**: depends on completion of selected user stories.

### User Story Dependencies

- **US1 (P1)**: no dependency on other stories after foundational tasks.
- **US2 (P2)**: independent after foundational tasks; integrates naturally with US1 persistence outputs.
- **US3 (P3)**: independent after foundational tasks; validates concurrency and failure behavior across shared stores.

### Within Each User Story

- Tests first (write/update tests before final implementation adjustments).
- Store behavior implementation before acceptance-flow validation task.
- Story must pass its independent test criteria before moving to next priority story for release.

### Parallel Opportunities

- Foundational tasks marked `[P]`: T005
- US1 test tasks marked `[P]`: T010, T011, T012
- US2 test tasks marked `[P]`: T018, T019, T020, T021
- US3 test tasks marked `[P]`: T027, T028, T029
- Polish tasks marked `[P]`: T034, T035, T036, T037

---

## Parallel Example: User Story 1

```bash
# Run in parallel:
T010 [US1] packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts
T011 [US1] packages/infrastructure/src/postgres/__tests__/pg-conversation-store.test.ts
T012 [US1] packages/infrastructure/src/postgres/__tests__/pg-context-projection.test.ts
```

## Parallel Example: User Story 2

```bash
# Run in parallel:
T018 [US2] packages/infrastructure/src/postgres/__tests__/pg-summary-dag.test.ts
T020 [US2] packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts
T021 [US2] packages/infrastructure/src/postgres/__tests__/pg-artifact-store.test.ts
```

## Parallel Example: User Story 3

```bash
# Run in parallel:
T027 [US3] packages/infrastructure/src/postgres/__tests__/pg-context-projection.test.ts
T028 [US3] packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts
T029 [US3] packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Phase 1 (Setup).
2. Complete Phase 2 (Foundational).
3. Complete Phase 3 (US1).
4. Validate US1 independent test criteria before broadening scope.

### Incremental Delivery

1. Setup + Foundational establish stable persistence baseline.
2. Deliver US1 (persistent operations), validate, release.
3. Deliver US2 (compaction/retrieval integrity), validate, release.
4. Deliver US3 (concurrency/atomicity/retry safety), validate, release.
5. Run Phase 6 cross-cutting gates and finalize acceptance evidence.

### Parallel Team Strategy

1. Team completes Phases 1-2 together.
2. After foundational completion:
   - Engineer A: US1 tasks
   - Engineer B: US2 tasks
   - Engineer C: US3 tasks
3. Merge at Phase 6 with conformance/golden/regression and workspace gates.

---

## Notes

- All tasks follow strict checklist format: checkbox + Task ID + optional `[P]` + optional `[US#]` + explicit file path.
- `[US#]` labels are intentionally used only in user-story phases.
- Conformance/golden/regression tasks are included because they are explicit feature requirements.
