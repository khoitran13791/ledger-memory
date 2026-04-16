# Operator-Level Recursion And Durable Execution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full documented operator-recursion surface in LedgerMind: durable `llmMap()` and `agenticMap()` submission APIs, DB-backed run/task execution state, retry-safe child conversation delegation, a polling-first worker app, and runtime-bound tool exposure.

**Architecture:** Keep `MemoryEngine` as the only public business API, move all operator semantics into new application-layer DTOs/use cases/ports, and make durable persistence the source of truth for claims, retries, bootstrap state, and finalization. Reuse existing conversation, ledger, context, DAG, artifact, and SDK composition patterns; add only the focused ports and adapters needed for `llmMap` and `agenticMap`, not a generic workflow engine.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspace packages, existing `@ledgermind/domain` / `@ledgermind/application` / `@ledgermind/adapters` / `@ledgermind/infrastructure` / `@ledgermind/sdk`, PostgreSQL, existing in-memory adapters, Vercel AI tool adapter surface, Vitest, and repo-wide `typecheck` / `lint` / `test` quality gates.

---

## Scope And Non-Goals

### In Scope

- Durable `MemoryEngine.llmMap()`, `MemoryEngine.agenticMap()`, and `MemoryEngine.getOperatorRun()`.
- Atomic run/task creation with idempotency and artifact-backed datasets.
- DB-backed task claiming, leasing, retry scheduling, and finalization-stage recovery.
- Child conversation creation/reuse with durable bootstrap state and explicit delegated scope.
- Polling-first worker app with optional queue wake-up hints.
- Ordered JSONL result artifacts and compact parent handles.
- In-memory/Postgres parity tests and worker crash/duplicate-delivery regression coverage.
- Tool exposure for recursion operators with runtime-bound caller context.

### Explicit Non-Goals For This Plan

- Generic workflow or DAG-orchestration abstractions beyond `llmMap` and `agenticMap`.
- Cross-conversation summary/message references.
- Hosted orchestration, SaaS control planes, or dashboards.
- Human review steps or cancellation semantics.
- New runtime-specific SDK packages beyond the existing adapter/tool surfaces.

---

## Senior Preflight

## Scope And Critical Paths

- Primary user journey 1: a caller submits `llmMap()` or `agenticMap()` and receives a durable `runId` immediately.
- Primary user journey 2: a worker claims tasks safely under race, executes one attempt, records terminal or retryable state, and re-drives finalization if needed.
- Primary user journey 3: `agenticMap()` creates exactly one child conversation per task, bootstraps it once, reuses it across retries, and validates structured output.
- Primary user journey 4: callers inspect progress via `getOperatorRun()` and tool adapters surface compact handles instead of full result payloads.
- Latency-sensitive operations: submit path, `getOperatorRun()` inspection, task claim loop, and finalization retry recovery.
- Data sensitivity: delegated messages/summaries/artifacts, child lineage metadata, structured outputs, and any tool-access side effects inside child conversations.

## Architecture Decision

### Components (SRP Analysis)

| Component | Responsibility | Non-Responsibilities |
|-----------|----------------|----------------------|
| Application operator DTOs + use cases | Define operator input/output semantics, validation, retries, bootstrap/finalization orchestration | SQL, runtime SDK calls, queue polling loops |
| `OperatorExecutionPort` adapters | Persist runs/tasks, enforce concurrency-safe claiming, resume finalization | LLM execution, child bootstrapping semantics |
| Structured generation / sub-agent / delegation ports | Execute one item, one child run, or one delegated-scope resolution behind narrow abstractions | Durable state mutation |
| Worker app | Poll DB, optionally consume wake-up hints, run one task/finalization attempt at a time, shut down safely | Business-rule ownership |
| Tool adapters | Bind runtime caller context, validate payload size, expose run handles | Durable orchestration internals |
| SDK composition root | Assemble concrete ports/adapters/config into a `MemoryEngine` | Business-rule branching beyond composition |

### Clean Architecture Verification

- Domain remains unchanged and still has zero framework/runtime imports.
- Application owns operator DTOs, statuses, ports, and use cases.
- Adapters own in-memory persistence and runtime/tool mapping only.
- Infrastructure owns Postgres schema, SQL claiming/finalization logic, and worker wiring.
- SDK remains the composition root and exposes explicit override points for runtime executors.

### SOLID Evaluation

- SRP: Pass if run submission, task execution, run finalization, scope resolution, and worker polling each live in separate files/use cases.
- OCP: Pass if new runtimes only implement `StructuredGenerationPort`, `SubAgentExecutorPort`, or tool wrappers without editing operator use cases.
- LSP: Pass if in-memory and Postgres adapters satisfy the same `OperatorExecutionPort` contract tests.
- ISP: Pass if worker app depends on operator execution + runtime executor ports only, not unrelated memory APIs.
- DIP: Pass if application imports only ports and domain primitives, never `pg`, `ai`, or worker-framework types.

## Performance Budget

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| `llmMap()` / `agenticMap()` submit p50 (in-memory) | < 100 ms for small inline datasets | Application integration timing |
| `llmMap()` / `agenticMap()` submit p95 (local Postgres) | < 250 ms excluding actual LLM runtime | SDK + Postgres integration timing |
| `getOperatorRun()` p50 without inline results | < 50 ms | Application + SDK tests |
| Duplicate claim recovery after lease expiry | Within one poll interval + one successful claim | Worker regression test |
| Finalization retry recovery | No duplicate artifact/handle writes under concurrent retries | Persistence contract + worker tests |
| Parent-handle payload size | Always below `maxKeptWorkChars` / compact-handle limits | DTO/unit tests |

## Security Controls

| Threat | Category | Likelihood | Impact | Mitigation |
|--------|----------|------------|--------|------------|
| Caller context spoofing in tools | Security | Medium | Critical | Bind conversation/caller context from runtime adapter options, not tool payloads |
| Cross-conversation delegated-scope leakage | Security | Medium | Critical | Resolve scope only from parent-owned references and copy into child-local events/artifacts |
| Unauthorized `expand()` from non-child contexts | Security | Medium | High | Verify actual caller conversation lineage through `ConversationPort` plus auth adapter |
| Duplicate queue delivery / worker crash corruption | Reliability | High | High | DB-backed conditional claims, leases, terminal write guards, finalization-stage checkpoints |
| Parent context bloat from operator outputs | Reliability | Medium | High | Store full inputs/outputs in artifacts and append compact handles only |

## Test Strategy By Layer

| Layer | Test Type | Coverage Target | Focus |
|-------|-----------|-----------------|-------|
| Application DTOs + use cases | Unit + integration | High | Validation, zero-item flows, retries, bootstrap/finalization state machines |
| In-memory persistence | Unit + contract | High | Idempotent create, claim races, lease expiry, child reuse, ordered finalization |
| Postgres persistence | Integration + contract | High | Atomic setup, conditional updates, unique constraints, recovery after duplicate writes |
| SDK composition | Integration | Medium | Stable public API, inline mode parity, config validation |
| Worker app | Integration + regression | High | Polling correctness, duplicate delivery, crash recovery, graceful shutdown |
| Tool adapters | Integration | Medium | Runtime-bound caller context, payload ceilings, handle-only outputs |
| Cross-adapter tests | Conformance + e2e | High | In-memory/Postgres parity and recursive operator behavior |

