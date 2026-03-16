# LongMemEval Benchmark Harness

Thin offline harness for evaluating LedgerMind on LongMemEval with reproducible run artifacts.

## Status

This package is being added in benchmark-spike form. It will produce suite-local artifacts under `benchmarks/longmemeval/runs/` and keeps LongMemEval-specific parsing, scoring, prompts, and reporting local to this package.

## Dataset And Scorer Placement

Provide the official LongMemEval export locally at `benchmarks/longmemeval/data/official/dataset.jsonl`.
Provide the official scorer entry point locally at `benchmarks/longmemeval/vendor/official-scorer/evaluate.py`.
These assets are treated as externally supplied benchmark inputs. Download them manually from the official LongMemEval release or dataset source and keep them out of git when licensing, redistribution terms, or file size make vendoring inappropriate.

## Commands

From the repo root:

```bash
pnpm benchmark:longmemeval
pnpm benchmark:longmemeval:smoke
```

Direct package commands:

```bash
pnpm --filter @ledgermind/benchmark-longmemeval test
pnpm --filter @ledgermind/benchmark-longmemeval benchmark
pnpm --filter @ledgermind/benchmark-longmemeval benchmark:smoke
pnpm --filter @ledgermind/benchmark-longmemeval benchmark:canary
```
