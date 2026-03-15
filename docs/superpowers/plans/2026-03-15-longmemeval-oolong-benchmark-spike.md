# LongMemEval And OOLONG Benchmark Spike Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight, oracle-backed benchmark spike that evaluates LedgerMind on LongMemEval first and OOLONG second, with artifacts strong enough to decide whether either suite deserves first-class harness support.

**Architecture:** Copy the LOCOMO harness package shape into suite-local benchmark packages, then adapt dataset loading, scoring, prompts, baselines, and reporting inside each package instead of extracting a shared benchmark core. LongMemEval is the primary spike and must center retrieval diagnostics that separate evidence reachability from answer synthesis; OOLONG is a thinner follow-on focused on score, prompt size, latency, and cost.

**Tech Stack:** TypeScript, `tsx`, `vitest`, workspace packages `@ledgermind/adapters`, `@ledgermind/application`, `@ledgermind/domain`, `@ledgermind/infrastructure`, benchmark package patterns from `benchmarks/locomo`, and the approved design in `docs/superpowers/specs/2026-03-15-longmemeval-oolong-benchmark-spike-design.md`.

---

## File Structure

### LongMemEval Package

- `benchmarks/longmemeval/package.json` - package metadata and benchmark scripts.
- `benchmarks/longmemeval/tsconfig.json` - package TypeScript build settings copied from the LOCOMO benchmark package.
- `benchmarks/longmemeval/README.md` - operator guide, fairness contract, and artifact documentation.
- `benchmarks/longmemeval/config/smoke-example-ids.json` - pinned smoke subset ids.
- `benchmarks/longmemeval/config/canary-example-ids.json` - pinned canary subset ids.
- `benchmarks/longmemeval/data/official/dataset.jsonl` - canonical local placement for the official LongMemEval dataset export; keep the raw asset out of source control if licensing requires it.
- `benchmarks/longmemeval/vendor/official-scorer/evaluate.py` - canonical LongMemEval scorer entry point used by `src/config.ts` and `src/scorer.ts`.
- `benchmarks/longmemeval/src/types.ts` - suite-local types for dataset records, run outputs, traces, and baseline names.
- `benchmarks/longmemeval/src/utils.ts` - suite-local helpers for hashing, token estimation, stable JSON, and formatting.
- `benchmarks/longmemeval/src/prompts.ts` - answer prompts and any suite-specific system instructions.
- `benchmarks/longmemeval/src/dataset.ts` - dataset normalization from official LongMemEval assets into local benchmark examples.
- `benchmarks/longmemeval/src/scorer.ts` - scorer wrapper and normalization logic.
- `benchmarks/longmemeval/src/config.ts` - CLI parsing, fairness fingerprint construction, subset selection, and run configuration.
- `benchmarks/longmemeval/src/ledgermind-runtime.ts` - in-memory LedgerMind runtime assembly for LongMemEval histories.
- `benchmarks/longmemeval/src/baselines.ts` - `full_history_upper_bound`, `ledgermind_static_materialize`, and `ledgermind_agentic_loop` implementations.
- `benchmarks/longmemeval/src/report.ts` - writes `summary.md`, `per_example.jsonl`, `trace_per_example.jsonl`, and `config_snapshot.json`.
- `benchmarks/longmemeval/src/runner.ts` - benchmark orchestration.
- `benchmarks/longmemeval/src/cli.ts` - executable entry point.
- `benchmarks/longmemeval/src/index.ts` - package export surface.
- `benchmarks/longmemeval/src/config.test.ts` - CLI/config regression tests.
- `benchmarks/longmemeval/src/dataset.test.ts` - dataset normalization tests.
- `benchmarks/longmemeval/src/scorer.test.ts` - scorer wrapper tests.
- `benchmarks/longmemeval/src/report.test.ts` - artifact writer tests.
- `benchmarks/longmemeval/src/runner.test.ts` - orchestration and trace tests.
- `benchmarks/longmemeval/src/ledgermind-runtime.test.ts` - runtime ingestion and metadata preservation tests.
- `benchmarks/longmemeval/src/baselines.test.ts` - baseline behavior and failure-classification tests.