---

## File Structure

### Existing Files To Modify

- `packages/application/src/ports/driving/memory-engine.port.ts` - add operator methods and import the new operator DTO families.
- `packages/application/src/ports/driven/persistence/unit-of-work.port.ts` - expose `operators` inside transactional units of work.
- `packages/application/src/ports/driven/auth/authorization.port.ts` - keep the auth policy narrow while passing enough caller metadata for child-only `expand()` decisions.
- `packages/application/src/ports/driving/tool-provider.port.ts` - update the tool-provider contract if runtime-bound caller context changes the tool factory signature.
- `packages/application/src/ports/driven/jobs/job-queue.port.ts` - replace the unused completion callback API with queue wake-up subscription semantics that workers can consume.
- `packages/application/src/errors/application-errors.ts` - add operator-specific validation/not-found/bootstrap/finalization errors.
- `packages/application/src/index.ts` - export new DTOs, ports, and use cases.
- `packages/application/src/use-cases/expand.ts` - verify actual child-conversation lineage before allowing `expand()`.
- `packages/adapters/src/storage/in-memory/state.ts` - persist operator runs/tasks, idempotency indexes, bootstrap/finalization state, and task ordinals.
- `packages/adapters/src/storage/in-memory/index.ts` - export the in-memory operator execution store.
- `packages/adapters/src/storage/in-memory/in-memory-unit-of-work.ts` - include the new operator store in cloned transactional state.
- `packages/adapters/src/auth/sub-agent-authorization.adapter.ts` - enforce child-only expand policy using the updated authorization contract.
- `packages/adapters/src/jobs/in-memory-job-queue.adapter.ts` - support queue wake-up subscriptions and deterministic delivery in tests.
- `packages/adapters/src/jobs/__tests__/in-memory-job-queue.adapter.test.ts` - update queue tests for the new contract.
- `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts` - bind caller context from runtime options and expose `memory.llmMap`, `memory.agenticMap`, and `memory.getOperatorRun`.
- `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts` - update tool-schema and runtime-context assertions for the new operator tools.
- `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts` - keep the tool export surface aligned with the updated adapter API.
- `packages/adapters/src/tools/index.ts` - export any updated tool adapter signatures.
- `packages/adapters/src/index.ts` - re-export the new in-memory operator store.
- `packages/infrastructure/src/postgres/pg-unit-of-work.ts` - include the Postgres operator store in the unit of work.
- `packages/infrastructure/src/postgres/__tests__/pg-unit-of-work.test.ts` - update UoW tests for the new `operators` handle.
- `packages/infrastructure/src/postgres/__tests__/postgres-test-harness.ts` - provision operator tables and runtime handles for cross-adapter tests.
- `packages/infrastructure/src/index.ts` - export the Postgres operator store.
- `packages/infrastructure/src/sql/postgres/migrations/0001_phase1_schema.sql` - leave unchanged, but use as style reference for the new operator migrations.
- `packages/sdk/src/index.ts` - add operator config, runtime override points, and wire the new use cases into `createMemoryEngine()`, including the updated `ExpandUseCase` constructor.
- `packages/sdk/src/index.test.ts` - extend the stable engine contract and config validation tests.
- `tests/conformance/run-conformance.ts` - register the new operator execution conformance suite.
- `tests/conformance/__tests__/conformance.cross-adapter.test.ts` - include operator execution stores in both runtimes.
- `tests/vitest.config.ts` - add an alias for the worker app package if shared tests import it.
- `tests/package.json` - add focused scripts for operator conformance/regression if needed.
- `package.json` - add root scripts for the operator worker app and recursion-focused test commands.
- `tsconfig.json` - add a project reference for the new worker app.
- `README.md` - document durable operators, worker startup, and inspection flow.
- `docs/high-level-design.md` - update the architecture document if queue port or operator worker details become part of the implemented public architecture.

### New Files To Create In `@ledgermind/application`

- `packages/application/src/ports/driving/operator-execution.port.ts` - operator DTOs, enums, statuses, result-entry shapes, and config types.
- `packages/application/src/ports/driven/persistence/operator-execution.port.ts` - durable run/task persistence contract.
- `packages/application/src/ports/driven/llm/structured-generation.port.ts` - one-item structured generation contract.
- `packages/application/src/ports/driven/agents/sub-agent-executor.port.ts` - child-conversation execution contract.
- `packages/application/src/ports/driven/agents/delegation-scope-resolver.port.ts` - bounded delegated-scope resolution contract.
- `packages/application/src/use-cases/operators/shared/operator-config.ts` - operator defaults/limits used by submit, execute, and inspect paths.
- `packages/application/src/use-cases/operators/shared/input-dataset.ts` - load/validate inline vs artifact-backed item datasets.
- `packages/application/src/use-cases/operators/shared/result-entry.ts` - ordered finalized result-entry shapes shared by finalization and inspection.
- `packages/application/src/use-cases/operators/shared/finalization-handle.ts` - compact parent-handle metadata builder and idempotency key helpers.
- `packages/application/src/use-cases/llm-map.ts` - durable `llmMap()` submission use case.
- `packages/application/src/use-cases/agentic-map.ts` - durable `agenticMap()` submission use case.
- `packages/application/src/use-cases/execute-operator-task.ts` - one-attempt worker execution use case for both operator kinds.
- `packages/application/src/use-cases/finalize-operator-run.ts` - ordered output artifact + parent-handle finalization use case.
- `packages/application/src/use-cases/get-operator-run.ts` - run/task inspection use case.
- `packages/application/src/use-cases/__tests__/operator-test-doubles.ts` - reusable deterministic doubles for operator tests.
- `packages/application/src/use-cases/__tests__/llm-map.test.ts`
- `packages/application/src/use-cases/__tests__/agentic-map.test.ts`
- `packages/application/src/use-cases/__tests__/execute-operator-task.test.ts`
- `packages/application/src/use-cases/__tests__/finalize-operator-run.test.ts`
- `packages/application/src/use-cases/__tests__/get-operator-run.test.ts`

### New Files To Create In `@ledgermind/adapters`

- `packages/adapters/src/storage/in-memory/in-memory-operator-execution-store.ts` - in-memory `OperatorExecutionPort` implementation with lease, retry, bootstrap, and finalization fidelity.
- `packages/adapters/src/storage/in-memory/__tests__/in-memory-operator-execution-store.test.ts` - focused unit tests for the in-memory operator store.

### Concrete Runtime Implementations For V1

- V1 does **not** require repo-owned production implementations of `StructuredGenerationPort`, `SubAgentExecutorPort`, or `DelegationScopeResolverPort` beyond deterministic test doubles.
- The repo should ship **port contracts, deterministic test doubles, and SDK/worker composition hooks** so host applications can inject real LLM/sub-agent/scope-resolution implementations.
- The worker app and `createMemoryEngine()` must fail fast with actionable errors if required runtime executors are missing for the selected operator mode.
- If implementation work reveals a small shared composition helper would eliminate duplicated SDK/worker wiring without creating a generic framework, add it under `packages/sdk/src/` and keep it operator-specific.

### New Files To Create In `@ledgermind/infrastructure`

