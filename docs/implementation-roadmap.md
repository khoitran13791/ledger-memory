# LedgerMind × Claude Code: Implementation Roadmap

> **Target: Claude Code as first-class integration**
> Date: March 3, 2026 | Based on: HLD §19 + Claude Code Integration Guide

---

## Current State Assessment

**Implemented through:** HLD Phase 1 → PostgreSQL adapter (item 4 of 9)

### ✅ Already Implemented

| # | HLD Phase 1 Deliverable | Status | Package |
|---|------------------------|--------|---------|
| 1 | Domain model + value objects | ✅ Complete | `domain` |
| 2 | Port interfaces (all driving + driven) | ✅ Complete | `application/ports` |
| 3 | Core use cases (Append, Materialize, Compaction, Grep, Describe, Expand, StoreArtifact, ExploreArtifact, CheckIntegrity) | ✅ Complete | `application/use-cases` |
| 4 | PostgreSQL adapter (full schema + migrations) | ✅ Complete | `infrastructure/postgres` |

**Supporting work also complete:**

| Component | Status | Package |
|-----------|--------|---------|
| In-memory storage adapters (all 6 ports) | ✅ Complete | `adapters/storage/in-memory` |
| Deterministic summarizer (L3 fallback) | ✅ Complete | `adapters/llm` |
| Sub-agent authorization adapter | ✅ Complete | `adapters/auth` |
| Explorer registry + Fallback explorer | ✅ Complete | `adapters/explorers` |
| In-memory job queue | ✅ Complete | `adapters/jobs` |
| Testing doubles (FixedClock, DeterministicSummarizer, SimpleTokenizer) | ✅ Complete | `adapters/testing` |
| Application errors | ✅ Complete | `application/errors` |

### ❌ Remaining Phase 1 (HLD items 5–9)

| # | HLD Phase 1 Deliverable | Status | Notes |
|---|------------------------|--------|-------|
| 5 | Basic tokenizer (simple estimator + tiktoken) | ⚠️ Partial | `SimpleTokenizerAdapter` exists; tiktoken binding not yet |
| 6 | 5 core explorers (TS, Python, JSON, Markdown, Fallback) | ⚠️ Partial | Only Fallback explorer exists |
| 7 | SDK entrypoint (`createMemoryEngine()` factory) | ⚠️ Partial | In-memory works; Postgres wiring throws |
| 8 | Vercel AI SDK adapter | ❌ Not started | No framework tool adapters exist |
| 9 | Golden test suite | ⚠️ Partial | Tests exist but suite may not cover full golden transcript flow |

### ❌ Not Yet Implemented (beyond Phase 1)

| Component | Notes |
|-----------|-------|
| LLM-based summarizer (L1/L2) | Only deterministic L3 exists |
| MCP server package | Does not exist |
| Claude Code hooks | Does not exist |
| Claude Code plugin | Does not exist |
| Framework tool adapters (LangChain, OpenAI) | Does not exist |
| SQLite adapter | Not started |

---

## Roadmap: Claude Code First

Reorganized from HLD Phase 1/2/3 to prioritize **Claude Code integration** as the primary consumer.

---

### Sprint 1 — Finish Phase 1 Core + LLM Summarizer (2–3 weeks)

> **Goal:** Complete remaining HLD Phase 1 items (5–9) and add LLM-based summarization so `createMemoryEngine()` works end-to-end.

