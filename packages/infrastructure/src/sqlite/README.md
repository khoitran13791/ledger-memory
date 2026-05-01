# SQLite Persistence

SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.

Use `.ledgermind/memory.sqlite` for workspace-local continuity, and keep `.ledgermind/session-bindings.json` stable so MCP clients, Claude Code hooks, and the cockpit CLI resolve the same LedgerMind conversation.

This adapter uses Node's built-in `node:sqlite` module, which Node currently labels experimental. Local commands may emit `ExperimentalWarning`; the SQLite implementation stays isolated behind LedgerMind's persistence ports.