- `packages/infrastructure/src/sql/postgres/migrations/0003_operator_execution_schema.sql` - `operator_runs` / `operator_tasks` tables and enums/check constraints.
- `packages/infrastructure/src/sql/postgres/migrations/0004_operator_execution_indexes.sql` - idempotency, run lookup, claim, lease-expiry, and finalization indexes.
- `packages/infrastructure/src/postgres/pg-operator-execution-store.ts` - Postgres `OperatorExecutionPort` implementation.
- `packages/infrastructure/src/postgres/__tests__/pg-operator-execution-store.test.ts` - focused Postgres operator-store tests.

### New Worker App Package

- `apps/operator-worker/package.json` - worker package metadata and scripts.
- `apps/operator-worker/tsconfig.json` - app TypeScript config.
- `apps/operator-worker/src/index.ts` - public exports.
- `apps/operator-worker/src/cli.ts` - runnable worker entry point.
- `apps/operator-worker/src/config.ts` - env/CLI parsing for DB config, polling interval, batch limits, worker id, and inline/local mode.
- `apps/operator-worker/src/poll-loop.ts` - claim + finalization retry polling loop.
- `apps/operator-worker/src/worker.ts` - composition root that executes one task/finalization attempt at a time.
- `apps/operator-worker/src/logging.ts` - structured logger helpers for consistent worker diagnostics.
- `apps/operator-worker/src/__tests__/config.test.ts`
- `apps/operator-worker/src/__tests__/poll-loop.test.ts`
- `apps/operator-worker/src/__tests__/worker.test.ts`

### New Cross-Adapter / Regression / Documentation Files

- `tests/conformance/persistence/operator-execution.conformance.ts` - adapter contract suite for `OperatorExecutionPort`.
- `tests/regression/operator-recursion.e2e.test.ts` - durable operator end-to-end test across application + SDK layers.
- `tests/regression/operator-worker.e2e.test.ts` - worker crash, duplicate-delivery, lease-recovery, and finalization-retry regressions.
- `tests/regression/operator-tool-surface.test.ts` - recursion tool adapter integration test.
- `docs/operator-level-recursion.md` - operator API, worker, lineage, and inspection documentation.

---

## Chunk 1: Public Contracts And Application Boundaries

### Task 1: Add operator DTOs and extend the public `MemoryEngine` surface

**Files:**
- Create: `packages/application/src/ports/driving/operator-execution.port.ts`
- Modify: `packages/application/src/ports/driving/memory-engine.port.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.test.ts`

- [ ] **Step 1: Write the failing SDK contract test before adding any DTOs.**

In `packages/sdk/src/index.test.ts`, extend `expectedEngineMethods` to include `llmMap`, `agenticMap`, and `getOperatorRun`, and add one assertion that the operator status/result-entry types are re-exported from `@ledgermind/application`.

- [ ] **Step 2: Run the SDK test to lock the failure mode.**

Run: `pnpm --filter @ledgermind/sdk test -- --run src/index.test.ts`
Expected: FAIL because the new methods and exports do not exist.

- [ ] **Step 3: Create the operator DTO file with the full v1 contract.**

Add `packages/application/src/ports/driving/operator-execution.port.ts` with explicit types for:
- `OperatorKind = 'llmMap' | 'agenticMap'`
- `OperatorRunStatus = 'pending' | 'running' | 'completed' | 'completed_with_failures' | 'failed'`
- `OperatorTaskStatus = 'pending' | 'running' | 'retryable_failure' | 'succeeded' | 'failed'`
- `OperatorBootstrapState = 'bootstrap_not_started' | 'bootstrap_in_progress' | 'bootstrap_completed'`
- `OperatorFinalizationStage = 'not_started' | 'artifact_written' | 'handle_appended' | 'completed'`
- `RetryPolicy`, `DelegatedScopeInput`, `KeptWorkInput`, `LLMMapInput`, `LLMMapOutput`, `AgenticMapInput`, `AgenticMapOutput`, `GetOperatorRunInput`, `GetOperatorRunOutput`, `OperatorTaskInspection`, `OperatorResultEntry`, and `OperatorFailureMetadata`
- explicit comments or naming that preserve the spec’s “submit returns runId, inspection returns results” contract.

- [ ] **Step 4: Extend `MemoryEngine` to expose the new APIs without moving existing methods.**

Update `packages/application/src/ports/driving/memory-engine.port.ts` so `MemoryEngine` gains:
- `llmMap(input: LLMMapInput): Promise<LLMMapOutput>`
- `agenticMap(input: AgenticMapInput): Promise<AgenticMapOutput>`
- `getOperatorRun(input: GetOperatorRunInput): Promise<GetOperatorRunOutput>`

Do not relocate the existing append/materialize/describe APIs; keep the diff focused on imports and interface expansion.

- [ ] **Step 5: Re-export every new public type through `packages/application/src/index.ts`.**

Re-export the operator DTOs so downstream packages never import deep file paths.

- [ ] **Step 6: Re-run the SDK contract test and application typecheck.**

Run: `pnpm --filter @ledgermind/sdk test -- --run src/index.test.ts`
Expected: FAIL now for missing SDK wiring, not for missing types.

Run: `pnpm --filter @ledgermind/application typecheck && pnpm --filter @ledgermind/sdk typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the public contract slice separately.**

```bash
git add packages/application/src/ports/driving/operator-execution.port.ts packages/application/src/ports/driving/memory-engine.port.ts packages/application/src/index.ts packages/sdk/src/index.test.ts
git commit -m "feat: add operator execution memory engine contracts"
```

### Task 2: Add the new driven ports, operator config helpers, and application error surface

**Files:**
- Create: `packages/application/src/ports/driven/persistence/operator-execution.port.ts`
- Create: `packages/application/src/ports/driven/llm/structured-generation.port.ts`
- Create: `packages/application/src/ports/driven/agents/sub-agent-executor.port.ts`
- Create: `packages/application/src/ports/driven/agents/delegation-scope-resolver.port.ts`
- Create: `packages/application/src/use-cases/operators/shared/operator-config.ts`
- Create: `packages/application/src/use-cases/operators/shared/input-dataset.ts`
- Create: `packages/application/src/use-cases/operators/shared/result-entry.ts`
- Create: `packages/application/src/use-cases/__tests__/get-operator-run.test.ts`
- Modify: `packages/application/src/errors/application-errors.ts`
- Modify: `packages/application/src/ports/driven/persistence/unit-of-work.port.ts`
- Modify: `packages/application/src/index.ts`

- [ ] **Step 1: Write a failing application test that proves the operator helpers and errors are not wired yet.**

Create `packages/application/src/use-cases/__tests__/get-operator-run.test.ts` with two initial assertions:
1. `getOperatorRun()` should inline ordered results only when under the configured byte ceiling.
2. requesting a missing run should throw a dedicated operator run not found error.

- [ ] **Step 2: Run the new test to confirm the missing pieces.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/get-operator-run.test.ts`
Expected: FAIL because the use case, helper files, and errors do not exist.

- [ ] **Step 3: Define the persistence and runtime ports with exact method names from the spec.**

In `operator-execution.port.ts`, include methods for at least:
- atomic create run + task batch
- `getRun`, `getTask`, `listTasksForRun`, and `lookupRunByIdempotencyKey`
- `claimTaskLease`, `recordTaskSuccess`, `recordTaskFailure`, `markTaskRetryableFailure`
- `assignTaskChildConversation`, `getTaskBootstrapState`, `markBootstrapStarted`, `markBootstrapCompleted`
- `claimRunForFinalizationRetry`, `advanceFinalizationStage`, and `finalizeRun`