| # | Task | HLD Item | Package | Depends On | Deliverable |
|---|------|----------|---------|-----------|-------------|
| 1.1 | Add tiktoken binding to tokenizer adapter | Phase 1 #5 | `adapters/tokenizer` | — | Accurate token counting alongside simple estimator |
| 1.2 | Implement `TypeScriptExplorer` (`.ts`, `.tsx`, `.js`, `.jsx`) | Phase 1 #6 | `adapters/explorers` | — | AST-based: exports, classes, functions, imports |
| 1.3 | Implement `PythonExplorer` (`.py`) | Phase 1 #6 | `adapters/explorers` | — | AST-based: classes, functions, imports |
| 1.4 | Implement `JsonExplorer` (`.json`) | Phase 1 #6 | `adapters/explorers` | — | Schema shape, key structure, array lengths |
| 1.5 | Implement `MarkdownExplorer` (`.md`) | Phase 1 #6 | `adapters/explorers` | — | Heading structure, section summaries |
| 1.6 | Register 4 new explorers in `createDefaultExplorerRegistry()` | Phase 1 #6 | `adapters/explorers` | 1.2–1.5 | Auto-resolution by MIME/extension |
| 1.7 | Wire Postgres adapters in `createMemoryEngine()` | Phase 1 #7 | `sdk` | — | `{ storage: 'postgres', connectionString }` works |
| 1.8 | Implement `AnthropicSummarizerAdapter` (L1 normal + L2 aggressive) | New | `adapters/llm` | — | `SummarizerPort` backed by Claude API |
| 1.9 | Add summarizer config to `MemoryEngineConfig` | Phase 1 #7 | `sdk` | 1.8 | `{ summarizer: { type: 'anthropic', model, apiKey } }` |
| 1.10 | Golden test suite: deterministic DAG evolution tests (see `docs/testing-strategy.md` → “Phase 1 Golden Suite Implementation Plan (Core Engine)”) | Phase 1 #9 | `tests` | 1.7 | Fixed transcript → full pipeline → assert DAG state |
| 1.11 | Integration test: full compaction loop with LLM summarizer | New | `tests` | 1.8, 1.7 | Append → soft compact → materialize round-trip |
| 1.12 | Implement `OpenAISummarizerAdapter` (optional, for flexibility) | New | `adapters/llm` | — | Alternative LLM backend |

