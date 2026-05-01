# Agent Continuity Layer

LedgerMind makes coding-agent work resumable, inspectable, and evidence-backed across context resets, compaction, and handoffs.

The continuity layer turns fragile chat history into durable operational state. It stores the facts an agent needs to resume work: goals, active decisions, constraints, progress, next steps, handoffs, verification, failures, open questions, and artifact changes.

## Current Limitations

- SQLite is the default local durable backend for coding-agent continuity. PostgreSQL remains the recommended backend for shared services, remote workers, and multi-process deployments.
- SQLite uses Node's built-in `node:sqlite` module and may emit `ExperimentalWarning` on supported Node 22 runtimes.
- Stop-time transcript extraction is bounded and redacted, but it is still heuristic. Prefer explicit `memory.createHandoff` records for important work.
- `memory.expand` is privileged because it can reveal compressed source context. Prefer `memory.recallForTask`, `memory.currentState`, and `memory.describe` first.

## Continuity Record Schema

A continuity record is stored as a ledger event with `metadata.kind = "continuity_record"`.

Fields:

- `recordId`: stable id, usually the idempotency key.
- `continuityKind`: `goal`, `decision`, `constraint`, `progress`, `next_step`, `handoff`, `verification`, `failure`, `open_question`, `artifact_change`, or `session_summary`.
- `status`: `active`, `stale`, `superseded`, or `resolved`.
- `importance`: `low`, `normal`, `high`, or `critical`.
- `title` and `content`: compact human-readable state.
- `provenance`: optional event ids, summary ids, artifact ids, transcript location, tool use id, or command.
- `relatedRecordIds`, `supersedesRecordIds`, `supersededByRecordId`: lifecycle links.

## Current-State Projection

`getCurrentState()` reads continuity ledger events and projects only active records by default. Later lifecycle records suppress older records when they supersede or mark a related record stale, resolved, or superseded.

Records are bucketed by kind:

- goals
- decisions
- constraints
- progress
- next steps
- handoffs
- verification
- failures
- open questions
- artifact changes
- session summaries

This projection is what humans see through CLI commands and what agents receive through recall.

## Handoff Shape

`createHandoff()` records a handoff plus one `next_step` record per next action.

A good handoff includes:

- goal
- completed work
- next steps
- decisions
- constraints
- open questions
- verification
- risks
- changed files

## Task-Start Recall

`recallForTask()` returns a compact block headed `LedgerMind current state`. It includes active operational state, relevant evidence references, and why the block was recalled. Claude Code can inject this at `SessionStart` and `UserPromptSubmit`; MCP clients can call `memory.recallForTask` directly.

Session resume should use this block instead of raw prior transcript.

## Tool Evidence Policy

Claude `PostToolUse` can write evidence when `LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE=true`.

Captured evidence:

- verification records for Bash commands containing `test`, `typecheck`, `lint`, `build`, `vitest`, or `tsc`
- artifact-change records for `Write`, `Edit`, and `MultiEdit`
- failure records for failed tool responses

Secrets are redacted before persistence for common API keys and database URLs. Tool output is truncated by `LEDGERMIND_CLAUDE_TOOL_OUTPUT_BUDGET_CHARS`.

## Staleness and Supersession

When decisions change, use `memory.markStale` or record a new decision with `supersedesRecordIds`. Active state should not include obsolete constraints or decisions unless explicitly requested with stale records included.

## Storage Recommendations

Use SQLite for local durable memory:

```bash
export LEDGERMIND_SQLITE_PATH=.ledgermind/memory.sqlite
```

Use a stable binding store per workspace:

```bash
export LEDGERMIND_MCP_BINDING_STORE=.ledgermind/session-bindings.json
```

Use PostgreSQL for shared services, remote workers, and multi-process deployments:

```bash
export LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind
export DATABASE_URL=$LEDGERMIND_DB_URL
pnpm --filter @ledgermind/infrastructure migrate:up
```

## MCP, CLI, and Claude Flows

MCP:

- read: `memory.currentState`, `memory.nextSteps`, `memory.recallForTask`, `memory.recall`, `memory.describe`
- privileged: `memory.expand`
- write: `memory.recordDecision`, `memory.recordConstraint`, `memory.recordProgress`, `memory.recordVerification`, `memory.createHandoff`, `memory.markStale`

CLI:

- `ledgermind state`
- `ledgermind next`
- `ledgermind task "current task"`
- `ledgermind decision "..." --content "..."`
- `ledgermind handoff ...`
- `ledgermind stale <recordId> --reason "..."`

Claude Code:

- `SessionStart`: resumes binding and injects current state when available.
- `UserPromptSubmit`: recalls state for the submitted task.
- `PreCompact`: archives transcript and injects compact state.
- `Stop`: creates a bounded handoff.
- `PostToolUse`: records verification, failures, and artifact changes when enabled.