Keep runtime execution out of this port.

- [ ] **Step 4: Add the focused runtime ports and shared helper files.**

Create:
- `structured-generation.port.ts` with one-item structured output generation and typed failure metadata.
- `sub-agent-executor.port.ts` with `childConversationId`, output schema, timeout, and structured terminal result.
- `delegation-scope-resolver.port.ts` with pure bootstrap payload/artifact/reference output.
- `operator-config.ts` with repo defaults and helper validation for `maxConcurrencyLimit`, `maxInlineOperatorInputBytes`, `maxKeptWorkChars`, `maxInlineRunResultsBytes`, timeout, and lease duration.
- `input-dataset.ts` with the shared “exactly one of inline items or input artifact id” validation and artifact-backed dataset loading contract.
- `result-entry.ts` with the discriminated `succeeded` / `failed` finalized row shape used by JSONL output and `inlineResults`.

- [ ] **Step 5: Extend application errors and the unit-of-work shape.**

Add operator-specific errors such as:
- `OperatorRunNotFoundError`
- `OperatorInputValidationError`
- `OperatorBootstrapStateError`
- `OperatorFinalizationError`

Then extend `UnitOfWork` / `UnitOfWorkPort` so transactional work receives `uow.operators` alongside ledger/context/dag/artifacts/conversations.

- [ ] **Step 6: Export the new ports/helpers and rerun targeted tests.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/get-operator-run.test.ts`
Expected: FAIL now because `GetOperatorRunUseCase` itself is still missing, but ports/helpers/errors should compile.

Run: `pnpm --filter @ledgermind/application typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the application boundary slice.**

```bash
git add packages/application/src/ports/driven/persistence/operator-execution.port.ts packages/application/src/ports/driven/llm/structured-generation.port.ts packages/application/src/ports/driven/agents/sub-agent-executor.port.ts packages/application/src/ports/driven/agents/delegation-scope-resolver.port.ts packages/application/src/use-cases/operators/shared/operator-config.ts packages/application/src/use-cases/operators/shared/input-dataset.ts packages/application/src/use-cases/operators/shared/result-entry.ts packages/application/src/errors/application-errors.ts packages/application/src/ports/driven/persistence/unit-of-work.port.ts packages/application/src/index.ts packages/application/src/use-cases/__tests__/get-operator-run.test.ts
git commit -m "feat: add operator execution ports and shared helpers"
```

---

## Chunk 2: Durable Persistence Contracts And Adapter Parity

### Task 3: Add the `OperatorExecutionPort` contract suite and implement the in-memory adapter

**Files:**
- Create: `tests/conformance/persistence/operator-execution.conformance.ts`
- Modify: `tests/conformance/run-conformance.ts`
- Modify: `tests/conformance/__tests__/conformance.cross-adapter.test.ts`
- Create: `packages/adapters/src/storage/in-memory/in-memory-operator-execution-store.ts`
- Create: `packages/adapters/src/storage/in-memory/__tests__/in-memory-operator-execution-store.test.ts`
- Modify: `packages/adapters/src/storage/in-memory/state.ts`
- Modify: `packages/adapters/src/storage/in-memory/index.ts`
- Modify: `packages/adapters/src/storage/in-memory/in-memory-unit-of-work.ts`
- Modify: `packages/adapters/src/storage/in-memory/__tests__/in-memory-unit-of-work.test.ts`
- Modify: `packages/adapters/src/index.ts`

- [ ] **Step 1: Write the cross-adapter conformance tests before touching state.**

Create `tests/conformance/persistence/operator-execution.conformance.ts` covering:
- idempotent run creation with same normalized input
- idempotency conflict for same key + different normalized input
- duplicate task-claim rejection under race
- expired lease reclamation
- child conversation assignment only once per task
- finalization-stage progression and idempotent terminalization

- [ ] **Step 2: Register the new conformance suite and run it to lock the initial failure.**

Run: `pnpm --filter @ledgermind/tests test -- --run conformance/__tests__/conformance.cross-adapter.test.ts`
Expected: FAIL because neither runtime exposes an operator store yet.

- [ ] **Step 3: Extend the in-memory persistence state with operator run/task storage.**

Add maps/indexes for at least:
- runs by id
- tasks by id
- ordered task ids by run
- run lookup by `(conversationId, idempotencyKey)`
- per-run counters/ordinals as needed for deterministic IDs

Ensure `cloneInMemoryPersistenceState()` and `applyInMemoryPersistenceState()` deep-copy all new structures so `InMemoryUnitOfWork` remains transactionally faithful.

- [ ] **Step 4: Implement the in-memory operator store with the exact durable semantics.**

`in-memory-operator-execution-store.ts` must preserve the same behavior the Postgres store will later enforce:
- atomic create-run + create-task-batch
- concurrency-limit-aware `claimTaskLease()`
- lease expiry reclamation
- child conversation reuse and bootstrap-state transitions
- finalization-stage progression without duplicate terminal writes
- ordered task listing by `itemIndex`

- [ ] **Step 5: Wire the in-memory operator store through exports and unit of work.**

Update `state.ts`, `index.ts`, `in-memory-unit-of-work.ts`, `packages/adapters/src/index.ts`, and the conformance runtime builder so `uow.operators` and standalone store access both work.