**Deferred from Phase 1:** Vercel AI SDK adapter (HLD #8) — moved to Sprint 5+ since Claude Code integration uses MCP, not Vercel tools directly.

**Exit criteria:**
- 5 core explorers (TS, Python, JSON, Markdown, Fallback) pass conformance tests
- `createMemoryEngine({ storage: 'postgres', summarizer: { type: 'anthropic' } })` works
- Compaction loop with L1→L2→L3 escalation produces valid DAG
- Golden test suite validates deterministic DAG evolution
- All existing tests still pass

---

### Sprint 2 — MCP Server (2 weeks)

> **Goal:** `npx @ledgermind/mcp-server` works with Claude Code CLI / VS Code.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 2.1 | Create `packages/mcp-server` package scaffold | `mcp-server` | — | `package.json`, `tsconfig.json`, entry point |
| 2.2 | Implement stdio MCP server with `@modelcontextprotocol/sdk` | `mcp-server` | — | Server bootstrap, transport setup |
| 2.3 | Register `memory_grep` tool | `mcp-server` | 2.2 | Regex search across ledger + DAG |
| 2.4 | Register `memory_describe` tool | `mcp-server` | 2.2 | Metadata for summary/artifact IDs |
| 2.5 | Register `memory_expand` tool | `mcp-server` | 2.2 | Retrieve original messages under summary |
| 2.6 | Register `memory_store` tool | `mcp-server` | 2.2 | Persist content to ledger |
| 2.7 | Register `memory_recall` tool | `mcp-server` | 2.2 | FTS search across summary DAG |
| 2.8 | Session/conversation management | `mcp-server` | 2.2 | Auto-create/resume conversations per session |
| 2.9 | CLI flags & env config | `mcp-server` | 2.2 | `--db`, `--model`, `LEDGERMIND_DB_URL` |
| 2.10 | Manual E2E test with Claude Code | `mcp-server` | 2.1–2.9 | `claude mcp add ledgermind` → use tools |

**MCP server tool mapping:**

```
memory_grep    → engine.grep()
memory_describe → engine.describe()
memory_expand  → engine.expand()
memory_store   → engine.append() (wraps content as ledger event)
memory_recall  → engine.grep() with FTS fallback
```

**Exit criteria:**
- `claude mcp add --transport stdio ledgermind -- npx @ledgermind/mcp-server --db postgres://...` works
- Claude can call all 5 memory tools during a session
- `.mcp.json` config works for team sharing

---

### Sprint 3 — Claude Code Hooks (1–2 weeks)

> **Goal:** Transparent memory injection/archival via Claude Code hooks.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 3.1 | Create `packages/hooks` package scaffold | `hooks` | — | Package structure |
| 3.2 | `PreCompact` hook — archive transcript to ledger | `hooks` | Sprint 2 | Full transcript persisted before Claude's compaction |
| 3.3 | `Stop` hook — persist session summary | `hooks` | Sprint 2 | End-of-session compaction + summary node |
| 3.4 | `UserPromptSubmit` hook — inject relevant memories | `hooks` | Sprint 2 | `additionalContext` with past session memories |
| 3.5 | `PostToolUse` hook — index file changes (async) | `hooks` | Sprint 2 | File edits tracked as artifacts in ledger |
| 3.6 | Shell script wrappers for CLI hooks | `hooks` | 3.2–3.5 | `ledgermind inject-context`, `ledgermind archive-transcript`, etc. |
| 3.7 | `settings.json` template for hook config | `hooks` | 3.6 | Copy-paste config for Claude Code users |
| 3.8 | CLAUDE.md template with memory instructions | `hooks` | Sprint 2 | Memory-aware system prompt additions |

**Hook flow:**

```
SessionStart   → (no hook needed; MCP server handles init)
UserPromptSubmit → Inject relevant memories via additionalContext
PostToolUse    → Index file changes as artifacts (async, Write|Edit matcher)
PreCompact     → Archive FULL transcript → run LedgerMind compaction → inject summary
Stop           → Persist session state → soft compaction → create session summary
```

**Exit criteria:**
- PreCompact hook archives full transcript before Claude's built-in compaction
- UserPromptSubmit injects relevant past memories
- Stop hook creates a session summary in the DAG
- Shell hooks work with `claude code` CLI via `settings.json`

---

### Sprint 4 — Extended Explorers (1–2 weeks)

> **Goal:** Broader file type coverage beyond the 5 core explorers from Sprint 1.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 4.1 | `CsvExplorer` (`.csv`) | `adapters/explorers` | — | Column names, row count, distributions |
| 4.2 | `GoExplorer` (`.go`) | `adapters/explorers` | — | Package, type, function signatures |
| 4.3 | `RustExplorer` (`.rs`) | `adapters/explorers` | — | `struct`, `impl`, `fn` extraction |
| 4.4 | `SqlExplorer` (`.sql`) | `adapters/explorers` | — | Statement types, table references |
| 4.5 | `YamlExplorer` (`.yaml`, `.yml`) | `adapters/explorers` | — | Key structure, nested depth |
| 4.6 | `LogExplorer` (`.log`) | `adapters/explorers` | — | Pattern detection, error frequency |
| 4.7 | `ImageExplorer` (`.png`, `.jpg`, etc.) | `adapters/explorers` | — | Dimensions, format, basic metadata |
| 4.8 | Register all in `createDefaultExplorerRegistry()` | `adapters/explorers` | 4.1–4.7 | Auto-resolution by MIME/extension |
| 4.9 | Explorer conformance tests (golden inputs) | `tests/conformance` | 4.1–4.7 | Each explorer produces expected structure |

**Exit criteria:**
- 12 total explorers (5 core from Sprint 1 + 7 new + Fallback)
- All pass conformance tests
- `engine.exploreArtifact()` resolves correct explorer by file extension

---

### Sprint 5 — Plugin & Distribution (1–2 weeks)

> **Goal:** One-line install for Claude Code teams.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 5.1 | Create `ledgermind-plugin` package structure | `plugin` | Sprint 2, 3 | `.claude-plugin/plugin.json`, bundled MCP + hooks |
| 5.2 | `/recall` slash command | `plugin/commands` | Sprint 2 | `/recall <query>` → memory search |
| 5.3 | `/memory-status` slash command | `plugin/commands` | Sprint 2 | Show conversation count, DAG stats |
| 5.4 | `memory-aware-coding` skill (SKILL.md) | `plugin/skills` | Sprint 2 | Auto-recall at task start, persist decisions |
| 5.5 | `memory-reviewer` sub-agent | `plugin/agents` | Sprint 2 | Specialized agent for memory relevance review |
| 5.6 | CLAUDE.md integration instructions | `plugin` | Sprint 3 | Team onboarding docs |
| 5.7 | npm publish pipeline | CI | 5.1–5.6 | `@ledgermind/mcp-server`, `@ledgermind/sdk` on npm |

**Plugin structure:**
```
ledgermind-plugin/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json              # Bundled MCP server config
├── commands/
│   ├── recall.md           # /recall <query>
│   └── memory-status.md    # /memory-status
├── agents/
│   └── memory-reviewer.md
├── skills/
│   └── memory-aware-coding/
│       └── SKILL.md
└── hooks/
    ├── inject-context.sh
    ├── archive-transcript.sh
    └── persist-session.sh
```

**Exit criteria:**
- Plugin installs with one command
- `/recall`, `/memory-status` slash commands work
- Skill auto-triggers for coding tasks
- Team can share via repo `.claude-plugin/` directory

---

### Sprint 6 — Claude Agent SDK Adapter (1–2 weeks)

> **Goal:** Programmatic integration for custom agent builders.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 6.1 | Create `packages/claude-agent-adapter` | `claude-agent-adapter` | Sprint 2 | Package scaffold |
| 6.2 | In-process MCP server via `createSdkMcpServer()` | `claude-agent-adapter` | 6.1 | No subprocess overhead |
| 6.3 | Programmatic hooks (TS callbacks) | `claude-agent-adapter` | 6.1 | `injectMemories`, `archiveBeforeCompact`, `persistOnStop`, `indexFileChanges` |
| 6.4 | System prompt builder (preset + append) | `claude-agent-adapter` | 6.1 | Memory-aware system prompt |
| 6.5 | `createLedgerMindAgent()` factory | `claude-agent-adapter` | 6.2–6.4 | One-call setup: MCP + hooks + prompt + engine |
| 6.6 | Session continuity (resume, fork) | `claude-agent-adapter` | 6.5 | Cross-session memory via `continueConversation` |
| 6.7 | Example: autonomous coding agent with memory | `examples` | 6.5 | Working end-to-end example |

**Factory API:**
```typescript
import { createLedgerMindAgent } from "@ledgermind/claude-agent-adapter";

const agent = await createLedgerMindAgent({
  db: "postgres://localhost/ledgermind",
  summarizer: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
});

for await (const msg of agent.query("Fix the auth bug")) {
  console.log(msg);
}
```

**Exit criteria:**
- `createLedgerMindAgent()` returns a fully wired agent with memory
- Agent auto-recalls at task start, auto-persists on stop
- PreCompact hook archives full transcript
- Works with Claude Agent SDK TypeScript

---

### Sprint 7 — SQLite & Hardening (2 weeks)

> **Goal:** Embedded storage for local dev; production hardening.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 7.1 | SQLite adapter (all 6 persistence ports) | `infrastructure/sqlite` | — | FTS5, recursive CTE, WAL mode |
| 7.2 | Contract tests: same suite runs PG + SQLite | `tests` | 7.1 | Verified substitutability |
| 7.3 | `createMemoryEngine({ storage: 'sqlite' })` | `sdk` | 7.1 | Zero-config local memory |
| 7.4 | MCP server `--db sqlite:///path` support | `mcp-server` | 7.3 | Local-first Claude Code setup |
| 7.5 | Observation masking (pre-summarization filtering) | `application` | — | Rule-based content filtering |
| 7.6 | 10+ more explorers (Go, Rust, SQL, YAML, Log, etc.) | `adapters/explorers` | — | Broader file type coverage |
| 7.7 | Backpressure / rate limiting for compaction | `application` | — | Production compaction scheduling |
| 7.8 | Structured logging + metrics via `ObservabilityPort` | `infrastructure` | — | `compaction_rounds_total`, `context_utilization_ratio`, etc. |

**Exit criteria:**
- SQLite works as drop-in alternative for local dev
- All contract tests pass on both PG and SQLite
- `npx @ledgermind/mcp-server --db sqlite://~/.ledgermind/memory.db` works

---

### Sprint 8 — HTTP Server & Multi-Session (Phase 3 start, 2+ weeks)

> **Goal:** Shared memory across agents/sessions/teams.

| # | Task | Package | Depends On | Deliverable |
|---|------|---------|-----------|-------------|
| 8.1 | HTTP MCP server transport | `mcp-server` | Sprint 2 | `--transport http --port 8765` |
| 8.2 | Multi-tenancy (per-user schema isolation) | `infrastructure` | 8.1 | Auth headers, tenant routing |
| 8.3 | Cross-session conversation linking | `sdk` | — | Resume conversation by ID across sessions |
| 8.4 | MCP server HTTP config in `.mcp.json` | `mcp-server` | 8.1 | `{ type: "http", url: "https://..." }` |
| 8.5 | Python SDK (thin HTTP client) | `python-sdk` | 8.1 | `pip install ledgermind` |
| 8.6 | Optional vector index add-on | `adapters/vector` | — | Semantic recall alongside DAG |

---

## Package Delivery Summary

| Sprint | Packages Shipped | npm Packages |
|--------|-----------------|--------------|
| 1 | `sdk` (postgres), `adapters/llm` (Anthropic), `adapters/explorers` (5 core), `adapters/tokenizer` (tiktoken) | — (internal) |
| 2 | `mcp-server` | `@ledgermind/mcp-server` |
| 3 | `hooks` | `@ledgermind/hooks` |
| 4 | `adapters/explorers` (10+ more) | — (internal) |
| 5 | `plugin` | `ledgermind-plugin` |
| 6 | `claude-agent-adapter` | `@ledgermind/claude-agent-adapter` |
| 7 | `infrastructure/sqlite`, hardening | `@ledgermind/sdk` (v1.0) |
| 8 | HTTP server, Python SDK | `@ledgermind/mcp-server-http`, `ledgermind` (PyPI) |

---

## Critical Path

```
Sprint 1 (Finish Phase 1 + LLM Summarizer) ← YOU ARE HERE
    │
    ▼
Sprint 2 (MCP Server) ──────────────► Sprint 5 (Plugin)
    │                                      │
    ▼                                      ▼
Sprint 3 (Hooks) ─────────────────► Sprint 6 (Agent SDK Adapter)
    │
    ▼
Sprint 4 (More Explorers)
    │
    ▼
Sprint 7 (SQLite + Hardening)
    │
    ▼
Sprint 8 (HTTP + Multi-Session)
```

**Minimum viable Claude Code integration = Sprint 1 + 2 + 3** (~5–7 weeks from current state)

---

## Quick Start After Sprint 3

### For Claude Code CLI users:

```bash
# 1. Install MCP server
claude mcp add --transport stdio ledgermind -- \
  npx @ledgermind/mcp-server --db postgres://localhost/ledgermind

# 2. Add hooks to .claude/settings.json
# (copy from @ledgermind/hooks template)

# 3. Add to CLAUDE.md
echo '## Long-Term Memory (LedgerMind)
Use `mcp__ledgermind__memory_recall` at task start.
Use `mcp__ledgermind__memory_store` after key decisions.' >> CLAUDE.md

# 4. Use Claude Code normally — memory is now persistent
```
