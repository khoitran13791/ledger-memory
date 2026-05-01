# LedgerMind

LedgerMind makes coding-agent work resumable, inspectable, and evidence-backed across context resets, compaction, and handoffs. It implements that promise with an append-only ledger, summary DAG, artifact store, MCP memory tools, Claude Code lifecycle hooks, and a CLI for humans and agents to inspect the same operational state.

## Current status

LedgerMind is now a working alpha, not just a scaffold. The core engine packages, SDK, MCP server, SQLite and PostgreSQL backends, operator worker, Claude Code integration, and benchmark harnesses are all present in this repo and covered by the monorepo build/test pipeline.

SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.

The SQLite adapter uses Node's built-in `node:sqlite` module. On supported Node 22 runtimes this may emit `ExperimentalWarning`; the adapter is isolated behind LedgerMind's persistence ports so the public engine API stays backend-neutral.

Implemented today:

- append-only ledger storage and context projection
- hierarchical summary DAG, deterministic compaction, and materialized context retrieval
- artifact storage plus type-aware exploration hooks
- continuity records for decisions, constraints, progress, verification, failures, next steps, and handoffs
- in-memory, SQLite, and PostgreSQL persistence paths
- SDK factories for in-memory, SQLite, PostgreSQL, and generic engine creation
- durable operator APIs via `llmMap()`, `agenticMap()`, and `getOperatorRun()`
- MCP server, operator worker app, and Claude Code integration package
- offline LOCOMO and LongMemEval benchmark harnesses

Still evolving:

- retrieval quality and answer quality on benchmark suites
- broader runtime integrations and production hardening
- benchmark coverage and reporting depth, especially outside LOCOMO

## Core capabilities

- Immutable append-only ledger for conversation and tool events
- Hierarchical summary DAG with provenance-aware expansion
- Context compaction and materialization use cases
- Type-aware artifact exploration via pluggable explorers
- Durable operator execution and inspection APIs
- Clean Architecture package boundaries for extensibility and testability

## Monorepo layout

- `packages/domain` — entities, value objects, domain services, events, errors
- `packages/application` — use cases and port interfaces
- `packages/adapters` — in-memory adapters, explorers, tokenizer, auth, jobs, tools
- `packages/infrastructure` — SQLite, PostgreSQL, and filesystem implementations
- `packages/sdk` — composition root and public engine factory APIs
- `packages/mcp-server` — stdio MCP server exposing LedgerMind tools
- `packages/claude-code` — Claude Code hooks and integration helpers
- `apps/operator-worker` — worker entrypoint for durable operator runs
- `benchmarks/locomo` — LOCOMO evaluation harness with smoke/canary/full runs
- `benchmarks/longmemeval` — LongMemEval harness (currently benchmark-spike maturity)
- `examples` — example MCP configs for Claude Code and Amp
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

## Memory Cockpit CLI

Use the cockpit CLI to inspect setup, write manual memory notes, and search the active workspace binding.
When run through `pnpm cockpit:dev`, the CLI scopes the default workspace and binding store to the shell directory that launched pnpm.

```bash
pnpm cockpit:dev -- doctor
pnpm cockpit:dev -- status --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- remember "Persist the current design decision." --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- recall "design decision" --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- timeline --storage sqlite --sqlite .ledgermind/memory.sqlite
```

Add `--json` to any command for agent-readable output.

## SDK usage

```ts
import {
  createInMemoryMemoryEngine,
  createMemoryEngine,
  createPostgresMemoryEngine,
  createSqliteMemoryEngine,
} from '@ledgermind/sdk';

const memory = createInMemoryMemoryEngine();

const sqliteMemory = createSqliteMemoryEngine({
  path: '.ledgermind/memory.sqlite',
});

const postgresMemory = createPostgresMemoryEngine({
  connectionString: process.env.DATABASE_URL!,
});

const customMemory = createMemoryEngine({
  storage: { type: 'in-memory' },
});
```

### Engine surface

`MemoryEngine` currently exposes:

- `append`
- `materializeContext`
- `runCompaction`
- `checkIntegrity`
- `recordContinuity`
- `createHandoff`
- `getCurrentState`
- `getNextSteps`
- `recallForTask`
- `markContinuityRecord`
- `grep`
- `describe`
- `expand`
- `storeArtifact`
- `exploreArtifact`
- `llmMap`
- `agenticMap`
- `getOperatorRun`

## Common commands