- [ ] **Step 6: Add focused in-memory tests, then rerun them with the conformance suite.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/storage/in-memory/__tests__/in-memory-operator-execution-store.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/tests test -- --run conformance/__tests__/conformance.cross-adapter.test.ts`
Expected: FAIL only for the Postgres adapter now.

- [ ] **Step 7: Commit the in-memory durability layer.**

```bash
git add tests/conformance/persistence/operator-execution.conformance.ts tests/conformance/run-conformance.ts tests/conformance/__tests__/conformance.cross-adapter.test.ts packages/adapters/src/storage/in-memory/in-memory-operator-execution-store.ts packages/adapters/src/storage/in-memory/__tests__/in-memory-operator-execution-store.test.ts packages/adapters/src/storage/in-memory/state.ts packages/adapters/src/storage/in-memory/index.ts packages/adapters/src/storage/in-memory/in-memory-unit-of-work.ts packages/adapters/src/index.ts
git commit -m "feat: add in-memory operator execution persistence"
```

### Task 4: Add the Postgres operator schema and store with parity against the in-memory contract

**Files:**
- Create: `packages/infrastructure/src/sql/postgres/migrations/0003_operator_execution_schema.sql`
- Create: `packages/infrastructure/src/sql/postgres/migrations/0004_operator_execution_indexes.sql`
- Create: `packages/infrastructure/src/postgres/pg-operator-execution-store.ts`
- Create: `packages/infrastructure/src/postgres/__tests__/pg-operator-execution-store.test.ts`
- Modify: `packages/infrastructure/src/postgres/pg-unit-of-work.ts`
- Modify: `packages/infrastructure/src/postgres/__tests__/postgres-test-harness.ts`
- Modify: `packages/infrastructure/src/index.ts`

- [ ] **Step 1: Write the failing Postgres store tests first.**

Create `pg-operator-execution-store.test.ts` with explicit coverage for:
- atomic run + task creation
- conditional claim behavior under concurrent clients
- lease-expired reclaim
- idempotent finalization-stage advancement
- unique `(conversation_id, idempotency_key)` behavior

- [ ] **Step 2: Run the Postgres store test to confirm the schema/store are missing.**

Run: `pnpm --filter @ledgermind/infrastructure test -- --run src/postgres/__tests__/pg-operator-execution-store.test.ts`
Expected: FAIL because the tables and adapter do not exist.

- [ ] **Step 3: Add the schema migration with the exact v1 fields from the spec.**

`0003_operator_execution_schema.sql` should create `operator_runs` and `operator_tasks` with fields for:
- run status, prompt/task prompt storage, output schema JSON, input/output artifact ids
- retry policy, concurrency limit, finalization flags/stage, parent handle timestamp, idempotency key, normalized input digest
- task attempt count, lease owner/expires, next retry time, last error JSON, child conversation id, bootstrap state, result JSON/artifact id

Use check constraints or enums where that improves integrity.

- [ ] **Step 4: Add indexes and implement the Postgres store with conditional updates.**

`0004_operator_execution_indexes.sql` should support:
- run lookup by `(conversation_id, idempotency_key)`
- claim queries by `status`, `next_retry_at`, and `lease_expires_at`
- finalization retry queries by `needs_finalization_retry` and run status
- ordered task listing by `(run_id, item_index)`

Then implement `pg-operator-execution-store.ts` using single-statement conditional updates or transactionally safe read/modify/write patterns for claims and finalization.

- [ ] **Step 5: Wire the store into the harness, unit of work, and infrastructure exports.**

Update `postgres-test-harness.ts`, `pg-unit-of-work.ts`, and `packages/infrastructure/src/index.ts` so Postgres conformance tests can access the new store and transactional UoW path.

- [ ] **Step 6: Re-run package tests and cross-adapter conformance.**

Run: `pnpm --filter @ledgermind/infrastructure test -- --run src/postgres/__tests__/pg-operator-execution-store.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/tests test -- --run conformance/__tests__/conformance.cross-adapter.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit the Postgres durability layer.**

```bash
git add packages/infrastructure/src/sql/postgres/migrations/0003_operator_execution_schema.sql packages/infrastructure/src/sql/postgres/migrations/0004_operator_execution_indexes.sql packages/infrastructure/src/postgres/pg-operator-execution-store.ts packages/infrastructure/src/postgres/__tests__/pg-operator-execution-store.test.ts packages/infrastructure/src/postgres/pg-unit-of-work.ts packages/infrastructure/src/postgres/__tests__/postgres-test-harness.ts packages/infrastructure/src/index.ts
git commit -m "feat: add postgres operator execution persistence"
```

---

## Chunk 3: `llmMap` Submission, Execution, Finalization, And SDK Wiring

### Task 5: Implement `LLMMapUseCase` and `GetOperatorRunUseCase`

**Files:**
- Create: `packages/application/src/use-cases/llm-map.ts`
- Create: `packages/application/src/use-cases/get-operator-run.ts`
- Create: `packages/application/src/use-cases/__tests__/llm-map.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/get-operator-run.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/application/src/use-cases/operators/shared/input-dataset.ts`

- [ ] **Step 1: Write failing tests for submit validation and inspection behavior.**

In `llm-map.test.ts`, cover:
- exactly one of `items` or `inputArtifactId`
- reject inline datasets over `maxInlineOperatorInputBytes`
- reject artifact-backed datasets when the artifact belongs to a different conversation
- reject artifact-backed datasets when the artifact content is not one JSON array payload
- zero-item submit finalizes immediately as `completed`, writes an empty output artifact, and creates no claimable tasks
- same `(conversationId, idempotencyKey)` with same normalized input returns the existing run id

In `get-operator-run.test.ts`, add coverage for task counts, inline result size ceiling, inline-results-under-budget behavior, and artifact-only output when over budget.

- [ ] **Step 2: Run the new tests to capture the missing implementation.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/llm-map.test.ts src/use-cases/__tests__/get-operator-run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement shared dataset loading and normalization before writing the use cases.**

Use `input-dataset.ts` to:
- validate inline arrays
- load artifact-backed datasets from the same conversation only
- canonicalize the submit payload for idempotency hashing using `serializeCanonicalJson`
- return a deterministic ordered item list for task creation

- [ ] **Step 4: Implement `LLMMapUseCase` as a submit-only durable API.**

`LLMMapUseCase` should:
- validate prompt/schema/concurrency/retry policy against `operator-config.ts`
- persist inline input as an artifact when inline items are supplied
- create the run + task batch atomically through `uow.operators`
- enqueue one queue wake-up hint per run or task batch after durable creation
- finalize zero-item runs immediately through the finalization path instead of inventing a separate shortcut state model

- [ ] **Step 5: Implement `GetOperatorRunUseCase` as inspection-only.**

It must:
- never synthesize finalization or mutate persistence
- report run/task statuses, attempts, child conversation ids, artifact ids, and terminal failure metadata
- inline ordered results only when the serialized payload is under `maxInlineRunResultsBytes`

