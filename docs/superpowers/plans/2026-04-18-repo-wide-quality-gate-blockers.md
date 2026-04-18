# Repo-Wide Quality Gate Blockers Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the remaining repo-wide quality-gate blockers so `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass after the durable operator-recursion implementation landed.

**Architecture:** Keep this as a compatibility-and-hygiene follow-up, not a feature expansion. Fix only the verified breakages: benchmark runtime drift caused by the expanded `MemoryEngine`/`ExpandUseCase` contract, existing application test lint violations, and benchmark test-resolution wiring so Vitest resolves workspace packages consistently.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspaces, Vitest, ESLint, strict ESM, existing LedgerMind clean-architecture packages.

---

## Scope And Root Causes

Verified from fresh repo commands:

- `pnpm typecheck` fails in `benchmarks/longmemeval/src/ledgermind-runtime.ts` because `ExpandUseCase` now requires `conversations`, and the locally constructed `MemoryEngine` no longer satisfies the public interface after `llmMap`, `agenticMap`, and `getOperatorRun` were added.
- `pnpm lint` fails in `packages/application/src/use-cases/__tests__/*` due to existing unused locals/imports left in operator test files.
- `pnpm test` fails in `benchmarks/longmemeval` because Vitest cannot resolve `@ledgermind/application` from that package; unlike `tests/vitest.config.ts`, the benchmark package has no alias wiring.

Non-goals:

- No behavior changes to operator execution itself.
- No benchmark feature redesign.
- No opportunistic refactors outside the failing surfaces.

---

## File Structure

### Existing Files To Modify

- `benchmarks/longmemeval/src/ledgermind-runtime.ts` - update runtime construction for the current `ExpandUseCaseDeps` and `MemoryEngine` contract.
- `benchmarks/longmemeval/package.json` - add any minimal test/config dependency needed for Vitest path resolution if required.
- `benchmarks/longmemeval/tsconfig.json` - keep as reference; only touch if alias support truly requires it.
- `packages/application/src/use-cases/__tests__/agentic-map.test.ts` - remove unused destructured `_items` locals.
- `packages/application/src/use-cases/__tests__/execute-operator-task.test.ts` - remove unused `createArtifact` import.
- `packages/application/src/use-cases/__tests__/finalize-operator-run.test.ts` - remove unused imports/types.
- `packages/application/src/use-cases/__tests__/get-operator-run.test.ts` - remove unused `_outputArtifactId` destructure.
- `packages/application/src/use-cases/__tests__/operator-test-doubles.ts` - remove unused `createDefaultConversationConfig` helper or make it used.

### New Files To Create

- `benchmarks/longmemeval/vitest.config.ts` - benchmark-local Vitest alias config mirroring the workspace package aliases needed by the benchmark tests.

---

## Chunk 1: Benchmark Runtime Contract Compatibility

### Task 1: Restore `benchmarks/longmemeval` compatibility with the current application/sdk public surface

**Files:**
- Modify: `benchmarks/longmemeval/src/ledgermind-runtime.ts`
- Test: `benchmarks/longmemeval/src/ledgermind-runtime.test.ts`

- [ ] **Step 1: Write or extend a failing benchmark runtime test for the current contract.**

Add/adjust a test in `benchmarks/longmemeval/src/ledgermind-runtime.test.ts` that proves the created runtime exposes a full `MemoryEngine` shape expected by the benchmark harness and that runtime construction still works when `ExpandUseCase` requires the conversation store.

