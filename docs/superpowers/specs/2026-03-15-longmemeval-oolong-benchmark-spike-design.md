# LongMemEval And OOLONG Benchmark Spike Design

## Goal

Run a lightweight benchmark research spike that tests LedgerMind on `LongMemEval` first and `OOLONG` second, using the existing LOCOMO harness as a structural reference without prematurely extracting a shared benchmark core.

## Why LOCOMO Is Not A Fair LCM Measure

The current LOCOMO harness mostly measures one-shot compressed-context QA. In practice, the saved LOCOMO runs emphasized `static_materialize`, deterministic head-tail summarization, and only shallow use of the bounded retrieval loop. That setup under-tests the main LCM claim from `docs/LCM.pdf`: aggressive compression is acceptable when exact evidence remains recoverable from an immutable store through `describe`, `expand`, and `grep`.

This means a good follow-on benchmark must distinguish:

1. Evidence never becoming reachable from LedgerMind memory.
2. Evidence becoming reachable but the answer step still failing.
3. Upper-bound score ceilings caused by prompt or synthesis quality rather than retrieval.

## Scope

### LongMemEval

LongMemEval is the primary spike because it is closer to the product claim: long-horizon memory retrieval for assistant-style interactions.

The minimum viable baseline set is:

1. `full_history_upper_bound`
2. `ledgermind_static_materialize`
3. `ledgermind_agentic_loop`

The main output is not just score. It is score plus retrieval diagnostics that separate `reachability_failure` from `answer_synthesis_failure`.

### OOLONG

OOLONG is a secondary, thinner spike. It is mainly a stress test for long-context aggregation and answer quality under prompt pressure. It should reuse the same broad harness shape, but it does not need the same depth of retrieval-forensics unless the dataset naturally supports it.

## Architecture Decision

Create two separate benchmark packages under `benchmarks/`.

1. `benchmarks/longmemeval`
2. `benchmarks/oolong`

Each package should copy the LOCOMO package layout pattern:

1. `src/cli.ts`
2. `src/config.ts`
3. `src/dataset.ts`
4. `src/scorer.ts`
5. `src/prompts.ts`
6. `src/ledgermind-runtime.ts`
7. `src/baselines.ts`
8. `src/runner.ts`
9. `src/report.ts`
10. `src/types.ts`
11. `README.md`
12. `package.json`
13. `tsconfig.json`

Do not introduce a `benchmarks/core` package during the spike.

## Reuse Strategy

Reuse the LOCOMO harness shape, fairness fingerprint ideas, artifact contract, and LedgerMind runtime assembly style from `benchmarks/locomo`.

Keep the following suite-local until both spikes prove durable:

1. dataset parsing
2. scorer integration
3. prompt templates
4. report sections
5. trace schemas
6. baseline registry logic

## Fairness Contract

Keep these identical across parity baselines:

1. answer model
2. answer prompt template
3. decoding parameters
4. answer normalization
5. seed handling
6. nominal prompt budget

Only the context-construction path should vary.

`full_history_upper_bound` must be labeled as non-parity whenever it exceeds the parity prompt budget.

## Diagnostics Contract

Every LongMemEval run should save:

1. `per_example.jsonl`
2. `trace_per_example.jsonl`
3. `summary.md`
4. `config_snapshot.json`

LongMemEval traces must capture:

1. initial context ids
2. post-tool context ids
3. described ids
4. expanded ids
5. grep queries and match counts
6. tool steps and added tokens
7. latency, prompt tokens, completion tokens, and estimated cost
8. failure classification

## Promotion Gates

The spike is successful when it can answer these questions with saved artifacts:

1. Does LongMemEval reveal failure modes that LOCOMO missed?
2. Does `ledgermind_agentic_loop` improve reachability or score over `ledgermind_static_materialize`?
3. Does OOLONG add signal about aggregation, prompt size, and latency beyond LongMemEval?
4. Which suite deserves first-class harness support later?

Promotion to a first-class benchmark should wait until the suite demonstrates stable signal, useful traces, and a clear product decision value.

## Non-Goals

This spike should not do any of the following yet:

1. build a generalized multi-suite benchmark framework
2. add the full LOCOMO-style ablation matrix immediately
3. optimize every benchmark for CI-scale speed before the signal is proven
4. preserve backwards compatibility for a public benchmark API