- [ ] **Step 6: Re-run the application tests and typecheck.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/llm-map.test.ts src/use-cases/__tests__/get-operator-run.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/application typecheck`
Expected: PASS.

- [ ] **Step 7: Commit submit/inspect support for `llmMap`.**

```bash
git add packages/application/src/use-cases/llm-map.ts packages/application/src/use-cases/get-operator-run.ts packages/application/src/use-cases/__tests__/llm-map.test.ts packages/application/src/use-cases/__tests__/get-operator-run.test.ts packages/application/src/index.ts
git commit -m "feat: add llmMap submission and operator inspection use cases"
```

### Task 6: Implement `ExecuteOperatorTaskUseCase`, `FinalizeOperatorRunUseCase`, and SDK inline wiring for `llmMap`

**Files:**
- Create: `packages/application/src/use-cases/execute-operator-task.ts`
- Create: `packages/application/src/use-cases/finalize-operator-run.ts`
- Create: `packages/application/src/use-cases/__tests__/execute-operator-task.test.ts`
- Create: `packages/application/src/use-cases/__tests__/finalize-operator-run.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/index.test.ts`

- [ ] **Step 1: Write failing tests for retry, schema validation failure, and ordered finalization.**

Cover these paths:
- a structured-generation validation failure becomes `retryable_failure` until `maxRetries` is exhausted
- the final terminal failure row includes `error { code, message, retryable: false, attemptCount }`
- successful finalization writes one ordered JSONL row per input item
- finalization retries resume from `artifact_written` or `handle_appended` without duplicate writes

- [ ] **Step 2: Run the failing tests to confirm the execute/finalize paths are absent.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/execute-operator-task.test.ts src/use-cases/__tests__/finalize-operator-run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `ExecuteOperatorTaskUseCase` for the `llmMap` path first.**

It should:
- claim one task lease through `OperatorExecutionPort`
- load the item payload for that task
- call `StructuredGenerationPort` with prompt, item, schema, and timeout
- write success or retryable/terminal failure state conditionally
- attempt run finalization after every terminal task update

Do not add child-conversation logic yet; leave the `agenticMap` branch throwing or unimplemented until the next chunk.

- [ ] **Step 4: Implement `FinalizeOperatorRunUseCase` with durable stage checkpoints.**

It must:
- verify all tasks are terminal
- build ordered result entries by ascending `itemIndex`
- write the JSONL artifact once
- append one compact handle event to the parent conversation with a deterministic idempotency key
- advance `finalization_stage` through `not_started -> artifact_written -> handle_appended -> completed`

- [ ] **Step 5: Wire the new use cases into the SDK with explicit operator runtime config and inline mode.**

Update `packages/sdk/src/index.ts` so `createMemoryEngine()` accepts an `operators` config object with explicit override points for:
- `structuredGeneration`
- `subAgentExecutor`
- `delegationScopeResolver`
- queue port / execution mode (`inline` vs durable worker-backed submit-only)
- operator config overrides from `operator-config.ts`

`MemoryEngine.llmMap()` should always persist run/task state first; inline mode may immediately execute and finalize afterward using the same use cases.

- [ ] **Step 6: Re-run application + SDK tests.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/execute-operator-task.test.ts src/use-cases/__tests__/finalize-operator-run.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/sdk test -- --run src/index.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit the `llmMap` execution path.**

```bash
git add packages/application/src/use-cases/execute-operator-task.ts packages/application/src/use-cases/finalize-operator-run.ts packages/application/src/use-cases/__tests__/execute-operator-task.test.ts packages/application/src/use-cases/__tests__/finalize-operator-run.test.ts packages/sdk/src/index.ts packages/sdk/src/index.test.ts
git commit -m "feat: execute and finalize llmMap operator runs"
```

---

## Chunk 4: `agenticMap`, Delegation Safety, And Child-Lineage Hardening

### Task 7: Implement `AgenticMapUseCase` with delegated-scope validation and durable child bootstrap state

**Files:**
- Create: `packages/application/src/use-cases/agentic-map.ts`
- Create: `packages/application/src/use-cases/__tests__/agentic-map.test.ts`
- Create: `packages/application/src/use-cases/__tests__/operator-test-doubles.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/application/src/use-cases/operators/shared/input-dataset.ts`

- [ ] **Step 1: Write failing tests for `agenticMap` submit validation and child bootstrap metadata.**

`agentic-map.test.ts` should cover:
- reject missing `delegated_scope`
- reject missing or oversized `kept_work.description`
- reject recursive child-originated delegation when either `delegated_scope` or `kept_work` is missing
- reject artifact-backed datasets when the artifact belongs to a different conversation or is not one JSON array payload
- zero-item submit completes immediately without creating child conversations and still writes an empty output artifact
- successful submit persists task rows that start in `bootstrap_not_started`

- [ ] **Step 2: Run the failing test.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/agentic-map.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add deterministic operator test doubles for runtime ports.**

Create `operator-test-doubles.ts` with focused doubles for:
- `StructuredGenerationPort`
- `SubAgentExecutorPort`
- `DelegationScopeResolverPort`
- `OperatorExecutionPort`

Reuse these in all operator use-case tests instead of open-coded one-off mocks.

- [ ] **Step 4: Implement `AgenticMapUseCase` with the exact v1 submit semantics.**

It should:
- validate `taskPrompt`, output schema, delegated scope, kept work, concurrency, and retry policy
- persist inline datasets as artifacts when needed
- hash `delegated_scope` + `kept_work` into idempotency normalization
- create durable runs/tasks with `bootstrap_state = bootstrap_not_started`
- enqueue wake-up hints without waiting for completion

- [ ] **Step 5: Ensure the use case records enough metadata for later child bootstrap/reuse.**

Persist or derive everything the execution path will need later: `taskPrompt`, delegated scope snapshot input, kept-work summary, output schema, timeout/retry config, and deterministic parent-handle identifiers.

- [ ] **Step 6: Re-run the new test and typecheck.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/agentic-map.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/application typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the durable `agenticMap` submit path.**

```bash
git add packages/application/src/use-cases/agentic-map.ts packages/application/src/use-cases/__tests__/agentic-map.test.ts packages/application/src/use-cases/__tests__/operator-test-doubles.ts packages/application/src/index.ts
git commit -m "feat: add agenticMap submission use case"
```

### Task 8: Implement child conversation bootstrap/reuse and harden `expand()` to actual child lineage only

**Files:**
- Modify: `packages/application/src/use-cases/execute-operator-task.ts`
- Modify: `packages/application/src/use-cases/finalize-operator-run.ts`
- Modify: `packages/application/src/use-cases/__tests__/execute-operator-task.test.ts`
- Modify: `packages/application/src/ports/driven/auth/authorization.port.ts`
- Modify: `packages/application/src/use-cases/expand.ts`
- Modify: `packages/application/src/use-cases/__tests__/expand.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/retrieval-test-doubles.ts`
- Modify: `packages/adapters/src/auth/sub-agent-authorization.adapter.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Extend the execute-task tests to cover `agenticMap` child behavior before implementation.**

Add test cases for:
- first attempt creates one child conversation and marks `bootstrap_in_progress` then `bootstrap_completed`
- retry after a crash before bootstrap completion reuses the same `childConversationId`
- child execution does not start until bootstrap is marked complete
- final result rows for `agenticMap` include `childConversationId`

- [ ] **Step 2: Add a failing `expand()` lineage test.**

Update `expand.test.ts` to assert that `isSubAgent: true` is not sufficient; the caller conversation must be an actual child conversation in storage, and its stored `parentId` must match the caller context’s `parentConversationId`.

- [ ] **Step 3: Run the affected tests to capture the missing lineage/bootstrap implementation.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/execute-operator-task.test.ts src/use-cases/__tests__/expand.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the `agenticMap` branch in `ExecuteOperatorTaskUseCase`.**

It should:
- create or reuse a child conversation keyed by task id
- call `DelegationScopeResolverPort` once per task/bootstrap cycle
- append system/task/scope bootstrap events idempotently to the child conversation
- persist `bootstrap_state` transitions durably
- call `SubAgentExecutorPort` only after bootstrap completes
- validate the final structured child output against the declared schema and record success/failure

- [ ] **Step 5: Harden `expand()` with real lineage verification.**

Keep `AuthorizationPort` policy-oriented and move lineage lookup into `ExpandUseCase`. Then:
- inject `ConversationPort` into `ExpandUseCase`
- load the caller conversation from storage
- reject when the caller conversation is missing or root-only
- require the stored `parentId` to equal `callerContext.parentConversationId`
- keep the summary lookup conversation-local as it is today
- update SDK wiring and test doubles to satisfy the new constructor signature

- [ ] **Step 6: Re-run the execute/expand tests and the agentic submit tests.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/agentic-map.test.ts src/use-cases/__tests__/execute-operator-task.test.ts src/use-cases/__tests__/expand.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit child bootstrap/reuse and lineage hardening.**

```bash
git add packages/application/src/use-cases/execute-operator-task.ts packages/application/src/use-cases/finalize-operator-run.ts packages/application/src/use-cases/__tests__/execute-operator-task.test.ts packages/application/src/ports/driven/auth/authorization.port.ts packages/application/src/use-cases/expand.ts packages/adapters/src/auth/sub-agent-authorization.adapter.ts packages/application/src/use-cases/__tests__/expand.test.ts
git commit -m "feat: execute agenticMap tasks with child lineage safeguards"
```