- [ ] **Step 2: Run the focused benchmark runtime test to lock the failure.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/ledgermind-runtime.test.ts`
Expected: FAIL because the benchmark runtime is stale relative to the current contracts.

- [ ] **Step 3: Update the benchmark runtime wiring with the minimal compatibility fix.**

In `benchmarks/longmemeval/src/ledgermind-runtime.ts`:
- pass `conversations: deps.conversations` into `new ExpandUseCase(...)`
- add minimal `llmMap`, `agenticMap`, and `getOperatorRun` functions on the returned `MemoryEngine`
- make those operator methods fail fast with clear benchmark-local errors rather than trying to implement durable operators inside the benchmark runtime
- keep the benchmark runtime focused on the existing benchmark use cases only

- [ ] **Step 4: Re-run the focused benchmark runtime test.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/ledgermind-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run benchmark package typecheck.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the benchmark contract compatibility fix.**

```bash
git add benchmarks/longmemeval/src/ledgermind-runtime.ts benchmarks/longmemeval/src/ledgermind-runtime.test.ts
git commit -m "fix: align longmemeval runtime with memory engine contract"
```

---

## Chunk 2: Application Test Lint Hygiene

### Task 2: Remove existing unused-symbol lint failures from application operator tests

**Files:**
- Modify: `packages/application/src/use-cases/__tests__/agentic-map.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/execute-operator-task.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/finalize-operator-run.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/get-operator-run.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/operator-test-doubles.ts`

- [ ] **Step 1: Confirm the current lint failure set exactly matches the known unused-symbol issues.**

Run: `pnpm --filter @ledgermind/application lint`
Expected: FAIL with the existing unused-vars/import errors only.

- [ ] **Step 2: Remove the unused locals/imports with the smallest diff.**

Apply only these hygiene fixes:
- replace destructuring patterns that bind unused `_items` / `_outputArtifactId` with omission patterns that do not create unused bindings
- delete unused imports/types like `createArtifact`, `createLedgerEvent`, and `EventId`
- remove the unused `createDefaultConversationConfig` helper if it is truly dead

Do not rewrite test structure or assertions.

- [ ] **Step 3: Re-run focused application tests touched by the lint cleanup.**

Run: `pnpm --filter @ledgermind/application test -- --run src/use-cases/__tests__/agentic-map.test.ts src/use-cases/__tests__/execute-operator-task.test.ts src/use-cases/__tests__/finalize-operator-run.test.ts src/use-cases/__tests__/get-operator-run.test.ts`
Expected: PASS.

- [ ] **Step 4: Re-run application lint.**

Run: `pnpm --filter @ledgermind/application lint`
Expected: PASS.

- [ ] **Step 5: Commit the lint cleanup.**

```bash
git add packages/application/src/use-cases/__tests__/agentic-map.test.ts packages/application/src/use-cases/__tests__/execute-operator-task.test.ts packages/application/src/use-cases/__tests__/finalize-operator-run.test.ts packages/application/src/use-cases/__tests__/get-operator-run.test.ts packages/application/src/use-cases/__tests__/operator-test-doubles.ts
git commit -m "test: remove unused symbols from operator tests"
```

---

## Chunk 3: Benchmark Vitest Workspace Resolution

### Task 3: Make `benchmarks/longmemeval` tests resolve workspace packages under Vitest

**Files:**
- Create: `benchmarks/longmemeval/vitest.config.ts`
- Modify: `benchmarks/longmemeval/package.json`
- Test: `benchmarks/longmemeval/src/baselines.test.ts`
- Test: `benchmarks/longmemeval/src/runner.test.ts`
- Test: `benchmarks/longmemeval/src/ledgermind-runtime.test.ts`

- [ ] **Step 1: Add a focused failing test invocation that reproduces the package-resolution issue.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/baselines.test.ts src/runner.test.ts src/ledgermind-runtime.test.ts`
Expected: FAIL with Vitest unable to resolve `@ledgermind/application` from `src/ledgermind-runtime.ts`.

- [ ] **Step 2: Add benchmark-local Vitest alias configuration.**

Create `benchmarks/longmemeval/vitest.config.ts` mirroring the alias style already used in `tests/vitest.config.ts` for:
- `@ledgermind/domain`
- `@ledgermind/application`
- `@ledgermind/adapters`
- `@ledgermind/infrastructure`

Only add aliases the benchmark package actually needs.

- [ ] **Step 3: Update benchmark package scripts only if needed to pick up the config explicitly.**

If plain `vitest run --passWithNoTests` does not auto-detect the new config in this package, update `benchmarks/longmemeval/package.json` minimally so the test script uses it. Do not change unrelated scripts.

- [ ] **Step 4: Re-run the focused benchmark tests.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/baselines.test.ts src/runner.test.ts src/ledgermind-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run the full benchmark package test suite.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test`
Expected: PASS.

- [ ] **Step 6: Commit the benchmark Vitest wiring fix.**

```bash
git add benchmarks/longmemeval/vitest.config.ts benchmarks/longmemeval/package.json
git commit -m "test: wire vitest aliases for longmemeval workspace deps"
```

---

## Chunk 4: Repo-Wide Verification

### Task 4: Re-run full repo quality gates and close the plan blocker

**Files:**
- No functional code changes required unless verification uncovers one last narrow blocker.

- [ ] **Step 1: Re-run the previously failing focused commands first.**

Run:
- `pnpm --filter @ledgermind/benchmark-longmemeval typecheck`
- `pnpm --filter @ledgermind/application lint`
- `pnpm --filter @ledgermind/benchmark-longmemeval test`

Expected: PASS.

- [ ] **Step 2: Re-run repo-wide typecheck.**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Re-run repo-wide lint.**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Re-run repo-wide test.**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Re-check the original operator plan completion criteria.**

Verify that `docs/superpowers/plans/2026-04-13-operator-level-recursion-implementation.md` is now blocked by nothing repo-wide and that Task 13 Step 5 is satisfied by fresh command output.

- [ ] **Step 6: Request review with fresh verification evidence.**

Use the repo’s preferred review workflow and include the exact fresh outputs for:
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- any benchmark-focused verification used to clear the blockers

- [ ] **Step 7: Commit final verification-only follow-up if any files changed in this chunk.**

```bash
git add <only-if-needed>
git commit -m "chore: clear repo-wide quality gate blockers"
```

---

## Final Verification Checklist

Before claiming the original operator-recursion plan is fully complete, verify all of the following with real output:

- [ ] `benchmarks/longmemeval` typechecks against the current `ExpandUseCase` and `MemoryEngine` contract.
- [ ] Application package lint passes without unused-symbol failures in operator tests.
- [ ] `benchmarks/longmemeval` Vitest resolves workspace packages successfully.
- [ ] `pnpm typecheck` passes repo-wide.
- [ ] `pnpm lint` passes repo-wide.
- [ ] `pnpm test` passes repo-wide.
- [ ] The original operator implementation evidence remains valid and no operator-specific regression was introduced.
