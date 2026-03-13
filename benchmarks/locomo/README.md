# LOCOMO Benchmark Harness

Thin offline harness for benchmarking LedgerMind against LOCOMO baselines with reproducible artifacts.

## What this produces

Each run writes to `benchmarks/locomo/runs/<run-id>/`:

- `per_example.jsonl` (scoring-focused records, including `evidenceInContext` recall diagnostics)
- `trace_per_example.jsonl` (stable per-execution trace rows, including tool-loop steps, gold-evidence reachability, and failure classification)
- `summary.md` (now includes evidence-recall, `Ledgermind Diagnostics`, and tool-loop effectiveness sections)
- `config_snapshot.json`

## Baselines

Default in heuristic mode (`--runtime-mode static_materialize`):

- `ledgermind_static_materialize` (parity, raw-turn injection enabled by default)
- `truncation` (parity)
- `rag` (parity)
- `full_context` (upper-bound when it exceeds parity budget)

Default in heuristic mode with `--runtime-mode agentic_loop`:

- `ledgermind_agentic_loop` (parity, uses a bounded memory-tool loop over materialized memory: describe → expand → grep)
- `truncation` (parity)
- `rag` (parity)
- `full_context` (upper-bound when it exceeds parity budget)

Additional defaults in LLM mode:

- `oracle_evidence` (parity control baseline: prioritizes LOCOMO gold evidence turns)
- `oracle_full_conversation_llm` (upper-bound control baseline: full conversation through same LLM answer path)

Optional LedgerMind diagnostics (`--include-ledgermind-diagnostics`):

- static runtime mode: `ledgermind_static_materialize_no_precompaction`, `ledgermind_static_materialize_raw_turn_injection`, `ledgermind_static_materialize_no_precompaction_raw_turn_injection`
- agentic runtime mode: `ledgermind_agentic_loop_no_precompaction`, `ledgermind_agentic_loop_raw_turn_injection`, `ledgermind_agentic_loop_no_precompaction_raw_turn_injection`

## Usage

From repo root:

```bash
pnpm benchmark:locomo
pnpm benchmark:locomo:smoke
pnpm benchmark:locomo:canary
pnpm benchmark:locomo -- --prediction-mode llm --model gpt-5.4 --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --llm-timeout-ms 120000
```

Direct package commands:

```bash
pnpm --filter @ledgermind/benchmark-locomo build
pnpm --filter @ledgermind/benchmark-locomo benchmark --dataset benchmarks/locomo/data/locomo10.json
pnpm --filter @ledgermind/benchmark-locomo benchmark:smoke
pnpm --filter @ledgermind/benchmark-locomo benchmark:canary
pnpm --filter @ledgermind/benchmark-locomo benchmark --smoke --include-ledgermind-diagnostics
pnpm --filter @ledgermind/benchmark-locomo benchmark --smoke --baselines ledgermind_static_materialize,ledgermind_static_materialize_raw_turn_injection,rag --seeds 0
pnpm --filter @ledgermind/benchmark-locomo benchmark --smoke --runtime-mode agentic_loop --baselines ledgermind,ledgermind_raw_turn_injection,rag --seeds 0
pnpm --filter @ledgermind/benchmark-locomo benchmark --smoke --include-ledgermind-diagnostics --seeds 0 --ledgermind-raw-turn-injection-top-k 4 --ledgermind-raw-turn-injection-max-tokens 256
pnpm --filter @ledgermind/benchmark-locomo benchmark --prediction-mode llm --model gpt-5.4 --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --baselines ledgermind_static_materialize,truncation,rag --max-examples 200
```

### Useful flags

