# LOCOMO Benchmark Plan for LedgerMind

## Goal
Benchmark LedgerMind against industry-standard context strategies using the official LOCOMO dataset and scorer, with reproducible and fair comparisons.

## 1) Harness (thin, offline)
Create `benchmarks/locomo` with a runner that:
- Uses the **official LOCOMO dataset** and **official scorer**
- Produces reproducible artifacts:
  - `per_example.jsonl`
  - `summary.md`
  - `config_snapshot.json` (model/prompt/seed/token budget hash)

## 2) Baselines (fixed)
Run identical pipeline for:
- `ledgermind_static_materialize` (default static runtime)
- `ledgermind_agentic_loop` (agentic runtime label; tool-loop behavior introduced separately)
- `truncation`
- `rag`
- `full_context` (marked as **upper-bound** if not parity)

Harness-validity controls (LLM mode):
- `oracle_evidence` (inject LOCOMO gold evidence turns first)
- `oracle_full_conversation_llm` (full conversation with the same LLM answer path)
- These are **control baselines for harness validity**, not product/leaderboard baselines.

## 3) Fairness + Metrics
Use the same settings across parity baselines:
- model version
- prompt template
- decoding params
- token budget
- explicit runtime mode label (`static_materialize` vs `agentic_loop`)

Report:
- Official LOCOMO aggregate score
- Category-level scores (including adversarial category)
- Token usage
- Latency
- Cost
- **3-seed mean ± std**

## 4) Rollout / Validation Ladder
- **Step 1 (smoke):** run fixed smoke subset (`--smoke`) for fast CI guardrails
- **Step 2 (canary):** run fixed canary subset (`--canary`) weighted toward categories **1/3/4**
- **Step 3 (locomo10):** run full `locomo10` benchmark and compare against canary findings
- **Step 4 (held-out):** run held-out/private split before publishing broad benchmark claims
- Keep smoke/canary example IDs committed and reviewable in version control
- Convert recurring benchmark failures into targeted `tests/probes` regressions

## 5) Agentic loop + trace diagnostics (current phase)
- For `ledgermind_agentic_loop`, run a bounded retrieval loop before answering:
  1) materialize context
  2) describe candidate summary/artifact IDs
  3) expand promising summaries
  4) grep exact evidence snippets when useful
  5) answer with augmented context
- Enforce explicit limits for determinism: max steps, per-tool call caps, and max tokens added by tool loop.
- Emit per-example trace diagnostics for:
  - tool sequence + outcomes
  - ids described/expanded
  - grep queries + match counts
  - added tokens/messages
  - whether gold evidence became reachable after tool use
  - failure category (`reachability_failure`, `answer_synthesis_failure`, `unsupported_evidence`)
- Add aggregate summary reporting for tool-loop effectiveness (reachability rate + failure mix).

## 6) Required ablation matrix + reporting workflow (LM-018)

### Matrix dimensions
Run and compare these dimensions explicitly:
- **Prediction mode:** `heuristic` vs `llm`
- **Runtime mode:** `static_materialize` vs `agentic_loop`
- **Summarizer:** `locomo_deterministic_head_tail_v1` vs `locomo_llm_structured_v1`
- **Precompaction:** ON (`ledgermind_*`) vs OFF (`ledgermind_*_no_precompaction`)
- **Artifacts path:** ON (`--artifacts-enabled true`) vs OFF (`--artifacts-enabled false`)

### Practical run order (canary first, then locomo10)
1. Run `--canary` for each dimension pair to validate directional movement quickly.
2. Promote promising configurations to full `locomo10` runs.
3. Keep each run in its own output directory and compare only runs with matching dataset subset.

### Standard command templates
```bash
# prediction mode
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode heuristic --runtime-mode static_materialize --summarizer-type locomo_deterministic_head_tail_v1 --include-ledgermind-diagnostics
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode llm --model gpt-5.4 --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --runtime-mode static_materialize --summarizer-type locomo_deterministic_head_tail_v1 --include-ledgermind-diagnostics

# runtime mode
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --runtime-mode static_materialize --include-ledgermind-diagnostics
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --runtime-mode agentic_loop --include-ledgermind-diagnostics

# summarizer mode
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --runtime-mode static_materialize --summarizer-type locomo_deterministic_head_tail_v1 --include-ledgermind-diagnostics
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --runtime-mode static_materialize --summarizer-type locomo_llm_structured_v1 --model gpt-5.4 --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --include-ledgermind-diagnostics

# artifacts toggle
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --runtime-mode agentic_loop --artifacts-enabled true --include-ledgermind-diagnostics
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --runtime-mode agentic_loop --artifacts-enabled false --include-ledgermind-diagnostics
```

### How to read `summary.md` for ablations
- **Ablation Matrix** section is the canonical table for dimensions and measured behavior.
- **Score Movement Drivers** section explains why scores moved (evidence recall, fallback rate, retrieval additions, answer-source mix, tool-loop depth).
- **Execution Provenance** is a trustworthiness gate: requested mode and actual source counts must align (e.g., no hidden heuristic rows in requested LLM runs, no hidden LLM rows in requested heuristic runs).
- **Promotion Gates (phase 3 smoke)** is the promotion contract for diagnostic variants.
- Always report deltas relative to runtime anchors:
  - static variants vs `ledgermind_static_materialize`
  - agentic variants vs `ledgermind_agentic_loop`

### Promotion and trustworthiness gates (LM-019)
- Treat these as required gates, not advisory metrics:
  1. **Truthfulness gate:** execution provenance must clearly record requested prediction mode and actual prediction source counts per baseline.
  2. **No-silent-fallback gate:** if requested mode is `llm`, unexpected heuristic rows are a failure; if requested mode is `heuristic`, unexpected llm rows are a failure.
  3. **Promotion gate (diagnostic variants only):** a diagnostic baseline is promoted when either:
     - aggregate delta vs runtime anchor (`ledgermind_static_materialize` or `ledgermind_agentic_loop`) is `>= 0.03`, or
     - at least 2 of categories 1/3/4 improve by `>= 0.05`.
- Smoke tests in `tests/quality/__tests__/locomo-smoke.test.ts` enforce these invariants and fail fast when the benchmark contract regresses.

## Deliverables
- LOCOMO harness in `benchmarks/locomo`
- Saved run artifacts and reproducible config snapshots
- Comparison report across LedgerMind and baselines
- CI smoke subset + canary subset + probe regressions for recurring failure modes