### OOLONG Package

- `benchmarks/oolong/package.json` - package metadata and scripts.
- `benchmarks/oolong/tsconfig.json` - package TypeScript build settings.
- `benchmarks/oolong/README.md` - thinner benchmark operator guide.
- `benchmarks/oolong/config/smoke-example-ids.json` - pinned OOLONG smoke subset ids.
- `benchmarks/oolong/data/official/dataset.jsonl` - canonical local placement for the official OOLONG dataset export.
- `benchmarks/oolong/vendor/official-scorer/evaluate.py` - canonical OOLONG scorer entry point used by the OOLONG package config and scorer wrapper.
- `benchmarks/oolong/src/types.ts` - suite-local OOLONG types.
- `benchmarks/oolong/src/utils.ts` - hashing and formatting helpers.
- `benchmarks/oolong/src/prompts.ts` - OOLONG answer prompt definitions.
- `benchmarks/oolong/src/dataset.ts` - dataset normalization.
- `benchmarks/oolong/src/scorer.ts` - scorer wrapper.
- `benchmarks/oolong/src/config.ts` - CLI parsing and run configuration.
- `benchmarks/oolong/src/ledgermind-runtime.ts` - runtime assembly for OOLONG.
- `benchmarks/oolong/src/baselines.ts` - thin baseline set.
- `benchmarks/oolong/src/report.ts` - artifact writers.
- `benchmarks/oolong/src/runner.ts` - orchestration.
- `benchmarks/oolong/src/cli.ts` - executable entry point.
- `benchmarks/oolong/src/index.ts` - package export surface.
- `benchmarks/oolong/src/config.test.ts` - config tests.
- `benchmarks/oolong/src/report.test.ts` - report tests.
- `benchmarks/oolong/src/runner.test.ts` - orchestration tests.

### Shared Repo Touchpoints

- Modify `package.json` - add root scripts for LongMemEval and OOLONG benchmark commands.
- Modify `tests/package.json` - add quality smoke scripts for new benchmark suites if smoke tests are added.
- Create `tests/quality/__tests__/longmemeval-smoke.test.ts` - quality gate for LongMemEval smoke artifacts and parity/upper-bound labeling.
- Create `tests/quality/__tests__/oolong-smoke.test.ts` only if the OOLONG spike proves stable enough to justify a smoke contract in the same implementation cycle.

## Chunk 1: LongMemEval Scaffold And Dataset Contract

### Task 1: Add LongMemEval package scaffold

**Files:**
- Create: `benchmarks/longmemeval/package.json`
- Create: `benchmarks/longmemeval/tsconfig.json`
- Create: `benchmarks/longmemeval/README.md`
- Create: `benchmarks/longmemeval/src/index.ts`
- Create: `benchmarks/longmemeval/src/config.ts`
- Create: `benchmarks/longmemeval/src/config.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Copy the LOCOMO package shape into a new LongMemEval package skeleton.**

Create `benchmarks/longmemeval` with the same top-level files that exist in `benchmarks/locomo`, but use the package name `@ledgermind/benchmark-longmemeval` and script names `benchmark`, `benchmark:smoke`, and `benchmark:canary`.

- [ ] **Step 2: Add root script entry points before any feature logic.**

Modify `package.json` to add `benchmark:longmemeval` and `benchmark:longmemeval:smoke` scripts that delegate to `pnpm --filter @ledgermind/benchmark-longmemeval ...`.

- [ ] **Step 3: Write the package wiring test first.**

Create a minimal `benchmarks/longmemeval/src/config.test.ts` that imports the package config parser and verifies the default runtime mode, output path prefix, and smoke/canary option parsing.

- [ ] **Step 4: Run the failing package test.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/config.test.ts`

Expected: FAIL with missing files or missing exports.

- [ ] **Step 5: Add the minimal implementation to make the wiring test pass.**

Implement concrete minimal versions of `package.json`, `tsconfig.json`, `src/index.ts`, and `src/config.ts` with the final CLI flag names, default output-directory prefix, and smoke/canary parsing behavior. Do not leave TODO markers or temporary placeholder values.

