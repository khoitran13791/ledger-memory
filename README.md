# LedgerMind

LedgerMind is a framework-agnostic memory engine for LLM agents, inspired by Lossless Context Management (LCM). It provides durable event storage, DAG-based summaries, deterministic compaction, and retrieval tools for long-running agent workflows.

## Status

LedgerMind is in early implementation. The monorepo structure and core packages are in place, with active development across domain, application, adapters, infrastructure, and SDK layers.

## Core capabilities

- Immutable append-only ledger for conversation and tool events
- Hierarchical summary DAG with provenance-aware expansion
- Context compaction and materialization use cases
- Type-aware artifact exploration via pluggable explorers
- Clean Architecture package boundaries for extensibility and testability

## Monorepo layout

- `packages/domain` — entities, value objects, domain services, events, errors
- `packages/application` — use cases and port interfaces
- `packages/adapters` — in-memory adapters, explorers, tokenizer, auth, jobs, tools
- `packages/infrastructure` — PostgreSQL + filesystem implementations
- `packages/sdk` — composition root and public engine factory APIs
- `tests` — golden, conformance, probe, regression, and quality suites
- `docs` — architecture/design/testing/reference documentation

## Prerequisites

- Node.js `>=22`
- `pnpm` `9.x`

## Getting started

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## SDK usage (local development)

```ts
import { createInMemoryMemoryEngine, createPostgresMemoryEngine } from '@ledgermind/sdk';

const memory = createInMemoryMemoryEngine();

const postgresMemory = createPostgresMemoryEngine({
  connectionString: process.env.DATABASE_URL!,
});
```

## PostgreSQL migrations

```bash
pnpm --filter @ledgermind/infrastructure migrate:up
pnpm --filter @ledgermind/infrastructure migrate:status
pnpm --filter @ledgermind/infrastructure migrate:down
```

## Key docs

- `docs/high-level-design.md` — architecture blueprint
- `docs/design-decisions-addendum.md` — implementation decisions and invariants
- `docs/testing-strategy.md` — test strategy and quality gates
- `docs/implementation-roadmap.md` — delivery roadmap and sprint sequencing
- `docs/claude-code-integration.md` — Claude Code integration notes
- `docs/locomo-benchmark-plan.md` — LOCOMO benchmark rollout plan

## LOCOMO benchmark harness

Run LOCOMO benchmark harness (offline artifacts):

```bash
pnpm benchmark:locomo
pnpm benchmark:locomo:smoke
```

Outputs are written under `benchmarks/locomo/runs/<run-id>/`:

- `per_example.jsonl`
- `summary.md`
- `config_snapshot.json`

## Issue tracking

This repository uses **beads (`bd`)** for issue tracking.

```bash
bd ready
bd show <id>
bd update <id> --status in_progress
bd close <id>
```
