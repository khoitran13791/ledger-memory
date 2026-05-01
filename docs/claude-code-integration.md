# Claude Code Integration

## Status

LedgerMind now ships an MCP-first Claude Code foundation with two runtime-facing packages.

1. `@ledgermind/mcp-server` exposes the canonical memory tool catalog over stdio MCP.
2. `@ledgermind/claude-code` provides lifecycle commands for `SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`, and optional `PostToolUse` evidence capture.

## What Works Today

1. `memory.currentState`, `memory.nextSteps`, `memory.recallForTask`, `memory.recall`, `memory.describe`, and `memory.expand` are exposed through the shared MCP server.
2. Claude lifecycle hooks can bind a Claude session to a stable LedgerMind `ConversationId` using the same file-backed binding store format as the MCP server.
3. Write-capable MCP tools can record decisions, constraints, progress, verification, handoffs, and stale records when `--enable-write-tools` is set.
4. `UserPromptSubmit`, `SessionStart`, and `PreCompact` can inject compact continuity state.
5. `Stop` persists a bounded handoff instead of replaying the whole transcript.
6. `PostToolUse` can record verification, failures, artifact changes, and optional artifact indexing.

## Package Responsibilities

| Package                   | Responsibility                                                   |
| ------------------------- | ---------------------------------------------------------------- |
| `@ledgermind/mcp-server`  | MCP transport, authorization, tool registration, session binding |
| `@ledgermind/claude-code` | Claude hook payload parsing and lifecycle automation             |
| `@ledgermind/adapters`    | Canonical tool semantics and policy metadata                     |

## Hook Behavior

### SessionStart

`ledgermind-claude-session-start` resolves or creates the runtime binding and emits a status block. When active continuity exists, it injects `recallForTask()` output for resuming the session.

### UserPromptSubmit

`ledgermind-claude-user-prompt-submit` recalls current state for the submitted prompt and returns compact additional context. Enable with `LEDGERMIND_CLAUDE_ENABLE_CONTINUITY_INJECTION=true`.

### PreCompact

`ledgermind-claude-pre-compact` reads the hook payload from stdin, parses the Claude transcript JSONL file, appends those events with a stable idempotency key, runs soft compaction, and returns continuity recall for the post-compaction session.

### Stop

`ledgermind-claude-stop` extracts bounded, redacted assistant handoff signals from the transcript, records a handoff with next steps and changed files, and runs soft compaction.

### PostToolUse

`ledgermind-claude-post-tool-use` is conservative by default. When `LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE=true`, it records Bash verification, failed tool responses, and edit artifact changes as continuity records. When `LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING=true`, it also stores edited workspace files as artifacts.

## Environment Variables

| Variable                                        | Purpose                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `LEDGERMIND_SQLITE_PATH`                        | SQLite database path for local durable continuity                  |
| `LEDGERMIND_DB_URL`                             | Use PostgreSQL instead of the local SQLite engine preset           |
| `LEDGERMIND_MCP_BINDING_STORE`                  | Shared file path for runtime/session bindings                      |
| `LEDGERMIND_CLAUDE_STORAGE`                     | Set to `in-memory` only for explicit non-durable test runs         |
| `LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS`        | Character budget used for bounded summaries and stop-time excerpts |
| `LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING`    | Enables `PostToolUse` artifact storage                             |
| `LEDGERMIND_CLAUDE_ENABLE_CONTINUITY_INJECTION` | Enables prompt-time continuity injection                           |
| `LEDGERMIND_CLAUDE_RECALL_BUDGET_TOKENS`        | Token budget for hook-injected current state                       |
| `LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE`        | Enables `PostToolUse` continuity evidence                          |
| `LEDGERMIND_CLAUDE_TOOL_OUTPUT_BUDGET_CHARS`    | Character budget for tool evidence summaries                       |
| `LEDGERMIND_CLAUDE_USER_SCOPE`                  | Overrides the default user scope (`USER`/`LOGNAME`)                |
| `LEDGERMIND_CLAUDE_WORKSPACE_SCOPE`             | Overrides the workspace scope derived from `cwd`                   |
| `LEDGERMIND_CLAUDE_BRANCH_SCOPE`                | Optional branch-level binding scope                                |
| `LEDGERMIND_CLAUDE_PARENT_SESSION_ID`           | Optional parent runtime session for sub-agent lineage              |

## Local Setup

1. Install dependencies with `pnpm install`.
2. Configure local durable storage: `export LEDGERMIND_SQLITE_PATH=.ledgermind/memory.sqlite`.
3. Use PostgreSQL migrations only for shared service deployments: `pnpm --filter @ledgermind/infrastructure migrate:up`.
4. Build the local packages before using bin-based example configs: `pnpm --filter @ledgermind/mcp-server build && pnpm --filter @ledgermind/claude-code build`.
5. Register the MCP server using [`examples/claude-code/.mcp.json`](../examples/claude-code/.mcp.json), or point your local config directly at the package source scripts while developing.
6. Add Claude hook commands using [`examples/claude-code/settings.json`](../examples/claude-code/settings.json) or the package templates in `packages/claude-code/src/templates/`.
7. Keep the binding-store path stable per workspace so the hooks, MCP server, and CLI resolve the same LedgerMind conversation.

### Recommended CLAUDE.md instructions

```text
At task start, read LedgerMind current state or use memory.recallForTask.
After important decisions, constraints, progress, verification, failures, and next steps, record continuity.
Before stopping, create a handoff with done, next, risks, verification, and changed files.
```

### Debug with cockpit

The cockpit CLI uses the same binding-store path as the MCP server and Claude hooks, so its workspace/runtime binding should point at the same LedgerMind conversation.
When launched through `pnpm cockpit:dev`, the default workspace is the shell directory that launched pnpm.

```bash
pnpm cockpit:dev -- doctor
pnpm cockpit:dev -- status --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- state --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- next --storage sqlite --sqlite .ledgermind/memory.sqlite
pnpm cockpit:dev -- task "recent decision" --storage sqlite --sqlite .ledgermind/memory.sqlite
```

Pass the same `--binding-store <path>` or `LEDGERMIND_MCP_BINDING_STORE` value that Claude Code uses when debugging a specific session.

## Current Limits

1. SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.
2. SQLite uses Node's built-in `node:sqlite` module and may emit `ExperimentalWarning` on supported Node 22 runtimes.
3. Some MCP hosts may still require explicit `conversationId` arguments if they do not pass LedgerMind session metadata.
4. `memory.expand` remains privileged and sub-agent scoped.