- [ ] **Step 6: Re-run the wiring test until it passes.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/config.test.ts`

Expected: PASS.

- [ ] **Step 7: Run typecheck before committing.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval typecheck`

Expected: Typecheck passes.

- [ ] **Step 8: Commit the scaffold separately.**

Run:

```bash
git add benchmarks/longmemeval package.json
git commit -m "feat: scaffold LongMemEval benchmark package"
```

### Task 2: Normalize LongMemEval dataset inputs

**Files:**
- Create: `benchmarks/longmemeval/src/types.ts`
- Create: `benchmarks/longmemeval/src/dataset.ts`
- Create: `benchmarks/longmemeval/src/dataset.test.ts`
- Create: `benchmarks/longmemeval/data/official/.gitkeep`
- Create: `benchmarks/longmemeval/vendor/official-scorer/.gitkeep`
- Modify: `benchmarks/longmemeval/README.md`

- [ ] **Step 1: Write a failing dataset normalization test from one real fixture shape.**

Create `benchmarks/longmemeval/src/dataset.test.ts` with one or two representative fixture objects from the official dataset schema. Assert that normalization yields a local type with `exampleId`, `question`, `answer`, `history`, optional `goldEvidenceIds`, and metadata retained in a typed record.

- [ ] **Step 2: Run the dataset test to verify the failure mode.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/dataset.test.ts`

Expected: FAIL because `normalizeLongMemEvalExample` does not exist yet.

- [ ] **Step 3: Implement suite-local types before dataset loading logic.**

Add explicit baseline names, run config types, trace record types, and dataset types in `src/types.ts`. Do not import LOCOMO benchmark types across packages.

- [ ] **Step 4: Implement dataset normalization with exact id preservation.**

Implement `src/dataset.ts` so every history unit preserves original dataset ids or source indices in normalized output. Include deterministic ordering and clear error messages when required fields are absent.

- [ ] **Step 5: Document expected dataset placement and licensing notes.**

Update `benchmarks/longmemeval/README.md` to require the official dataset export at `benchmarks/longmemeval/data/official/dataset.jsonl` and the official scorer entry point at `benchmarks/longmemeval/vendor/official-scorer/evaluate.py`. State whether the assets are manually downloaded, vendored locally, and excluded from git when licensing requires it.

- [ ] **Step 6: Re-run the dataset test and the config test.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/dataset.test.ts src/config.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit dataset normalization separately.**

Run:

```bash
git add benchmarks/longmemeval
git commit -m "feat: normalize LongMemEval benchmark dataset"
```

### Task 3: Add scoring, prompts, and runner skeleton

**Files:**
- Create: `benchmarks/longmemeval/src/prompts.ts`
- Create: `benchmarks/longmemeval/src/scorer.ts`
- Create: `benchmarks/longmemeval/src/scorer.test.ts`
- Create: `benchmarks/longmemeval/src/utils.ts`
- Create: `benchmarks/longmemeval/src/baselines.ts`
- Create: `benchmarks/longmemeval/src/report.ts`
- Create: `benchmarks/longmemeval/src/report.test.ts`
- Create: `benchmarks/longmemeval/src/runner.ts`
- Create: `benchmarks/longmemeval/src/runner.test.ts`
- Create: `benchmarks/longmemeval/src/cli.ts`

- [ ] **Step 1: Write the failing scorer and report tests first.**

Create `src/scorer.test.ts` to verify answer normalization, parity labeling, and fallback behavior when the official scorer is unavailable. Create `src/report.test.ts` to verify the package writes `config_snapshot.json`, `per_example.jsonl`, `trace_per_example.jsonl`, and `summary.md` into one output directory, and that each row includes `exampleId`, `baseline`, `score`, and `parityMode`.

- [ ] **Step 2: Run the new tests to confirm the missing implementation.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/scorer.test.ts src/report.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement a suite-local scoring wrapper and prompt module.**

Keep the answer prompt identical across parity baselines. The scorer wrapper must clearly label `full_history_upper_bound` as non-parity whenever the input exceeds the parity budget.

- [ ] **Step 4: Implement a minimal baseline registry and runner skeleton without LedgerMind yet.**

Add `src/baselines.ts`, `src/runner.ts`, and `src/cli.ts` so the package can execute `full_history_upper_bound` over a tiny in-memory fixture without embedding baseline logic directly inside `runner.ts`.

- [ ] **Step 5: Add a runner orchestration test that locks the artifact contract.**

In `src/runner.test.ts`, verify that one fake example produces all four artifacts, that `summary.md` includes aggregate score, prompt token counts, and upper-bound labeling, and that `trace_per_example.jsonl` rows include latency, token, and cost placeholders driven by the real report schema.

- [ ] **Step 6: Re-run the runner, scorer, and report tests.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/scorer.test.ts src/report.test.ts src/runner.test.ts`

