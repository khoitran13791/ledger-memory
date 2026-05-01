# Amp Example

This example intentionally uses the same LedgerMind MCP server as Claude Code.

## Use It

1. Install dependencies from the repo root with `pnpm install`.
2. Use `.ledgermind/memory.sqlite` for local durable storage.
3. Use PostgreSQL migrations only for shared service deployments: `pnpm --filter @ledgermind/infrastructure migrate:up`.
4. Use the local source config in this directory while developing, or build/install the MCP server before replacing it with a package-bin command.
5. Copy the configuration in [`mcp-config.json`](./mcp-config.json) into your Amp MCP settings.
6. Keep the binding-store path stable per workspace if you want the same LedgerMind conversation to survive host restarts.

Use `memory.recallForTask` at task start, write continuity through the enabled MCP tools, and mark stale records when decisions change.

SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.

SQLite uses Node's built-in `node:sqlite` module and may emit `ExperimentalWarning` on supported Node 22 runtimes.

## Current Limitation

This example covers MCP tools only. The repository does not currently ship verified Amp lifecycle hooks for transcript archival or post-tool indexing.
