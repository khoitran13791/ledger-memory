# Amp Integration

## Status

LedgerMind currently supports Amp-style coding agents through the shared MCP server. This is intentionally MCP-first and does not rely on a bespoke Amp runtime package.

## What Works Today

1. `@ledgermind/mcp-server` exposes `memory.recall`, `memory.describe`, and `memory.expand` with the same semantics used by Claude Code.
2. Session bindings can persist to a local file so MCP clients can keep stable LedgerMind `ConversationId` values across restarts.
3. Read-first access control is enforced centrally, including sub-agent gating for `memory.expand`.

## Current Limits

1. This repo does not yet ship verified Amp lifecycle hooks equivalent to Claude Code's `PreCompact`, `Stop`, or `PostToolUse` hooks.
2. If your Amp host does not attach LedgerMind session metadata to MCP tool calls, provide `conversationId` explicitly for `memory.recall` and include the required `callerContext` for `memory.expand`.
3. Artifact indexing and transcript archival remain Claude-specific for now.

## Setup

1. Build the workspace or install the package dependencies with `pnpm install`.
2. Start the shared MCP server with `pnpm exec ledgermind-mcp-server --binding-store .ledgermind/session-bindings.json`.
3. Register the same command in your Amp MCP configuration using [`examples/ampcode/mcp-config.json`](../examples/ampcode/mcp-config.json).
4. Point the binding store at a stable workspace-local path if you want the same session mapping across restarts.

## Recommended Usage Pattern

1. Use MCP tools explicitly for recall and expansion instead of hiding retrieval in prompts.
2. Treat `memory.expand` as privileged raw-context access and reserve it for focused follow-up work.
3. Keep the binding store per workspace so one project cannot accidentally read another project's memory thread.
