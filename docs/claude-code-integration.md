# Claude Code Integration

## Status

LedgerMind now ships an MCP-first Claude Code foundation with two runtime-facing packages.

1. `@ledgermind/mcp-server` exposes the canonical memory tool catalog over stdio MCP.
2. `@ledgermind/claude-code` provides lifecycle commands for `SessionStart`, `PreCompact`, `Stop`, and optional `PostToolUse` indexing.

## What Works Today

1. `memory.recall`, `memory.describe`, and `memory.expand` are exposed through the shared MCP server.
2. Claude lifecycle hooks can bind a Claude session to a stable LedgerMind `ConversationId` using the same file-backed binding store format as the MCP server.
3. `PreCompact` archives the JSONL transcript idempotently before Claude compacts its own context.
4. `Stop` persists a bounded session-closing reference block instead of replaying the whole transcript.
5. `PostToolUse` can index edited workspace files as artifacts when `LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING=true`.

## Package Responsibilities

| Package | Responsibility |
| --- | --- |
| `@ledgermind/mcp-server` | MCP transport, authorization, tool registration, session binding |
| `@ledgermind/claude-code` | Claude hook payload parsing and lifecycle automation |
| `@ledgermind/adapters` | Canonical tool semantics and policy metadata |

## Hook Behavior

### SessionStart

`ledgermind-claude-session-start` resolves or creates the runtime binding and emits a small status block containing the active LedgerMind conversation reference.

### PreCompact

`ledgermind-claude-pre-compact` reads the hook payload from stdin, parses the Claude transcript JSONL file, appends those events with a stable idempotency key, runs soft compaction, and returns a short `additionalContext` summary for Claude's post-compaction session.

### Stop

`ledgermind-claude-stop` appends a bounded closing note with transcript provenance and a truncated last-assistant excerpt, then runs soft compaction.

### PostToolUse

`ledgermind-claude-post-tool-use` is conservative by default. It only runs when artifact indexing is enabled and only stores paths from `Write`, `Edit`, or `MultiEdit` payloads that stay inside the active workspace.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `LEDGERMIND_DB_URL` | Use PostgreSQL instead of the in-memory engine preset |
| `LEDGERMIND_MCP_BINDING_STORE` | Shared file path for runtime/session bindings |
| `LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS` | Character budget used for bounded summaries and stop-time excerpts |
| `LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING` | Enables `PostToolUse` artifact storage |
| `LEDGERMIND_CLAUDE_USER_SCOPE` | Overrides the default user scope (`USER`/`LOGNAME`) |
| `LEDGERMIND_CLAUDE_WORKSPACE_SCOPE` | Overrides the workspace scope derived from `cwd` |
| `LEDGERMIND_CLAUDE_BRANCH_SCOPE` | Optional branch-level binding scope |
| `LEDGERMIND_CLAUDE_PARENT_SESSION_ID` | Optional parent runtime session for sub-agent lineage |

## Local Setup

1. Install dependencies with `pnpm install`.
2. Register the MCP server using [`examples/claude-code/.mcp.json`](../examples/claude-code/.mcp.json).
3. Add Claude hook commands using [`examples/claude-code/settings.json`](../examples/claude-code/settings.json) or the package templates in `packages/claude-code/src/templates/`.
4. Keep the binding-store path stable per workspace so the hooks and MCP server resolve the same LedgerMind conversation.

## Current Limits

1. This foundation does not yet implement automatic `UserPromptSubmit` memory injection.
2. `memory.recall` still depends on the runtime providing a `conversationId`; hook-driven binding continuity solves archival and session mapping, but some MCP hosts may still require explicit `conversationId` arguments.
3. `memory.expand` remains privileged and sub-agent scoped.
