# SQLite Persistence

SQLite is the preferred embedded backend for durable local LedgerMind memory, but it is not implemented in this alpha.

Until a SQLite adapter implements all persistence ports and passes cross-adapter conformance, local hooks must not claim durable memory without PostgreSQL. Claude Code hooks warn when `LEDGERMIND_DB_URL` is missing and the runtime falls back to in-memory storage.