Repo-wide:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm format`
- `pnpm format:write`

Integration and worker entrypoints:

- `pnpm mcp:dev`
- `pnpm worker:operator`
- `pnpm worker:operator:test`

Benchmark entrypoints:

- `pnpm benchmark:locomo`
- `pnpm benchmark:locomo:smoke`
- `pnpm benchmark:locomo:canary`
- `pnpm benchmark:longmemeval`
- `pnpm benchmark:longmemeval:smoke`

## PostgreSQL migrations

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/ledgermind
pnpm --filter @ledgermind/infrastructure migrate:up
pnpm --filter @ledgermind/infrastructure migrate:status
pnpm --filter @ledgermind/infrastructure migrate:down
```

## Durable operators

LedgerMind now exposes durable operator recursion through `llmMap()`, `agenticMap()`, and `getOperatorRun()` on `MemoryEngine`.

Minimal local workflow:

1. create or choose a conversation
2. call `llmMap()` or `agenticMap()` and keep the returned `runId`
3. start your runtime's operator worker (`pnpm worker:operator` is the repo CLI entrypoint once runtime executors are wired)
4. inspect status with `getOperatorRun({ runId })`

For API details, zero-item behavior, child bootstrap/reuse rules, inline vs durable execution modes, and worker requirements, see `docs/operator-level-recursion.md`.

## Integrations

- `@ledgermind/mcp-server` exposes the canonical memory tool catalog over stdio MCP.
- `@ledgermind/claude-code` adds Claude Code lifecycle hooks for session binding, pre-compaction archival, stop-time persistence, and optional artifact indexing.
- Amp-style runtimes currently consume the same MCP surface rather than a dedicated runtime package.
- Example configs live under `examples/claude-code/` and `examples/ampcode/`.

## Benchmarks

### LOCOMO

The LOCOMO harness is the main benchmark workflow in the repo today. It supports smoke, canary, and fuller parity runs, and writes artifacts under `benchmarks/locomo/runs/<run-id>/`:

- `per_example.jsonl`
- `trace_per_example.jsonl`
- `summary.md`
- `config_snapshot.json`

You can run it from the repo root with:

```bash
pnpm benchmark:locomo
pnpm benchmark:locomo:smoke
pnpm benchmark:locomo:canary
```

#### Latest canary snapshot

Fresh LLM-mode canary snapshot:

- Run artifact: [`locomo-2026-04-21T17-44-20-586Z/summary.md`](benchmarks/locomo/runs/locomo-2026-04-21T17-44-20-586Z/summary.md)
- Scope: LOCOMO canary subset (`30` executions), `gpt-5.4-mini`, seed `0`, artifacts enabled
- `ledgermind_static_materialize`: official score `0.437`, evidence recall `0.501`, any gold evidence in context `63.3%`, all gold evidence in context `40.0%`
- `truncation`: official score `0.144`, evidence recall `0.000`, any gold evidence in context `0.0%`, all gold evidence in context `0.0%`
- `rag`: official score `0.325`, evidence recall `0.322`, any gold evidence in context `40.0%`, all gold evidence in context `26.7%`
- `oracle_evidence`: official score `0.602`, evidence recall `1.000`, any gold evidence in context `100.0%`, all gold evidence in context `100.0%`

Read this as a floor/current/ceiling comparison: LedgerMind is well above raw truncation and ahead of `rag`, but still below the gold-evidence control. This is a canary health snapshot, not a full benchmark claim. Use the generated artifact for the full table, config snapshot, and per-example traces.

### LongMemEval

The LongMemEval harness is present and runnable, but it is still at benchmark-spike maturity. It keeps LongMemEval-specific dataset/scorer parsing local to `benchmarks/longmemeval/` and writes suite-local artifacts under `benchmarks/longmemeval/runs/`.

You can run it from the repo root with:

```bash
pnpm benchmark:longmemeval
pnpm benchmark:longmemeval:smoke
```

## Key docs

- `docs/high-level-design.md` — canonical design contract and architecture blueprint
- `docs/agent-continuity-layer.md` — continuity record model, recall flow, handoff shape, and storage guidance
- `docs/operator-level-recursion.md` — durable operator API, worker flow, and inspection guide
- `docs/design-decisions-addendum.md` — supporting design decisions and rationale
- `docs/testing-strategy.md` — test strategy and quality gates
- `docs/implementation-roadmap.md` — delivery roadmap and sprint sequencing
- `docs/agent-integration-architecture.md` — MCP-first agent integration ADR
- `docs/claude-code-integration.md` — implemented Claude Code integration guide
- `docs/ampcode-integration.md` — Amp-facing MCP setup and current limits
- `docs/locomo-benchmark-plan.md` — LOCOMO benchmark rollout plan