Expected: PASS.

- [ ] **Step 7: Run the CLI help smoke check once `src/cli.ts` exists.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval benchmark -- --help`

Expected: The CLI prints the supported LongMemEval flags without starting a benchmark run.

- [ ] **Step 8: Commit the non-LedgerMind harness skeleton.**

Run:

```bash
git add benchmarks/longmemeval
git commit -m "feat: add LongMemEval runner and artifact contract"
```

## Chunk 2: LongMemEval LedgerMind Baselines And Retrieval Diagnostics

### Task 4: Adapt LedgerMind runtime ingestion for LongMemEval

**Files:**
- Create: `benchmarks/longmemeval/src/ledgermind-runtime.ts`
- Create: `benchmarks/longmemeval/src/ledgermind-runtime.test.ts`
- Modify: `benchmarks/longmemeval/src/config.ts`
- Modify: `benchmarks/longmemeval/src/types.ts`
- Modify: `benchmarks/longmemeval/src/runner.ts`
- Modify: `benchmarks/longmemeval/src/report.ts`
- Modify: `benchmarks/longmemeval/src/config.test.ts`
- Modify: `benchmarks/longmemeval/src/runner.test.ts`
- Modify: `benchmarks/longmemeval/src/report.test.ts`

- [ ] **Step 1: Write a failing runtime ingestion test that preserves source ids.**

Create `src/ledgermind-runtime.test.ts` that appends a small LongMemEval history into an in-memory runtime and asserts that message metadata or content preserves original dataset ids, speaker information, and ordering.

- [ ] **Step 2: Run the runtime test before implementing the adapter.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/ledgermind-runtime.test.ts`

Expected: FAIL because the runtime adapter does not exist yet.

- [ ] **Step 3: Copy the LOCOMO runtime assembly pattern, not the LOCOMO semantics.**

Implement `src/ledgermind-runtime.ts` by following the in-memory engine wiring used in `benchmarks/locomo/src/ledgermind-runtime.ts`, but rename types and helpers so the module is LongMemEval-local. Preserve raw history ids and keep artifact storage optional.

- [ ] **Step 4: Add precompaction as an explicit runtime option.**

The runtime should support precompaction because the product does. Wire the setting through `src/config.ts`, include it in the run config and snapshot types, surface it in `summary.md` and traces through `src/report.ts`, and lock the behavior with `src/config.test.ts`, `src/runner.test.ts`, and `src/report.test.ts`.

- [ ] **Step 5: Re-run the runtime, config, runner, and report tests together.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/ledgermind-runtime.test.ts src/config.test.ts src/runner.test.ts src/report.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit runtime assembly separately.**

Run:

```bash
git add benchmarks/longmemeval
git commit -m "feat: add LongMemEval LedgerMind runtime"
```

### Task 5: Implement parity baselines without raw-turn injection shortcuts

**Files:**
- Create: `benchmarks/longmemeval/src/baselines.test.ts`
- Modify: `benchmarks/longmemeval/src/config.ts`
- Modify: `benchmarks/longmemeval/src/runner.ts`
- Modify: `benchmarks/longmemeval/src/types.ts`
- Modify: `benchmarks/longmemeval/src/baselines.ts`
- Modify: `benchmarks/longmemeval/src/runner.test.ts`