---

## Chunk 5: Queue Wake-Ups, Polling-First Worker App, And Crash-Recovery Tests

### Task 9: Extend `JobQueuePort` for wake-up hints and update the in-memory queue adapter

**Files:**
- Modify: `packages/application/src/ports/driven/jobs/job-queue.port.ts`
- Modify: `packages/application/src/use-cases/append-ledger-events.ts`
- Modify: `packages/application/src/use-cases/__tests__/append-ledger-events.test.ts`
- Modify: `packages/adapters/src/jobs/in-memory-job-queue.adapter.ts`
- Modify: `packages/adapters/src/jobs/__tests__/in-memory-job-queue.adapter.test.ts`
- Modify: `packages/application/src/index.ts`

- [ ] **Step 1: Write failing queue-adapter tests for subscription-based wake-ups.**

In `in-memory-job-queue.adapter.test.ts`, replace the current completion-callback assertions with tests that verify:
- subscribers receive enqueued jobs in order
- duplicate subscribers each observe the same wake-up hint
- unsubscribing stops future deliveries

- [ ] **Step 2: Run the adapter test to confirm the contract mismatch.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/jobs/__tests__/in-memory-job-queue.adapter.test.ts`
Expected: FAIL because `onComplete()` still defines the old API.

- [ ] **Step 3: Replace the queue port contract with a worker-usable wake-up interface.**

Update `job-queue.port.ts` to keep `enqueue()` and replace `onComplete()` with something like:
- `subscribe(type, handler): Promise<{ close(): Promise<void> | void }>`

Keep the interface minimal and aligned with the spec: queue correctness remains optional; DB polling remains authoritative.

- [ ] **Step 4: Update the in-memory queue adapter and any existing test doubles.**

`AppendLedgerEventsUseCase` should keep working with `enqueue()` only; update its tests/test-double to satisfy the new interface without changing compaction behavior.

- [ ] **Step 5: Re-run the adapters and application tests that depend on the queue contract.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/jobs/__tests__/in-memory-job-queue.adapter.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/append-ledger-events.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck affected packages.**

Run: `pnpm --filter @ledgermind/application typecheck && pnpm --filter @ledgermind/adapters typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the queue wake-up contract update.**

```bash
git add packages/application/src/ports/driven/jobs/job-queue.port.ts packages/application/src/use-cases/append-ledger-events.ts packages/application/src/use-cases/__tests__/append-ledger-events.test.ts packages/adapters/src/jobs/in-memory-job-queue.adapter.ts packages/adapters/src/jobs/__tests__/in-memory-job-queue.adapter.test.ts packages/application/src/index.ts
git commit -m "feat: add queue wake-up subscriptions for workers"
```

### Task 10: Create the polling-first worker app and wire it to the operator use cases

**Files:**
- Create: `apps/operator-worker/package.json`
- Create: `apps/operator-worker/tsconfig.json`
- Create: `apps/operator-worker/src/index.ts`
- Create: `apps/operator-worker/src/cli.ts`
- Create: `apps/operator-worker/src/config.ts`
- Create: `apps/operator-worker/src/poll-loop.ts`
- Create: `apps/operator-worker/src/worker.ts`
- Create: `apps/operator-worker/src/logging.ts`
- Create: `apps/operator-worker/src/__tests__/config.test.ts`
- Create: `apps/operator-worker/src/__tests__/poll-loop.test.ts`
- Create: `apps/operator-worker/src/__tests__/worker.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Scaffold the worker package and add root scripts before implementing logic.**

Use the same workspace conventions as the other packages. Add root scripts such as:
- `worker:operator`
- `worker:operator:test`

Prefer `tsx src/cli.ts` for the app’s start/dev script.

- [ ] **Step 2: Write the failing worker config and polling-loop tests first.**

`config.test.ts` should assert parsing of poll interval, batch size, worker id, and DB connection string, plus actionable failure when required runtime executors are missing for durable operator execution.

`poll-loop.test.ts` should assert that one poll iteration:
- claims claimable tasks first
- also processes runs flagged for finalization retry
- respects concurrency limits by relying on the store’s claim result instead of local counters
- wakes early on queue hints but remains correct when no queue subscription exists

- [ ] **Step 3: Run the new app tests to confirm missing implementation.**

Run: `pnpm --filter @ledgermind/operator-worker test -- --run src/__tests__/config.test.ts src/__tests__/poll-loop.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the worker composition root and polling loop.**

`worker.ts` and `poll-loop.ts` should:
- build `ExecuteOperatorTaskUseCase` and `FinalizeOperatorRunUseCase` from SDK/application/infrastructure dependencies
- poll for both claimable tasks and runs needing finalization retry
- execute one claimed work item at a time
- optionally subscribe to queue wake-up hints to shorten sleep, without relying on them for correctness
- honor graceful shutdown by stopping new claims and letting in-flight work finish within the lease window

- [ ] **Step 5: Add structured logging and CLI startup.**

`logging.ts` should emit run/task ids, attempt numbers, lease owner, and finalization stage. `cli.ts` should parse config, start the loop, and handle SIGINT/SIGTERM cleanly.

- [ ] **Step 6: Re-run app tests and typecheck.**

Run: `pnpm --filter @ledgermind/operator-worker test -- --run src/__tests__/config.test.ts src/__tests__/poll-loop.test.ts src/__tests__/worker.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/operator-worker typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the worker app scaffold and polling loop.**

```bash
git add apps/operator-worker package.json tsconfig.json
git commit -m "feat: add polling-first operator worker app"
```

### Task 11: Add crash-recovery and duplicate-delivery regression coverage

**Files:**
- Create: `tests/regression/operator-recursion.e2e.test.ts`
- Create: `tests/regression/operator-worker.e2e.test.ts`
- Modify: `tests/package.json`
- Modify: `tests/vitest.config.ts`

- [ ] **Step 1: Write the regression tests before broadening the runtime surface further.**

`operator-recursion.e2e.test.ts` should cover:
- root conversation submits `agenticMap`
- child conversations execute and may recursively delegate
- finalized JSONL output is ordered by `itemIndex`
- parent receives a compact handle rather than inline full outputs

`operator-worker.e2e.test.ts` should cover:
- duplicate queue delivery is harmless
- worker crash after child creation but before bootstrap completion reuses the same child on the next attempt
- lease expiry lets another worker recover and finish the task
- finalization retry after partial success resumes from the persisted stage

- [ ] **Step 2: Run the regression tests to verify the current gaps.**

Run: `pnpm --filter @ledgermind/tests test -- --run regression/operator-recursion.e2e.test.ts regression/operator-worker.e2e.test.ts`
Expected: FAIL.

- [ ] **Step 3: Fill the missing runtime wiring uncovered by the regressions.**

This is the point to fix any remaining gaps in:
- SDK operator config defaults
- queue wake-up integration into the worker app
- Postgres/in-memory parity bugs in lease expiry, bootstrap state, or finalization stage persistence

Keep fixes minimal and driven entirely by the failing tests.

- [ ] **Step 4: Re-run the new regressions and the conformance suite.**

Run: `pnpm --filter @ledgermind/tests test -- --run regression/operator-recursion.e2e.test.ts regression/operator-worker.e2e.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/tests test -- --run conformance/__tests__/conformance.cross-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Add focused test scripts if the commands are now part of the expected workflow.**

