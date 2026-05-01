# Continuity Harness Example

This is a copy-friendly local harness for using LedgerMind as a coding-agent continuity layer.

## 1. Durable Storage

SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.

```bash
export LEDGERMIND_SQLITE_PATH=.ledgermind/memory.sqlite
export LEDGERMIND_MCP_BINDING_STORE=.ledgermind/session-bindings.json
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
pnpm cockpit:dev -- state --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- next --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- task "resume current work" --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- decision "Use SQLite local durability." --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- verify "pnpm typecheck passed" --storage sqlite --sqlite .ledgermind/memory.sqlite
```