- [ ] **Step 1: Write a failing baseline-selection test for the three required modes.**

Create `src/baselines.test.ts` that asserts the package exposes exactly `full_history_upper_bound`, `ledgermind_static_materialize`, and `ledgermind_agentic_loop` as the initial baseline set.

- [ ] **Step 2: Add a failing fairness test for identical answer settings across parity baselines.**

In the same test file, assert that baseline differences are limited to context construction and runtime provenance, not answer prompt settings.

- [ ] **Step 3: Run the failing baseline test.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/baselines.test.ts`

Expected: FAIL because the baseline registry is not implemented.

- [ ] **Step 4: Implement `full_history_upper_bound` first.**

Feed the full normalized history directly into the shared answer path and label it as non-parity whenever its prompt tokens exceed the configured parity budget.

- [ ] **Step 5: Implement `ledgermind_static_materialize` second.**

Use `materializeContext` with the configured parity budget. Do not add question-conditioned raw-turn injection in the main baseline.

- [ ] **Step 6: Implement `ledgermind_agentic_loop` third.**

Reserve retrieval tokens up front, then run a bounded `describe` → `expand` → `grep` loop before the answer call. Keep tool caps configurable and include them in `config_snapshot.json`.

- [ ] **Step 7: Re-run the baseline tests and one runner integration test.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/baselines.test.ts src/config.test.ts src/runner.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit baseline implementation separately.**

Run:

```bash
git add benchmarks/longmemeval
git commit -m "feat: add LongMemEval parity baselines"
```

### Task 6: Add retrieval traces and failure classification

**Files:**
- Modify: `benchmarks/longmemeval/src/types.ts`
- Modify: `benchmarks/longmemeval/src/baselines.ts`
- Modify: `benchmarks/longmemeval/src/dataset.ts`
- Modify: `benchmarks/longmemeval/src/report.ts`
- Modify: `benchmarks/longmemeval/src/report.test.ts`
- Modify: `benchmarks/longmemeval/src/runner.ts`
- Modify: `benchmarks/longmemeval/src/baselines.test.ts`
- Modify: `benchmarks/longmemeval/src/dataset.test.ts`
- Modify: `benchmarks/longmemeval/src/runner.test.ts`
- Modify: `benchmarks/longmemeval/README.md`

- [ ] **Step 1: Write a failing trace test that distinguishes retrieval failure from synthesis failure.**

Extend `src/runner.test.ts` with fixture cases for `reachability_failure` and `answer_synthesis_failure`. The test should assert that traces include `initialContextIds`, `postToolContextIds`, `describedIds`, `expandedIds`, `grepQueries`, `grepMatchCounts`, `latencyMs`, `promptTokens`, `completionTokens`, `estimatedCost`, and `failureClassification`.

- [ ] **Step 2: Run the failing trace test to confirm the missing fields.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/runner.test.ts src/baselines.test.ts`

Expected: FAIL with missing trace data or incorrect classifications.

- [ ] **Step 3: Add evidence reachability bookkeeping.**

Normalize official evidence ids into the `goldEvidenceIds` field in `src/dataset.ts` when the dataset provides them, and use that field as the authoritative source for `matchedEvidenceIds`, `missingEvidenceIds`, `hasAnyGoldEvidenceInInitialContext`, `hasAnyGoldEvidencePostToolLoop`, and `firstGoldEvidenceRecoveredAtStep`. Only emit `silverEvidenceDiagnostics` when `goldEvidenceIds` is absent for a normalized example.

- [ ] **Step 4: Persist tool-loop diagnostics in trace artifacts.**

The trace record must include a `toolSteps` array with explicit fields for `step`, `kind`, `targetId`, `query`, `matchCount`, `addedTokens`, and `outcome`, plus top-level latency, prompt tokens, completion tokens, and estimated cost so a later reviewer can explain whether the retrieval loop meaningfully helped and what it cost.

- [ ] **Step 5: Update `summary.md` generation with retrieval-effectiveness sections.**

