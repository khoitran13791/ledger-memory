# Continuity Harness Example

This is a copy-friendly local harness for using LedgerMind as a coding-agent continuity layer.

## 1. Durable Storage

LedgerMind durability currently uses PostgreSQL.

```bash
export LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind
export DATABASE_URL=$LEDGERMIND_DB_URL
export LEDGERMIND_MCP_BINDING_STORE=.ledgermind/session-bindings.json
pnpm --filter @ledgermind/infrastructure migrate:up
```

## 2. MCP

Copy [`mcp.json`](./mcp.json) into your agent MCP config. It enables write tools so the agent can record continuity records, create handoffs, and mark stale decisions.

## 3. Claude Code Hooks

Copy [`claude-code-settings.json`](./claude-code-settings.json) into your Claude Code settings. The hooks enable:

- continuity injection at `SessionStart`, `UserPromptSubmit`, and `PreCompact`
- stop-time handoffs
- tool evidence for verification, failures, and edited files

## 4. Agent Instructions

Use LedgerMind to preserve operational state.
Record decisions, constraints, progress, verification, failures, next steps, and handoffs.
Prefer `memory.recallForTask` at task start.
Use `memory.describe` or `memory.expand` only when the current state references compressed evidence.
Mark stale records when decisions change.

## 5. Inspect State

Use the cockpit CLI with the same binding store and database:

```bash
LEDGERMIND_DB_URL=$LEDGERMIND_DB_URL pnpm cockpit:dev -- state
LEDGERMIND_DB_URL=$LEDGERMIND_DB_URL pnpm cockpit:dev -- next
LEDGERMIND_DB_URL=$LEDGERMIND_DB_URL pnpm cockpit:dev -- task "resume current work"
LEDGERMIND_DB_URL=$LEDGERMIND_DB_URL pnpm cockpit:dev -- decision "Use Postgres durability for alpha. SQLite is deferred until conformance passes."
LEDGERMIND_DB_URL=$LEDGERMIND_DB_URL pnpm cockpit:dev -- verify "pnpm typecheck passed"
```