- `--prediction-mode llm` enables OpenAI-compatible generation (`heuristic` is default) and is required for oracle controls.
- `--runtime-mode <static_materialize|agentic_loop>` selects runtime labeling for LedgerMind baselines (default: `static_materialize`).
- `--artifacts-enabled <true|false>` toggles artifact storage/injection for ablation runs (default: `true`; env: `LOCOMO_ARTIFACTS_ENABLED`).
- `--model`, `--llm-base-url`, `--llm-api-key`, `--llm-timeout-ms` configure LLM inference.
- `--max-examples <N>` caps selected examples (applies before execution; useful for staged non-smoke runs).
- `--smoke` runs the fixed CI smoke subset and `--canary` runs the fixed canary subset (cannot be combined).
- `--ledgermind-tool-loop-max-steps`, `--ledgermind-tool-loop-max-describe-calls`, `--ledgermind-tool-loop-max-explore-artifact-calls`, `--ledgermind-tool-loop-max-expand-calls`, `--ledgermind-tool-loop-max-grep-calls`, and `--ledgermind-tool-loop-max-added-tokens` bound agentic retrieval behavior deterministically.
- Oracle baselines (`oracle_evidence`, `oracle_full_conversation_llm`) require `--prediction-mode llm` and intentionally fail in heuristic mode.
- Legacy baseline aliases (`ledgermind`, `ledgermind_no_precompaction`, `ledgermind_raw_turn_injection`, `ledgermind_no_precompaction_raw_turn_injection`) remain accepted and map to the selected runtime mode.
- Raw-turn injection defaults are now `top-k=4` and `max-tokens=256` for stronger default LedgerMind evidence grounding; override with `--ledgermind-raw-turn-injection-top-k` and `--ledgermind-raw-turn-injection-max-tokens`.

## Dataset and scorer

- Dataset path (default): `benchmarks/locomo/data/locomo10.json`
- Official scorer path (expected): `benchmarks/locomo/vendor/locomo/task_eval/evaluation.py`

If official scorer deps are unavailable, the harness falls back to official-style category scoring logic and still produces full artifacts.

## Smoke subset

CI smoke examples are pinned in `config/smoke-example-ids.json` (20 examples).

## Canary subset

Canary examples are pinned in `config/canary-example-ids.json` (30 examples), weighted toward categories 1/3/4 to expose multi-hop, inferential, and open-domain regressions early.

## Validation ladder

Run benchmark changes in this order before broader evaluation:

1. `smoke` subset (`--smoke`) for fast CI-style guardrails.
2. `canary` subset (`--canary`) for regression-sensitive architecture checks.
3. full `locomo10` run (default mode, no subset flag).
4. held-out evaluation (external/private split) before landing major benchmark claims.

## Phase-3 promotion and trustworthiness gates

`summary.md` includes a `Promotion Gates (phase 3 smoke)` table when diagnostic variants are present.
A diagnostic baseline is promoted when either:

- aggregate delta vs the runtime's main LedgerMind baseline (`ledgermind_static_materialize` or `ledgermind_agentic_loop`) is `>= 0.03`, or
- at least 2 of categories 1/3/4 improve by `>= 0.05`.

Trustworthiness gates are also required for every run:

- `Execution Provenance` must report requested prediction mode plus actual prediction-source counts for each baseline.
- Requested `llm` runs must not contain hidden heuristic rows.
- Requested `heuristic` runs must not contain hidden llm rows.

The quality smoke test (`tests/quality/__tests__/locomo-smoke.test.ts`) enforces these gates so regressions fail clearly.

## Ablation reporting

`summary.md` also includes:

- **Ablation Matrix**: one row per baseline with answer-source mix, runtime mode, summarizer type, precompaction toggle state, artifacts toggle state, raw-turn injection state, retrieval added average, and top tool-selection reasons.
- **Score Movement Drivers**: deltas vs runtime anchors (`ledgermind_static_materialize` / `ledgermind_agentic_loop`) with reason strings tied to evidence recall, fallback rate, retrieval behavior, answer-source mix, and tool-loop depth.

For practical iteration, run the matrix on `--canary` first, then re-run selected comparisons on full `locomo10`.