Add aggregate reachability-before-tool-loop, reachability-after-tool-loop, failure-mix, and tool-depth summaries. Keep the report focused on decision-making rather than wide ablations.

- [ ] **Step 6: Re-run the dataset, report, and runner tests.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test -- --run src/dataset.test.ts src/report.test.ts src/runner.test.ts src/baselines.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the diagnostics layer separately.**

Run:

```bash
git add benchmarks/longmemeval
git commit -m "feat: add LongMemEval retrieval diagnostics"
```

### Task 7: Add pinned subsets and a smoke-quality contract

**Files:**
- Create: `benchmarks/longmemeval/config/smoke-example-ids.json`
- Create: `benchmarks/longmemeval/config/canary-example-ids.json`
- Create: `tests/quality/__tests__/longmemeval-smoke.test.ts`
- Modify: `tests/package.json`
- Modify: `package.json`
- Modify: `benchmarks/longmemeval/README.md`

- [ ] **Step 1: Write the failing quality smoke test before selecting final ids.**

Create `tests/quality/__tests__/longmemeval-smoke.test.ts` that executes the LongMemEval smoke command against a pinned subset and asserts that the run emits the standard artifacts, includes explicit parity versus upper-bound labeling, and includes a failure-mix section in `summary.md`.

- [ ] **Step 2: Run the smoke test to confirm the missing subset config and script wiring.**

Run: `pnpm --filter @ledgermind/tests test -- --run quality/__tests__/longmemeval-smoke.test.ts`

Expected: FAIL because the subset ids and smoke script are not wired yet.

- [ ] **Step 3: Pin a small smoke subset and a retrieval-sensitive canary subset.**

Populate `smoke-example-ids.json` with 15 to 25 examples for quick validation. Populate `canary-example-ids.json` with 30 to 50 examples weighted toward buried-evidence and distant-history retrieval cases.

- [ ] **Step 4: Wire new smoke scripts in both package manifests.**

Update `tests/package.json` with `test:quality:longmemeval:smoke` and update the root `package.json` with `benchmark:longmemeval:smoke` if it was not already added.

- [ ] **Step 5: Re-run the smoke-quality test and then the package test suite.**

Run: `pnpm --filter @ledgermind/tests test -- --run quality/__tests__/longmemeval-smoke.test.ts`

Then run: `pnpm --filter @ledgermind/benchmark-longmemeval test`

Expected: PASS.

- [ ] **Step 6: Commit the LongMemEval smoke contract separately.**

Run:

```bash
git add benchmarks/longmemeval tests package.json
git commit -m "test: add LongMemEval smoke quality gate"
```

## Chunk 3: OOLONG Thin Follow-On And Promotion Workflow

### Task 8: Scaffold OOLONG only after LongMemEval produces useful artifacts

