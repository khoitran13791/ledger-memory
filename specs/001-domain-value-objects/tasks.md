# Tasks: Domain Package Foundations

**Input**: Design documents from `/specs/001-domain-value-objects/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included, because `spec.md` requires automated invariant and deterministic identity verification (SC-002, SC-003).

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: User story label (`[US1]`, `[US2]`, `[US3]`) for story-phase tasks only
- Every task includes exact file path(s)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare `@ledgermind/domain` structure and export scaffolding.

- [X] T001 Create category barrel files in `packages/domain/src/entities/index.ts`, `packages/domain/src/value-objects/index.ts`, `packages/domain/src/services/index.ts`, `packages/domain/src/events/index.ts`, and `packages/domain/src/errors/index.ts`
- [X] T002 Update root export surface in `packages/domain/src/index.ts` to re-export all five domain categories
- [X] T003 Align package scaffold for strict domain work in `packages/domain/package.json` and `packages/domain/tsconfig.json` (keep zero runtime dependencies, strict typecheck/test scripts)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement shared value-object and baseline error primitives required by all stories.

**⚠️ CRITICAL**: No user story work starts until this phase is complete.

- [X] T004 Implement branded ID/scalar value objects in `packages/domain/src/value-objects/ids.ts`
- [X] T005 [P] Implement non-negative token value object + factory in `packages/domain/src/value-objects/token-count.ts`
- [X] T006 [P] Implement compaction threshold invariants (`0 < soft < hard`) in `packages/domain/src/value-objects/compaction-thresholds.ts`
- [X] T007 [P] Implement token budget value object (`available >= 0`) in `packages/domain/src/value-objects/token-budget.ts`
- [X] T008 [P] Implement role/mime/timestamp/context-version value objects in `packages/domain/src/value-objects/message-role.ts`, `packages/domain/src/value-objects/mime-type.ts`, `packages/domain/src/value-objects/timestamp.ts`, and `packages/domain/src/value-objects/context-version.ts`
- [X] T009 Implement baseline domain error contracts used by invariant checks in `packages/domain/src/errors/domain-errors.ts`
- [X] T010 Update foundational exports in `packages/domain/src/value-objects/index.ts` and `packages/domain/src/index.ts`
- [X] T011 Add foundational invariant tests for shared value objects in `packages/domain/src/value-objects/__tests__/value-objects.test.ts`

**Checkpoint**: Shared primitives are complete; user stories can proceed.

---

## Phase 3: User Story 1 - Define canonical domain model (Priority: P1) 🎯 MVP

**Goal**: Deliver complete domain entities (Conversation, LedgerEvent, SummaryNode, DagEdge, ContextItem, Artifact) with explicit invariants.

**Independent Test**: Validate all required entity concepts exist and invalid constructions fail with domain-level errors.

### Tests for User Story 1

- [X] T012 [P] [US1] Add conversation invariant tests in `packages/domain/src/entities/__tests__/conversation.test.ts`
- [X] T013 [P] [US1] Add ledger event invariant tests in `packages/domain/src/entities/__tests__/ledger-event.test.ts`
- [X] T014 [P] [US1] Add summary/dag/context/artifact invariant tests in `packages/domain/src/entities/__tests__/summary-context-artifact.test.ts`

### Implementation for User Story 1

- [X] T015 [P] [US1] Implement `Conversation` and `ConversationConfig` with threshold/context-window invariants in `packages/domain/src/entities/conversation.ts`
- [X] T016 [P] [US1] Implement immutable `LedgerEvent` contract and metadata typing in `packages/domain/src/entities/ledger-event.ts`
- [X] T017 [P] [US1] Implement `SummaryNode` and `SummaryKind` contracts in `packages/domain/src/entities/summary-node.ts`
- [X] T018 [P] [US1] Implement `DagEdge` variants and edge order guards in `packages/domain/src/entities/dag-edge.ts`
- [X] T019 [P] [US1] Implement `ContextItem` and `ContextItemRef` contracts in `packages/domain/src/entities/context-item.ts`
- [X] T020 [P] [US1] Implement `Artifact` and `StorageKind` path-storage constraints in `packages/domain/src/entities/artifact.ts`
- [X] T021 [US1] Export all entity contracts from `packages/domain/src/entities/index.ts` and `packages/domain/src/index.ts`

**Checkpoint**: US1 is independently testable and provides the MVP domain model.

---

## Phase 4: User Story 2 - Ensure deterministic identity and value semantics (Priority: P2)

**Goal**: Deliver deterministic ID semantics and pure domain services for budget and compaction policy decisions.

**Independent Test**: Re-run fixed fixtures to confirm stable ID outputs and deterministic service behavior.

### Tests for User Story 2

- [X] T022 [P] [US2] Add deterministic ID tests (repeatability, excluded-field stability, included-field divergence, Unicode canonicalization) in `packages/domain/src/services/__tests__/id.service.test.ts`
- [X] T023 [P] [US2] Add token budget computation tests in `packages/domain/src/services/__tests__/token-budget.service.test.ts`
- [X] T024 [P] [US2] Add compaction candidate/escalation tests in `packages/domain/src/services/__tests__/compaction-policy.service.test.ts`

### Implementation for User Story 2

- [X] T025 [US2] Define `HashPort` and canonical sorted-key JSON serializer in `packages/domain/src/services/id.service.ts`
- [X] T026 [US2] Implement deterministic `IdService` for `evt_`, `sum_`, and `file_` IDs per addendum field rules in `packages/domain/src/services/id.service.ts`
- [X] T027 [P] [US2] Implement `TokenBudgetService` methods in `packages/domain/src/services/token-budget.service.ts`
- [X] T028 [P] [US2] Implement `CompactionPolicyService`, `PinRule`, and `CompactionCandidate` logic in `packages/domain/src/services/compaction-policy.service.ts`
- [X] T029 [US2] Export service contracts from `packages/domain/src/services/index.ts` and `packages/domain/src/index.ts`

**Checkpoint**: US2 determinism and value semantics are independently validated.

---

## Phase 5: User Story 3 - Provide shared domain events and error taxonomy (Priority: P2)

**Goal**: Deliver stable domain events and domain error taxonomy consumable by application layer orchestration.

**Independent Test**: Validate event payload contracts and error codes/inheritance using representative operations.

### Tests for User Story 3

- [X] T030 [P] [US3] Add error taxonomy tests (codes + inheritance) in `packages/domain/src/errors/__tests__/domain-errors.test.ts`
- [X] T031 [P] [US3] Add domain event contract tests (required fields + union coverage) in `packages/domain/src/events/__tests__/domain-events.test.ts`

### Implementation for User Story 3

- [X] T032 [P] [US3] Finalize specialized domain errors (`HashMismatchError`, `InvalidDagEdgeError`, `NonMonotonicSequenceError`, `BudgetExceededError`) in `packages/domain/src/errors/domain-errors.ts`
- [X] T033 [P] [US3] Implement domain event contracts and `DomainEvent` union in `packages/domain/src/events/domain-events.ts`
- [X] T034 [US3] Export events/errors from `packages/domain/src/events/index.ts`, `packages/domain/src/errors/index.ts`, and `packages/domain/src/index.ts`

**Checkpoint**: US3 contracts are independently consumable by downstream layers.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification against quality gates, contract completeness, and zero-dependency requirement.

- [X] T035 [P] Run package-level quality gates and fix remaining issues in `packages/domain/src/**` via `pnpm --filter @ledgermind/domain lint`, `typecheck`, and `test`
- [X] T036 [P] Run workspace verification from quickstart against domain changes in `packages/domain/src/**` using `pnpm lint`, `pnpm typecheck`, and `pnpm test`
- [X] T037 Validate public API coverage against `specs/001-domain-value-objects/contracts/domain-public-api.md` and reconcile exports in `packages/domain/src/index.ts`
- [X] T038 Verify zero runtime dependencies remain in `packages/domain/package.json` and feature acceptance checks align with `specs/001-domain-value-objects/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies
- **Phase 2 (Foundational)**: Depends on Phase 1; blocks all user stories
- **Phase 3 (US1)**: Depends on Phase 2
- **Phase 4 (US2)**: Depends on Phase 2 and US1 entity contracts
- **Phase 5 (US3)**: Depends on Phase 2 and US1 entity contracts
- **Phase 6 (Polish)**: Depends on completed target stories (US1 required; US2/US3 as selected release scope)

### User Story Dependency Graph

- `US1 (P1)` → foundation for all downstream work
- `US2 (P2)` and `US3 (P2)` can proceed in parallel after `US1` is complete

### Within Each User Story

- Tests first (fail before implementation)
- Core implementation next
- Exports last

---

## Parallel Execution Examples

### User Story 1

```bash
# Parallel invariant tests
T012, T013, T014

# Parallel entity implementations
T015, T016, T017, T018, T019, T020
```

### User Story 2

```bash
# Parallel service tests
T022, T023, T024

# Parallel independent service implementations
T027, T028
```

### User Story 3

```bash
# Parallel contract tests
T030, T031

# Parallel implementation in separate files
T032, T033
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Phase 1 + Phase 2
2. Complete Phase 3 (US1)
3. Validate US1 independently
4. Ship MVP domain model contracts

### Incremental Delivery

1. Deliver US1 (canonical model)
2. Add US2 (deterministic IDs + services)
3. Add US3 (events + error taxonomy)
4. Run Phase 6 cross-cutting verification

### Team Parallelization Strategy

- One developer on US2, one on US3 after US1 checkpoint
- Keep export/barrel tasks coordinated to avoid merge conflicts in `packages/domain/src/index.ts`

---

## Notes

- `[P]` tasks are safe parallel candidates by file isolation.
- All tasks preserve Clean Architecture dependency rules for `packages/domain`.
- All tasks are scoped to the domain package and feature artifacts only.
