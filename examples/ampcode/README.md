# Amp Example

This example intentionally uses the same LedgerMind MCP server as Claude Code.

## Use It

1. Install dependencies from the repo root with `pnpm install`.
2. Build the MCP server or rely on `pnpm exec` from the workspace root.
3. Copy the configuration in [`mcp-config.json`](./mcp-config.json) into your Amp MCP settings.
4. Keep the binding-store path stable per workspace if you want the same LedgerMind conversation to survive host restarts.

## Current Limitation

This example covers MCP tools only. The repository does not currently ship verified Amp lifecycle hooks for transcript archival or post-tool indexing.