**Files:**
- Create: `benchmarks/oolong/package.json`
- Create: `benchmarks/oolong/tsconfig.json`
- Create: `benchmarks/oolong/README.md`
- Create: `benchmarks/oolong/src/index.ts`
- Create: `benchmarks/oolong/src/types.ts`
- Create: `benchmarks/oolong/src/utils.ts`
- Create: `benchmarks/oolong/src/config.ts`
- Create: `benchmarks/oolong/src/dataset.ts`
- Create: `benchmarks/oolong/src/prompts.ts`
- Create: `benchmarks/oolong/src/scorer.ts`
- Create: `benchmarks/oolong/src/config.test.ts`
- Create: `benchmarks/oolong/src/dataset.test.ts`
- Create: `benchmarks/oolong/src/scorer.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Verify the LongMemEval go/no-go gate before writing OOLONG code.**

Run `pnpm benchmark:longmemeval -- --canary`, then inspect `benchmarks/longmemeval/runs/<run-id>/summary.md` and `benchmarks/longmemeval/runs/<run-id>/trace_per_example.jsonl`. Proceed only if the canary run shows explicit `reachability_failure` versus `answer_synthesis_failure` classification on a meaningful slice of examples and the team still needs a separate aggregation-oriented benchmark to answer the prompt-size and latency question.

- [ ] **Step 2: Write the failing OOLONG config, dataset, and scorer tests first.**

Create `benchmarks/oolong/src/config.test.ts`, `src/dataset.test.ts`, and `src/scorer.test.ts` that lock the package shape, normalized dataset contract, and scoring behavior before runner logic is implemented.

- [ ] **Step 3: Run the failing OOLONG tests.**

Run: `pnpm --filter @ledgermind/benchmark-oolong test -- --run src/config.test.ts src/dataset.test.ts src/scorer.test.ts`

Expected: FAIL with missing package files.

- [ ] **Step 4: Implement OOLONG package wiring and operator docs.**

Copy the LongMemEval package shape, create `package.json`, `tsconfig.json`, `README.md`, `src/index.ts`, and `src/config.ts`, and document that the canonical local dataset/scorer paths are `benchmarks/oolong/data/official/dataset.jsonl` and `benchmarks/oolong/vendor/official-scorer/evaluate.py`. Treat those assets as locally supplied inputs, not repo-authored files, unless licensing explicitly allows vendoring them.

- [ ] **Step 5: Implement OOLONG dataset, scorer, and prompt modules.**

Add `src/dataset.ts`, `src/scorer.ts`, and `src/prompts.ts` as suite-local modules. Keep dataset parsing and scoring real, not placeholder pass-throughs.

- [ ] **Step 6: Re-run the package tests.**

Run: `pnpm --filter @ledgermind/benchmark-oolong test -- --run src/config.test.ts src/dataset.test.ts src/scorer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit OOLONG scaffold separately.**

Run:

```bash
git add benchmarks/oolong package.json
git commit -m "feat: scaffold OOLONG benchmark package"
```

### Task 9: Add the thin OOLONG baseline set and operator docs

**Files:**
- Create: `benchmarks/oolong/config/smoke-example-ids.json`
- Create: `benchmarks/oolong/src/ledgermind-runtime.ts`
- Create: `benchmarks/oolong/src/baselines.ts`
- Create: `benchmarks/oolong/src/report.ts`
- Create: `benchmarks/oolong/src/report.test.ts`
- Create: `benchmarks/oolong/src/runner.ts`
- Create: `benchmarks/oolong/src/cli.ts`
- Create: `benchmarks/oolong/src/runner.test.ts`
- Modify: `benchmarks/oolong/src/config.ts`
- Modify: `benchmarks/oolong/README.md`

- [ ] **Step 1: Write failing runner and report tests for the three thin baselines.**

Create `benchmarks/oolong/src/runner.test.ts` and `src/report.test.ts` that assert the package emits results for `full_history_upper_bound`, `ledgermind_static_materialize`, and `ledgermind_agentic_loop`, plus prompt size and latency sections in `summary.md`.

- [ ] **Step 2: Run the failing OOLONG runner and report tests.**

Run: `pnpm --filter @ledgermind/benchmark-oolong test -- --run src/runner.test.ts src/report.test.ts`

Expected: FAIL because the baselines and report sections are incomplete.

- [ ] **Step 3: Implement the thin baseline set.**

Implement `src/ledgermind-runtime.ts`, `src/baselines.ts`, `src/runner.ts`, `src/cli.ts`, and `src/report.ts` using the LongMemEval package shape as a reference. Keep the diagnostics focused on score, prompt size, latency, and cost. If tool-loop depth is recorded, treat it as advisory rather than the central report theme.

- [ ] **Step 4: Pin a minimal smoke subset.**

Create `benchmarks/oolong/config/smoke-example-ids.json` with a small stable subset for repeatable runs.

- [ ] **Step 5: Re-run the OOLONG package tests.**

Run: `pnpm --filter @ledgermind/benchmark-oolong test`

Then run: `pnpm --filter @ledgermind/benchmark-oolong benchmark -- --smoke`

Expected: PASS.

- [ ] **Step 6: Commit the OOLONG baseline layer separately.**

Run:

```bash
git add benchmarks/oolong
git commit -m "feat: add OOLONG benchmark baselines"
```