Update `tests/package.json` with scripts such as `test:operator:conformance` and `test:operator:regression` only if they genuinely improve the repo workflow.

- [ ] **Step 6: Typecheck the tests package.**

Run: `pnpm --filter @ledgermind/tests typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the regression coverage.**

```bash
git add tests/regression/operator-recursion.e2e.test.ts tests/regression/operator-worker.e2e.test.ts tests/package.json tests/vitest.config.ts
git commit -m "test: add operator recursion and worker recovery regressions"
```

---

## Chunk 6: Tool Surface, Documentation, And Final Verification

### Task 12: Expose recursion operators through the Vercel tool adapter with runtime-bound caller context

**Files:**
- Modify: `packages/application/src/ports/driving/tool-provider.port.ts`
- Modify: `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts`
- Modify: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts`
- Modify: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts`
- Modify: `packages/adapters/src/tools/index.ts`
- Create: `tests/regression/operator-tool-surface.test.ts`

- [ ] **Step 1: Write the failing tool-surface integration test first.**

Create `tests/regression/operator-tool-surface.test.ts` that asserts:
- `memory.grep`, `memory.expand`, `memory.llmMap`, `memory.agenticMap`, and `memory.getOperatorRun` derive `conversationId` from runtime-bound caller context rather than user payloads
- oversized inline datasets are rejected with a tool-safe validation envelope
- operator tools return run ids / artifact ids / compact summaries rather than dumping full result sets into context

- [ ] **Step 2: Run the tool-surface test to confirm the current adapter contract is too permissive.**

Run: `pnpm --filter @ledgermind/tests test -- --run regression/operator-tool-surface.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor the Vercel adapter signature to require runtime caller context injection.**

Update `createVercelMemoryTools()` / `createVercelTools()` so callers pass runtime context accessors such as:
- `getCallerContext(): CallerContext`
- optionally operator payload ceilings or engine/tool config overrides

If that changes the generic tool-provider factory shape, update `packages/application/src/ports/driving/tool-provider.port.ts` in the same slice so the repo has one consistent contract.

Then remove model-controlled `conversationId` / `callerContext` from tool schemas for the tools that must stay conversation-bound.

- [ ] **Step 4: Add the recursion tools with compact-result semantics.**

Expose:
- `memory.llmMap`
- `memory.agenticMap`
- `memory.getOperatorRun`

The execution wrappers should call the new engine methods, derive tool-safe provenance references from output artifact ids / child conversation ids / run ids, and avoid inlining full result bodies when the spec says to return handles only.

- [ ] **Step 5: Re-run the new regression plus existing adapter tests.**

Run: `pnpm --filter @ledgermind/tests test -- --run regression/operator-tool-surface.test.ts`
Expected: PASS.

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck adapters and tests.**

Run: `pnpm --filter @ledgermind/adapters typecheck && pnpm --filter @ledgermind/tests typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the runtime-bound tool surface.**

```bash
git add packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts packages/adapters/src/tools/index.ts tests/regression/operator-tool-surface.test.ts
git commit -m "feat: expose durable recursion tools with runtime-bound context"
```

### Task 13: Document durable operators, worker startup, and verification workflow

**Files:**
- Create: `docs/operator-level-recursion.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `docs/high-level-design.md`

- [ ] **Step 1: Write the operator documentation once the API and worker surface are stable.**

`docs/operator-level-recursion.md` should document:
- `llmMap()`, `agenticMap()`, and `getOperatorRun()` inputs/outputs
- zero-item behavior
- delegated scope and kept-work rules
- child bootstrap/reuse semantics
- worker startup commands and the difference between inline mode and worker-backed durable mode
- known limitations explicitly left out of v1 (no cancellation, no generic workflow engine)

- [ ] **Step 2: Add concise README entry points, root scripts, and architecture-doc sync.**

Update `README.md` with a short “Durable Operators” section that points to the new doc and shows the minimal local workflow:
1. create/choose a conversation
2. call `llmMap()` / `agenticMap()`
3. start `worker:operator`
4. inspect status with `getOperatorRun()`

If the root `package.json` does not already expose the worker commands added in Task 10, add them now. If the implemented queue wake-up contract or worker architecture changes the repo’s public architectural story, update `docs/high-level-design.md` in the same slice so it does not drift from the code.

- [ ] **Step 3: Run documentation-adjacent smoke checks.**

Run any documented commands that are safe and copy-pasteable, for example:
- `pnpm --filter @ledgermind/operator-worker test -- --run src/__tests__/config.test.ts`
- `pnpm --filter @ledgermind/sdk test -- --run src/index.test.ts`

Expected: PASS.

- [ ] **Step 4: Run the focused operator quality gates before the full repo sweep.**

Run:
- `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/llm-map.test.ts src/use-cases/__tests__/agentic-map.test.ts src/use-cases/__tests__/execute-operator-task.test.ts src/use-cases/__tests__/finalize-operator-run.test.ts src/use-cases/__tests__/get-operator-run.test.ts`
- `pnpm --filter @ledgermind/infrastructure test -- --run src/postgres/__tests__/pg-operator-execution-store.test.ts`
- `pnpm --filter @ledgermind/tests test -- --run conformance/__tests__/conformance.cross-adapter.test.ts regression/operator-recursion.e2e.test.ts regression/operator-worker.e2e.test.ts regression/operator-tool-surface.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full repo quality gates.**

Run:
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

Expected: PASS.

- [ ] **Step 6: Request review before landing.**

Use `@requesting-code-review` or the repo’s preferred review workflow after the focused and full quality gates pass, and include the operator-specific test evidence and worker smoke evidence.

- [ ] **Step 7: Commit docs and final wiring.**

```bash
git add docs/operator-level-recursion.md README.md package.json
git commit -m "docs: add durable operator execution guide"
```

---

## Final Verification Checklist

Before claiming the implementation is complete, verify all of the following with real output:

- [ ] `MemoryEngine` exposes `llmMap`, `agenticMap`, and `getOperatorRun` from `@ledgermind/application` and `@ledgermind/sdk`.
- [ ] In-memory and Postgres `OperatorExecutionPort` adapters both pass the same conformance suite.
- [ ] `llmMap` retries schema/structured-output failures correctly, rejects invalid artifact-backed datasets, and finalizes ordered JSONL output.
- [ ] `agenticMap` reuses one child conversation per task across retries, enforces `delegated_scope` + `kept_work`, and persists bootstrap state transitions.
- [ ] `expand()` is restricted to actual child conversations, not spoofed raw payloads.
- [ ] Worker polling recovers from duplicate delivery, lease expiry, and partial finalization.
- [ ] Tool adapters bind caller context from runtime code, not model-controlled payloads.
- [ ] Parent contexts receive compact handles; large inputs/outputs live in artifacts.

## Suggested Execution Order

1. Chunk 1 — lock public contracts and application boundaries.
2. Chunk 2 — make durable persistence real and cross-adapter testable.
3. Chunk 3 — ship full `llmMap` submit/execute/finalize/inspect.
4. Chunk 4 — add `agenticMap` child bootstrap/reuse and lineage hardening.
5. Chunk 5 — add the worker app and crash-recovery coverage.
6. Chunk 6 — expose tools, update docs, and run full verification.