### Task 10: Final reporting, smoke scripts, and promotion notes

**Files:**
- Modify: `package.json`
- Modify: `tests/package.json`
- Modify: `benchmarks/longmemeval/README.md`
- Modify: `benchmarks/oolong/README.md`
- Create: `tests/quality/__tests__/oolong-smoke.test.ts` only if the OOLONG package is stable enough for a smoke contract.

- [ ] **Step 1: Add root operator commands for both suites.**

Keep the LongMemEval root scripts in place. Only add `benchmark:oolong` and `benchmark:oolong:smoke` if the Task 8 go/no-go gate passed and the OOLONG package was actually created. Keep naming aligned with the LongMemEval scripts.

- [ ] **Step 2: Add a quality smoke test for OOLONG only if the spike proved valuable.**

If OOLONG remains exploratory or brittle, document why a smoke test is deferred instead of forcing one into CI prematurely.

- [ ] **Step 3: Update both READMEs with promotion criteria.**

Always update `benchmarks/longmemeval/README.md` with the promotion criteria. Update `benchmarks/oolong/README.md` only if the OOLONG package exists; otherwise document the no-go decision and rationale in the LongMemEval README or the current session handoff notes.

- [ ] **Step 4: Run package tests and any added quality smoke tests together.**

Run: `pnpm --filter @ledgermind/benchmark-longmemeval test`

Run: `pnpm --filter @ledgermind/benchmark-longmemeval typecheck`

Run: `pnpm --filter @ledgermind/benchmark-longmemeval lint`

If the OOLONG package exists, run: `pnpm --filter @ledgermind/benchmark-oolong test`

If the OOLONG package exists, run: `pnpm --filter @ledgermind/benchmark-oolong typecheck`

If the OOLONG package exists, run: `pnpm --filter @ledgermind/benchmark-oolong lint`

Run: `pnpm --filter @ledgermind/tests test -- --run quality/__tests__/longmemeval-smoke.test.ts`

Run: `pnpm benchmark:longmemeval:smoke`

If the OOLONG package exists, run: `pnpm benchmark:oolong:smoke`

If `tests/quality/__tests__/oolong-smoke.test.ts` exists, run it too.

Expected: PASS.

- [ ] **Step 5: Commit the final operator and reporting layer.**

If OOLONG was skipped, commit only the LongMemEval and shared-operator changes.

If OOLONG exists, commit the LongMemEval, OOLONG, tests, and root-script changes together.

Run:

```bash
git add benchmarks/longmemeval tests package.json
git add benchmarks/oolong 2>/dev/null || true
git commit -m "docs: finalize benchmark spike operator workflow"
```

## Verification Checklist

- [ ] `pnpm --filter @ledgermind/benchmark-longmemeval test`
- [ ] `pnpm --filter @ledgermind/benchmark-longmemeval typecheck`
- [ ] `pnpm --filter @ledgermind/benchmark-longmemeval lint`
- [ ] `pnpm --filter @ledgermind/tests test -- --run quality/__tests__/longmemeval-smoke.test.ts`
- [ ] `pnpm --filter @ledgermind/benchmark-oolong test` once OOLONG exists
- [ ] `pnpm --filter @ledgermind/benchmark-oolong typecheck` once OOLONG exists
- [ ] `pnpm --filter @ledgermind/benchmark-oolong lint` once OOLONG exists
- [ ] `pnpm --filter @ledgermind/tests test -- --run quality/__tests__/oolong-smoke.test.ts` only if the OOLONG smoke gate is added

## Execution Notes

1. Keep every benchmark package self-contained until both suites prove they deserve long-term maintenance.
2. Do not import implementation files from `benchmarks/locomo/src` into the new suites. Copy patterns, then rename and adapt them locally.
3. Do not enable question-conditioned raw-turn injection in the main LongMemEval parity baselines.
4. Do not start OOLONG implementation until LongMemEval artifacts answer the main retrieval-versus-synthesis question.
5. If either suite proves weak or redundant, stop after the artifact review and document the decision rather than overbuilding.
