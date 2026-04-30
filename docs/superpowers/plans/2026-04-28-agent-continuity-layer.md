# Agent Continuity Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LedgerMind the durable continuity layer for coding-agent work: resumable, inspectable, and evidence-backed across context resets, compaction, and handoffs.

**Architecture:** Keep the existing ledger events, context projection, summary DAG, artifacts, MCP server, Claude Code hooks, CLI, and SDK composition root. Add a typed continuity layer on top: continuity records are first stored as append-only ledger events with stable metadata, then read through application-level projections that expose current state, next steps, handoff, provenance, and task-start recall. Add storage indexes and an embedded local durable backend only after the event schema and projections are stable.

**Tech Stack:** TypeScript strict ESM, Node.js 22, pnpm workspaces, Vitest, Clean Architecture (`domain <- application <- adapters <- infrastructure <- sdk`), existing PostgreSQL and in-memory adapters, MCP stdio server, Claude Code lifecycle hooks, cockpit CLI.

---

## Product Contract

New positioning:

```text
LedgerMind makes coding-agent work resumable, inspectable, and evidence-backed across context resets, compaction, and handoffs.
```

The product is successful when a coding agent can answer these questions after a reset:

1. What is the active goal?
2. What was already done?
3. What decisions and constraints are still binding?
4. What failed or remains uncertain?
5. What exact next steps should I take?
6. Which files, commands, tool outputs, summaries, artifacts, and transcript spans support that state?
7. Which remembered facts are stale, superseded, or only historical?
8. Why did LedgerMind recall this item for the current task?

## Current Repo Context

LedgerMind already has the correct substrate:

- `packages/domain/src/entities/ledger-event.ts` defines append-only events with free-form metadata.
- `packages/domain/src/entities/summary-node.ts` supports summary nodes with `retrievalText` and artifact propagation.
- `packages/application/src/ports/driving/memory-engine.port.ts` exposes `append`, `materializeContext`, `runCompaction`, `grep`, `describe`, `expand`, `storeArtifact`, `exploreArtifact`, and operator APIs.
- `packages/application/src/use-cases/materialize-context.ts` already supports retrieval hints, diagnostics, artifact references, and summary references.
- `packages/adapters/src/tools/canonical-memory-tool-catalog.ts` exposes canonical MCP tools: `memory.recall`, `memory.describe`, `memory.expand`.
- `packages/mcp-server/src/session-binding.ts` binds runtime sessions to LedgerMind conversations and supports parent/child lineage.
- `packages/claude-code/src/commands/session-start.ts`, `pre-compact.ts`, `stop.ts`, and `post-tool-use.ts` already cover session binding, transcript archival, stop-time persistence, and optional edited-file artifact indexing.
- `packages/cli/src/cli.ts` has cockpit commands for status, doctor, remember, recall, timeline, explain, and source.
- `tests/probes` already has continuation and decision probes, but not full session-resume or handoff benchmarks.

Critical gaps:

- No first-class continuity record schema.
- No current-state projection.
- No structured handoff object.
- No task-start recall API that returns a compact, provenance-backed context block.
- No automatic `UserPromptSubmit` injection.
- Claude `SessionStart` only says the conversation resumed; it does not inject current state.
- `Stop` stores transcript path and last-assistant excerpt, but not goal, done, next, files, verification, risks, or open questions.
- `PostToolUse` only indexes edited files behind a flag; it does not record command/test evidence, read files, failures, screenshots, or tool output summaries.
- Default Claude/MCP storage can still be in-memory, which undermines the continuity promise.
- CLI cockpit is useful but not yet shaped around state, handoff, decisions, next steps, stale records, or "why recalled".

## Architectural Decision

V1 should store continuity records as typed ledger events, not as new domain entities.

Reasoning:

- The append-only ledger is already the strongest invariant.
- Ledger events already carry content, role, sequence, token count, timestamp, and metadata.
- We can ship typed application DTOs and projections without a schema migration on day one.
- Provenance can point to event IDs, summary IDs, artifact IDs, transcript paths, and tool-use IDs through metadata.
- A PostgreSQL metadata index can make this efficient without introducing a second source of truth.

The stable event metadata shape is:

```ts
{
  source: 'ledgermind-continuity' | 'claude-code' | 'ledgermind-cli' | string,
  kind: 'continuity_record',
  continuityKind:
    | 'goal'
    | 'decision'
    | 'constraint'
    | 'progress'
    | 'next_step'
    | 'handoff'
    | 'verification'
    | 'failure'
    | 'open_question'
    | 'artifact_change'
    | 'session_summary',
  recordId: string,
  status: 'active' | 'stale' | 'superseded' | 'resolved',
  importance: 'low' | 'normal' | 'high' | 'critical',
  provenance: {
    eventIds?: string[],
    summaryIds?: string[],
    artifactIds?: string[],
    transcriptPath?: string,
    transcriptLineStart?: number,
    transcriptLineEnd?: number,
    toolUseId?: string,
    command?: string
  },
  supersedesRecordIds?: string[],
  relatedRecordIds?: string[],
  workspaceScope?: string,
  branchScope?: string,
  runtimeSessionId?: string
}
```

Application code should expose strongly typed DTOs so callers do not need to hand-build this metadata.

## Target API

Extend the driving surface with continuity-specific methods:

```ts
interface MemoryEngine {
  recordContinuity(input: RecordContinuityInput): Promise<RecordContinuityOutput>;
  createHandoff(input: CreateHandoffInput): Promise<CreateHandoffOutput>;
  getCurrentState(input: GetCurrentStateInput): Promise<GetCurrentStateOutput>;
  getNextSteps(input: GetNextStepsInput): Promise<GetNextStepsOutput>;
  recallForTask(input: RecallForTaskInput): Promise<RecallForTaskOutput>;
  markContinuityRecord(input: MarkContinuityRecordInput): Promise<MarkContinuityRecordOutput>;
}
```

`recordContinuity()` is the generic engine method. MCP/CLI can still expose friendlier verbs like `memory.recordDecision`, `memory.recordProgress`, and `ledgermind decision`.

## File Structure

Create:

- `packages/application/src/ports/driving/continuity.port.ts` - DTOs for continuity records, current state, handoff, task recall, provenance, and lifecycle status.
- `packages/application/src/use-cases/record-continuity.ts` - append one typed continuity record through the existing append use case.
- `packages/application/src/use-cases/create-handoff.ts` - create a structured handoff record and optional next-step records.
- `packages/application/src/use-cases/get-current-state.ts` - derive current operational state from ledger events.
- `packages/application/src/use-cases/get-next-steps.ts` - return active next steps ordered for execution.
- `packages/application/src/use-cases/recall-for-task.ts` - combine current state, retrieval hints, and provenance into an agent-ready context block.
- `packages/application/src/use-cases/mark-continuity-record.ts` - append stale/superseded/resolved lifecycle records.
- `packages/application/src/use-cases/__tests__/record-continuity.test.ts`
- `packages/application/src/use-cases/__tests__/create-handoff.test.ts`
- `packages/application/src/use-cases/__tests__/get-current-state.test.ts`
- `packages/application/src/use-cases/__tests__/get-next-steps.test.ts`
- `packages/application/src/use-cases/__tests__/recall-for-task.test.ts`
- `packages/application/src/use-cases/__tests__/mark-continuity-record.test.ts`
- `packages/claude-code/src/continuity/transcript-continuity-extractor.ts` - deterministic transcript-to-handoff extractor.
- `packages/claude-code/src/commands/user-prompt-submit.ts` - Claude Code task-start recall hook.
- `tests/probes/fixtures/session-resume-handoff.fixture.ts`
- `tests/probes/fixtures/stale-decision.fixture.ts`
- `tests/probes/fixtures/verification-failure.fixture.ts`
- `tests/probes/fixtures/tool-evidence.fixture.ts`
- `docs/agent-continuity-layer.md` - product and architecture reference.

Modify:

- `packages/application/src/ports/driving/memory-engine.port.ts` - extend `MemoryEngine` with continuity methods or import `ContinuityEngine` and extend from it.
- `packages/application/src/index.ts` - export continuity DTOs and use cases.
- `packages/sdk/src/index.ts` - compose continuity use cases using existing append, materialize, grep, describe, and ledger read dependencies.
- `packages/adapters/src/tools/canonical-memory-tool-catalog.ts` - add read/write continuity tools.
- `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts` - cover new tool schemas and policy metadata.
- `packages/mcp-server/src/authorization.ts` - keep write tools behind explicit opt-in while allowing hooks to write directly.
- `packages/mcp-server/src/session-binding.ts` - apply bound conversation IDs to new continuity tools.
- `packages/mcp-server/src/__tests__/server.integration.test.ts` - cover current-state and record tools.
- `packages/claude-code/src/context.ts` - add `UserPromptSubmit` hook payload type.
- `packages/claude-code/src/runtime.ts` - route the new hook and reuse current session binding.
- `packages/claude-code/src/config.ts` - add flags for continuity injection and tool-evidence capture.
- `packages/claude-code/src/commands/session-start.ts` - inject current state and last handoff.
- `packages/claude-code/src/commands/stop.ts` - create a real handoff.
- `packages/claude-code/src/commands/pre-compact.ts` - include state/handoff summary after transcript archival.
- `packages/claude-code/src/commands/post-tool-use.ts` - capture tool evidence, command outcomes, and artifact changes.
- `packages/claude-code/package.json` - add `ledgermind-claude-user-prompt-submit` bin.
- `packages/cli/src/cli.ts` - add `state`, `next`, `handoff`, `decision`, `progress`, `verify`, `stale`, and task recall commands.
- `packages/cli/src/runtime.ts` - expose the continuity methods through the cockpit runtime.
- `packages/cli/src/__tests__/commands.test.ts` - cover human and JSON continuity command output.
- `packages/infrastructure/src/sql/postgres/migrations/0006_continuity_metadata_indexes.sql` - add metadata indexes for continuity projections.
- `packages/infrastructure/src/postgres/pg-ledger-store.ts` - add efficient metadata filtering only if the application port gains a query method.
- `docs/claude-code-integration.md` - update what the hooks inject and persist.
- `docs/agent-integration-architecture.md` - document continuity tools and why MCP stays canonical.
- `README.md` - lead with the new product promise and quickstart.
- `examples/claude-code/settings.json` or `packages/claude-code/src/templates/settings.json.example` - include `UserPromptSubmit` and continuity flags.

Do not modify:

- `packages/domain` for V1 unless a test proves domain-level invariants are needed. Continuity records can start as application DTOs over ledger event metadata.
- Summary DAG invariants, compaction levels, content-addressed ID rules, or artifact ID propagation semantics.

## Task 1: Add Continuity DTOs

**Files:**

- Create: `packages/application/src/ports/driving/continuity.port.ts`
- Modify: `packages/application/src/ports/driving/memory-engine.port.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/record-continuity.test.ts`

- [ ] **Step 1: Define record kinds, statuses, provenance, and DTOs**

Create `packages/application/src/ports/driving/continuity.port.ts` with exported types:

```ts
import type {
  ArtifactId,
  ConversationId,
  EventId,
  SummaryNodeId,
  Timestamp,
  TokenCount,
} from '@ledgermind/domain';

export type ContinuityRecordKind =
  | 'goal'
  | 'decision'
  | 'constraint'
  | 'progress'
  | 'next_step'
  | 'handoff'
  | 'verification'
  | 'failure'
  | 'open_question'
  | 'artifact_change'
  | 'session_summary';

export type ContinuityRecordStatus = 'active' | 'stale' | 'superseded' | 'resolved';
export type ContinuityImportance = 'low' | 'normal' | 'high' | 'critical';

export interface ContinuityProvenance {
  readonly eventIds?: readonly EventId[];
  readonly summaryIds?: readonly SummaryNodeId[];
  readonly artifactIds?: readonly ArtifactId[];
  readonly transcriptPath?: string;
  readonly transcriptLineStart?: number;
  readonly transcriptLineEnd?: number;
  readonly toolUseId?: string;
  readonly command?: string;
}

export interface ContinuityRecord {
  readonly recordId: string;
  readonly conversationId: ConversationId;
  readonly kind: ContinuityRecordKind;
  readonly status: ContinuityRecordStatus;
  readonly title: string;
  readonly content: string;
  readonly importance: ContinuityImportance;
  readonly provenance: ContinuityProvenance;
  readonly relatedRecordIds: readonly string[];
  readonly supersedesRecordIds: readonly string[];
  readonly createdAt: Timestamp;
  readonly eventId: EventId;
}

export interface RecordContinuityInput {
  readonly conversationId: ConversationId;
  readonly kind: ContinuityRecordKind;
  readonly title: string;
  readonly content: string;
  readonly importance?: ContinuityImportance;
  readonly status?: ContinuityRecordStatus;
  readonly provenance?: ContinuityProvenance;
  readonly relatedRecordIds?: readonly string[];
  readonly supersedesRecordIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly occurredAt?: Timestamp;
}

export interface RecordContinuityOutput {
  readonly record: ContinuityRecord;
  readonly contextTokenCount: TokenCount;
}
```

- [ ] **Step 2: Add handoff, current state, next-step, recall, and mark DTOs**

Extend the same file with these input/output contracts:

```ts
export interface HandoffNextStep {
  readonly title: string;
  readonly content: string;
  readonly importance?: ContinuityImportance;
  readonly provenance?: ContinuityProvenance;
}

export interface CreateHandoffInput {
  readonly conversationId: ConversationId;
  readonly goal: string;
  readonly completed: readonly string[];
  readonly nextSteps: readonly HandoffNextStep[];
  readonly decisions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly verification?: readonly string[];
  readonly risks?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly provenance?: ContinuityProvenance;
  readonly runtimeSessionId?: string;
  readonly idempotencyKey?: string;
}

export interface CreateHandoffOutput {
  readonly handoff: ContinuityRecord;
  readonly nextStepRecords: readonly ContinuityRecord[];
}

export interface GetCurrentStateInput {
  readonly conversationId: ConversationId;
  readonly includeStale?: boolean;
  readonly limitPerKind?: number;
}

export interface GetCurrentStateOutput {
  readonly goalRecords: readonly ContinuityRecord[];
  readonly decisions: readonly ContinuityRecord[];
  readonly constraints: readonly ContinuityRecord[];
  readonly progress: readonly ContinuityRecord[];
  readonly nextSteps: readonly ContinuityRecord[];
  readonly handoffs: readonly ContinuityRecord[];
  readonly verification: readonly ContinuityRecord[];
  readonly failures: readonly ContinuityRecord[];
  readonly openQuestions: readonly ContinuityRecord[];
  readonly artifactChanges: readonly ContinuityRecord[];
  readonly sessionSummaries: readonly ContinuityRecord[];
  readonly activeRecordCount: number;
  readonly staleRecordCount: number;
}

export interface GetNextStepsInput {
  readonly conversationId: ConversationId;
  readonly limit?: number;
}

export interface GetNextStepsOutput {
  readonly nextSteps: readonly ContinuityRecord[];
}

export interface RecallForTaskInput {
  readonly conversationId: ConversationId;
  readonly task: string;
  readonly budgetTokens: number;
  readonly includeHandoff?: boolean;
  readonly includeEvidence?: boolean;
}

export interface RecallForTaskOutput {
  readonly contextBlock: string;
  readonly currentState: GetCurrentStateOutput;
  readonly recalledSummaryIds: readonly SummaryNodeId[];
  readonly recalledArtifactIds: readonly ArtifactId[];
  readonly recalledEventIds: readonly EventId[];
  readonly why: readonly string[];
  readonly budgetUsed: TokenCount;
}

export interface MarkContinuityRecordInput {
  readonly conversationId: ConversationId;
  readonly recordId: string;
  readonly status: Exclude<ContinuityRecordStatus, 'active'>;
  readonly reason: string;
  readonly supersededByRecordId?: string;
  readonly idempotencyKey?: string;
}

export interface MarkContinuityRecordOutput {
  readonly marker: ContinuityRecord;
}
```

- [ ] **Step 3: Extend the engine port**

Modify `packages/application/src/ports/driving/memory-engine.port.ts` to import the new DTOs and add methods to `MemoryEngine`.

```ts
import type {
  CreateHandoffInput,
  CreateHandoffOutput,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  GetNextStepsInput,
  GetNextStepsOutput,
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  RecallForTaskInput,
  RecallForTaskOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
} from './continuity.port';
```

Add methods:

```ts
  recordContinuity(input: RecordContinuityInput): Promise<RecordContinuityOutput>;
  createHandoff(input: CreateHandoffInput): Promise<CreateHandoffOutput>;
  getCurrentState(input: GetCurrentStateInput): Promise<GetCurrentStateOutput>;
  getNextSteps(input: GetNextStepsInput): Promise<GetNextStepsOutput>;
  recallForTask(input: RecallForTaskInput): Promise<RecallForTaskOutput>;
  markContinuityRecord(input: MarkContinuityRecordInput): Promise<MarkContinuityRecordOutput>;
```

- [ ] **Step 4: Export the DTOs**

Modify `packages/application/src/index.ts` to export every type from `continuity.port.ts`.

- [ ] **Step 5: Run the focused typecheck**

Run:

```bash
pnpm --filter @ledgermind/application typecheck
```

Expected: TypeScript fails until the SDK engine implementation is updated. This is acceptable for this task if the failure is only missing `MemoryEngine` methods in tests/composition.

## Task 2: Implement `recordContinuity`

**Files:**

- Create: `packages/application/src/use-cases/record-continuity.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/record-continuity.test.ts`

- [ ] **Step 1: Write tests for record shape and idempotency**

Test cases:

- Reject blank title.
- Reject blank content.
- Default `importance` to `normal`.
- Default `status` to `active`.
- Append exactly one ledger event with metadata `kind: 'continuity_record'`.
- Preserve provenance references in metadata.
- Use supplied idempotency key.

- [ ] **Step 2: Implement content formatting**

Use a deterministic content format:

```text
[decision] Do not add new npm dependencies

We decided to avoid new npm dependencies for this utility work.
```

This keeps `grep` useful even before specialized continuity retrieval exists.

- [ ] **Step 3: Implement the use case as a wrapper over append**

`RecordContinuityUseCase` should accept:

```ts
export interface RecordContinuityUseCaseDeps {
  append(input: AppendLedgerEventsInput): Promise<AppendLedgerEventsOutput>;
  clock: ClockPort;
}
```

It should call the existing append pipeline, not bypass it. That preserves idempotency, sequence assignment, context projection, and compaction triggers.

- [ ] **Step 4: Generate `recordId` deterministically enough for retries**

For V1 use:

```ts
const recordId = input.idempotencyKey ?? `${input.kind}:${input.title.trim().toLowerCase()}`;
```

Then store it as metadata. If collision risk shows up in tests, replace this with a hashed record ID helper in this same task before merging.

- [ ] **Step 5: Wire SDK composition**

In `packages/sdk/src/index.ts`, instantiate `RecordContinuityUseCase` after `appendUseCase`, passing:

```ts
const recordContinuityUseCase = new RecordContinuityUseCase({
  append: (input) => appendUseCase.execute(input),
  clock,
});
```

Add `recordContinuity` to the returned engine.

- [ ] **Step 6: Run verification**

Run:

```bash
pnpm --filter @ledgermind/application test -- record-continuity
pnpm --filter @ledgermind/sdk typecheck
```

Expected: application tests pass and SDK compiles after all new `MemoryEngine` methods are stubbed or implemented.

## Task 3: Implement Current-State Projection

**Files:**

- Create: `packages/application/src/use-cases/get-current-state.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/get-current-state.test.ts`

- [ ] **Step 1: Write projection tests**

Create fixtures with mixed ledger events:

- active decision
- active constraint
- progress
- two next steps
- handoff
- stale marker for a previous record
- superseded marker for a previous decision

Assert:

- active records appear under the correct buckets.
- stale/superseded/resolved records are excluded by default.
- `includeStale: true` includes inactive records.
- records are sorted newest first except `nextSteps`, which are oldest first by sequence so the agent can continue in order.
- `limitPerKind` caps each bucket.

- [ ] **Step 2: Parse continuity records from ledger metadata**

`get-current-state.ts` should expose a local helper:

```ts
export const parseContinuityRecordFromEvent = (event: LedgerEvent): ContinuityRecord | null => { ... };
```

It must return `null` for non-continuity events and avoid throwing on malformed historical metadata.

- [ ] **Step 3: Apply lifecycle markers**

Lifecycle records written by `markContinuityRecord()` should affect the projection:

- stale marker removes the target record unless `includeStale` is true.
- superseded marker removes the target record and keeps the replacement record active.
- resolved marker removes the target record from active state.

- [ ] **Step 4: Keep V1 storage simple**

Use `ledgerRead.getEvents(conversationId)` for V1. Do not add a new driven port until tests show scanning is a bottleneck.

- [ ] **Step 5: Wire SDK**

Instantiate `GetCurrentStateUseCase` with `ledgerRead` and add `getCurrentState` to the engine.

- [ ] **Step 6: Run verification**

Run:

```bash
pnpm --filter @ledgermind/application test -- get-current-state
pnpm test -- tests/probes
```

Expected: new projection tests pass, existing probes keep passing.

## Task 4: Implement Next-Step Projection

**Files:**

- Create: `packages/application/src/use-cases/get-next-steps.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/get-next-steps.test.ts`

- [ ] **Step 1: Write tests**

Assert:

- only active `next_step` records are returned.
- default limit is `10`.
- ordering is oldest first by sequence.
- critical/high importance steps sort ahead of normal/low when sequence order is equal.

- [ ] **Step 2: Implement with current-state dependency**

Use case deps:

```ts
export interface GetNextStepsUseCaseDeps {
  getCurrentState(input: GetCurrentStateInput): Promise<GetCurrentStateOutput>;
}
```

- [ ] **Step 3: Wire SDK**

Instantiate after `getCurrentStateUseCase`.

- [ ] **Step 4: Run verification**

Run:

```bash
pnpm --filter @ledgermind/application test -- get-next-steps
pnpm --filter @ledgermind/sdk typecheck
```

## Task 5: Implement Structured Handoff

**Files:**

- Create: `packages/application/src/use-cases/create-handoff.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/create-handoff.test.ts`

- [ ] **Step 1: Write tests for handoff creation**

Assert:

- blank goal is rejected.
- handoff content includes goal, completed, next steps, decisions, constraints, open questions, verification, risks, and changed files when supplied.
- handoff record has `continuityKind: 'handoff'`.
- each supplied next step is also written as a `next_step` continuity record.
- provenance is copied to handoff and next-step records.
- idempotency key avoids duplicate handoff writes.

- [ ] **Step 2: Implement deterministic handoff content**

Format:

```text
[handoff] Continue: <goal>

Goal:
- <goal>

Completed:
- <item>

Next steps:
- <item>

Decisions:
- <item>

Constraints:
- <item>

Open questions:
- <item>

Verification:
- <item>

Risks:
- <item>

Changed files:
- <path>
```

Do not emit empty sections.

- [ ] **Step 3: Implement by calling `recordContinuity()`**

Use case deps:

```ts
export interface CreateHandoffUseCaseDeps {
  recordContinuity(input: RecordContinuityInput): Promise<RecordContinuityOutput>;
}
```

- [ ] **Step 4: Wire SDK**

Instantiate after `recordContinuityUseCase`.

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm --filter @ledgermind/application test -- create-handoff
pnpm --filter @ledgermind/sdk typecheck
```

## Task 6: Implement Task-Start Recall

**Files:**

- Create: `packages/application/src/use-cases/recall-for-task.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/recall-for-task.test.ts`

- [ ] **Step 1: Write tests**

Assert:

- returns a `contextBlock` under `budgetTokens`.
- includes active goal, decisions, constraints, latest handoff, verification, failures, open questions, and ordered next steps.
- calls `materializeContext()` with retrieval hint equal to the task.
- returns summary IDs, artifact IDs, event IDs, and a `why` list.
- degrades gracefully when no continuity records exist.

- [ ] **Step 2: Define context block format**

Use this exact section order:

```text
LedgerMind current state

Goal:
- ...

Next steps:
- ...

Decisions:
- ...

Constraints:
- ...

Progress:
- ...

Verification:
- ...

Failures and risks:
- ...

Open questions:
- ...

Evidence:
- summary <id>
- artifact <id>
- event <id>

Why recalled:
- ...
```

- [ ] **Step 3: Implement budget trimming**

Trim in this order:

1. old progress records
2. old session summaries
3. old handoffs except latest
4. verification details
5. open question details
6. evidence list details

Never drop active constraints, active decisions, the latest handoff title, or the first active next step unless they alone exceed budget.

- [ ] **Step 4: Wire SDK**

Instantiate with:

```ts
const recallForTaskUseCase = new RecallForTaskUseCase({
  getCurrentState: (input) => getCurrentStateUseCase.execute(input),
  materializeContext: (input) => materializeUseCase.execute(input),
  tokenizer,
});
```

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm --filter @ledgermind/application test -- recall-for-task
pnpm --filter @ledgermind/sdk typecheck
```

## Task 7: Implement Lifecycle Marking

**Files:**

- Create: `packages/application/src/use-cases/mark-continuity-record.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/mark-continuity-record.test.ts`

- [ ] **Step 1: Write tests**

Assert:

- stale marker records `continuityKind: 'session_summary'` or a dedicated marker kind if added to the DTO.
- marker content includes target record ID and reason.
- current-state projection excludes the target after marking.
- supplied `supersededByRecordId` is included in metadata.

- [ ] **Step 2: Implement marker as a continuity record**

Use `recordContinuity()` with:

```ts
kind: 'session_summary',
title: `Mark ${input.recordId} ${input.status}`,
content: `Record ${input.recordId} marked ${input.status}: ${input.reason}`,
status: input.status,
relatedRecordIds: [input.recordId],
```

- [ ] **Step 3: Add projection support**

Update `get-current-state.ts` lifecycle logic to interpret marker records by `relatedRecordIds`.

- [ ] **Step 4: Run verification**

Run:

```bash
pnpm --filter @ledgermind/application test -- mark-continuity-record get-current-state
```

## Task 8: Add Canonical MCP Continuity Tools

**Files:**

- Modify: `packages/adapters/src/tools/canonical-memory-tool-catalog.ts`
- Modify: `packages/adapters/src/tools/shared/input-parsers.ts`
- Modify: `packages/adapters/src/tools/shared/reference-derivation.ts`
- Test: `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts`

- [ ] **Step 1: Add read tools**

Add:

- `memory.currentState`
- `memory.nextSteps`
- `memory.recallForTask`

Policy:

```ts
access: 'read',
requiresApproval: false,
subAgentOnly: false,
idempotent: true
```

- [ ] **Step 2: Add write tools**

Add:

- `memory.recordDecision`
- `memory.recordConstraint`
- `memory.recordProgress`
- `memory.recordVerification`
- `memory.createHandoff`
- `memory.markStale`

Policy:

```ts
access: 'write',
requiresApproval: false,
subAgentOnly: false,
idempotent: true
```

The MCP server already hides write tools unless `--enable-write-tools` or `LEDGERMIND_MCP_ENABLE_WRITE_TOOLS` is enabled.

- [ ] **Step 3: Make schemas agent-friendly**

Every write tool must accept `conversationId`, `title`, `content`, optional `importance`, optional `provenance`, and optional `idempotencyKey`.

`memory.recallForTask` must accept:

```json
{
  "conversationId": "conv_...",
  "task": "Fix failing auth tests",
  "budgetTokens": 1200,
  "includeHandoff": true,
  "includeEvidence": true
}
```

- [ ] **Step 4: Return reference envelopes**

Use `toReferencedToolSuccessEnvelope()` for every tool. Include event IDs for written continuity records and summary/artifact IDs for recalled evidence.

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm --filter @ledgermind/adapters test -- canonical-memory-tool-catalog
pnpm --filter @ledgermind/adapters typecheck
```

## Task 9: Update MCP Binding and Authorization

**Files:**

- Modify: `packages/mcp-server/src/session-binding.ts`
- Modify: `packages/mcp-server/src/__tests__/session-binding.test.ts`
- Modify: `packages/mcp-server/src/__tests__/server.integration.test.ts`

- [ ] **Step 1: Apply session binding to new tools**

Update `applySessionBindingToToolArguments()` so it injects `conversationId` for:

- `memory.currentState`
- `memory.nextSteps`
- `memory.recallForTask`
- `memory.recordDecision`
- `memory.recordConstraint`
- `memory.recordProgress`
- `memory.recordVerification`
- `memory.createHandoff`
- `memory.markStale`

- [ ] **Step 2: Test no self-attestation**

Assert that a caller cannot spoof `conversationId` through `_meta` binding. For bound calls, the resolved binding wins.

- [ ] **Step 3: Test write-tool hiding**

With `enableWriteTools: false`, write tools must not appear in `listTools()` and direct calls must return `MCP_TOOL_ACCESS_DENIED`.

- [ ] **Step 4: Run verification**

Run:

```bash
pnpm --filter @ledgermind/mcp-server test
```

## Task 10: Add CLI Continuity Commands

**Files:**

- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/runtime.ts`
- Create: `packages/cli/src/commands/state.ts`
- Create: `packages/cli/src/commands/next.ts`
- Create: `packages/cli/src/commands/handoff.ts`
- Create: `packages/cli/src/commands/decision.ts`
- Create: `packages/cli/src/commands/progress.ts`
- Create: `packages/cli/src/commands/verify.ts`
- Create: `packages/cli/src/commands/stale.ts`
- Create: `packages/cli/src/commands/task.ts`
- Test: `packages/cli/src/__tests__/commands.test.ts`
- Test: `packages/cli/src/__tests__/cli.test.ts`

- [ ] **Step 1: Add commands to help text**

Add:

```text
  state               Show current operational state.
  next                Show active next steps.
  task <prompt>       Recall memory for a task start.
  handoff             Create a structured handoff from flags/stdin.
  decision <text>     Record a decision.
  progress <text>     Record progress.
  verify <text>       Record verification evidence.
  stale <record-id>   Mark a memory record stale.
```

- [ ] **Step 2: Add JSON-first command outputs**

Each command must support `--json` using the existing formatter pattern.

- [ ] **Step 3: Keep human output compact**

Human `state` output should look like:

```text
Current state
Goal
- ...
Next
- ...
Decisions
- ...
Constraints
- ...
Evidence
- ...
```

- [ ] **Step 4: Run verification**

Run:

```bash
pnpm --filter @ledgermind/cli test
pnpm cockpit:smoke
```

## Task 11: Implement Claude `UserPromptSubmit` Recall Injection

**Files:**

- Modify: `packages/claude-code/src/context.ts`
- Create: `packages/claude-code/src/commands/user-prompt-submit.ts`
- Modify: `packages/claude-code/src/runtime.ts`
- Modify: `packages/claude-code/src/config.ts`
- Modify: `packages/claude-code/package.json`
- Test: `packages/claude-code/src/__tests__/user-prompt-submit.test.ts`

- [ ] **Step 1: Add hook payload type**

Add `UserPromptSubmit` to `ClaudeHookName`.

Add:

```ts
export interface UserPromptSubmitHookContext extends ClaudeHookContextBase {
  readonly hookName: 'UserPromptSubmit';
  readonly prompt: string;
}
```

Parse `prompt` from the payload.

- [ ] **Step 2: Add config flags**

Add:

```ts
readonly continuityInjectionEnabled: boolean;
readonly continuityRecallBudgetTokens: number;
```

Environment:

- `LEDGERMIND_CLAUDE_ENABLE_CONTINUITY_INJECTION=true`
- `LEDGERMIND_CLAUDE_RECALL_BUDGET_TOKENS=1200`

- [ ] **Step 3: Implement command behavior**

`runUserPromptSubmitCommand()` should:

1. build runtime.
2. resolve binding.
3. call `engine.recallForTask({ conversationId, task: context.prompt, budgetTokens })`.
4. write `additionalContext` containing `output.contextBlock`.

If disabled, it should return no extra context and exit successfully.

- [ ] **Step 4: Add package bin**

Add:

```json
"ledgermind-claude-user-prompt-submit": "dist/commands/user-prompt-submit.js"
```

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm --filter @ledgermind/claude-code test -- user-prompt-submit
pnpm --filter @ledgermind/claude-code typecheck
```

## Task 12: Upgrade Claude SessionStart and Stop Into Real Continuity

**Files:**

- Create: `packages/claude-code/src/continuity/transcript-continuity-extractor.ts`
- Modify: `packages/claude-code/src/commands/session-start.ts`
- Modify: `packages/claude-code/src/commands/stop.ts`
- Modify: `packages/claude-code/src/commands/pre-compact.ts`
- Test: `packages/claude-code/src/__tests__/session-start.test.ts`
- Test: `packages/claude-code/src/__tests__/stop.test.ts`
- Test: `packages/claude-code/src/__tests__/pre-compact.test.ts`

- [ ] **Step 1: Add deterministic transcript extractor**

Create a small extractor that returns:

```ts
export interface ExtractedContinuityHandoff {
  readonly goal: string;
  readonly completed: readonly string[];
  readonly nextSteps: readonly string[];
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
  readonly verification: readonly string[];
  readonly risks: readonly string[];
  readonly changedFiles: readonly string[];
}
```

Heuristics:

- lines containing "next", "todo", "remaining", or "follow up" become next-step candidates.
- lines containing "decided", "decision", "we will", or "we chose" become decisions.
- lines containing "must", "cannot", "do not", "constraint", or "requirement" become constraints.
- lines containing "passed", "failed", "test", "typecheck", "lint", or "verify" become verification.
- edited artifact paths from metadata become changed files.
- fallback goal is `Continue work from Claude Code session <sessionId>`.

- [ ] **Step 2: SessionStart injects state**

Update `session-start.ts` so `additionalContext` includes:

```text
LedgerMind resumed conversation <id>.

<recallForTask context block using task "Resume this coding session">
```

If `getCurrentState` has no records, keep the existing concise resumed message.

- [ ] **Step 3: Stop creates a handoff**

After appending transcript events, call `engine.createHandoff()` with extractor output and transcript provenance.

Keep the existing defensive stop event, but make the handoff the primary continuity artifact.

- [ ] **Step 4: PreCompact includes current state**

After compaction, call `recallForTask()` with task `Continue after Claude Code compaction` and include its context block in `additionalContext`.

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm --filter @ledgermind/claude-code test
pnpm claude:hook:precompact:smoke
pnpm claude:hook:stop:smoke
```

Expected smoke commands still require hook payloads; existing smoke behavior should remain documented if they intentionally fail without stdin.

## Task 13: Capture Tool Evidence

**Files:**

- Modify: `packages/claude-code/src/commands/post-tool-use.ts`
- Modify: `packages/claude-code/src/config.ts`
- Test: `packages/claude-code/src/__tests__/post-tool-use.test.ts`

- [x] **Step 1: Add evidence config**

Add:

- `LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE=true`
- `LEDGERMIND_CLAUDE_TOOL_OUTPUT_BUDGET_CHARS=2000`

- [x] **Step 2: Capture more tool classes**

Classify:

- editing tools: `Write`, `Edit`, `MultiEdit`
- shell tool: `Bash`
- read/search tools: `Read`, `Grep`, `Glob`, `LS`
- delegation tools: `Task`

- [x] **Step 3: Record evidence as continuity records**

For `Bash`, record a `verification` record when command includes `test`, `typecheck`, `lint`, `build`, `vitest`, or `tsc`.

For edit tools, record an `artifact_change` record with normalized workspace paths.

For failed tool responses, record a `failure` record with the tool name and short output summary.

- [x] **Step 4: Keep secrets out of summaries**

Before writing tool evidence, redact values matching:

- `sk-[A-Za-z0-9_-]+`
- `ghp_[A-Za-z0-9_]+`
- `postgres://[^\\s]+`
- `mongodb(\\+srv)?://[^\\s]+`
- `AKIA[0-9A-Z]{16}`

- [x] **Step 5: Run verification**

Run:

```bash
pnpm --filter @ledgermind/claude-code test -- post-tool-use
pnpm --filter @ledgermind/claude-code typecheck
```

## Task 14: Add PostgreSQL Continuity Indexes

**Files:**

- Create: `packages/infrastructure/src/sql/postgres/migrations/0006_continuity_metadata_indexes.sql`
- Test: `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

- [x] **Step 1: Add metadata indexes**

Migration up:

```sql
BEGIN;

CREATE INDEX IF NOT EXISTS idx_ledger_events_continuity_kind
  ON ledger_events(conversation_id, ((metadata ->> 'continuityKind')))
  WHERE metadata ->> 'kind' = 'continuity_record';

CREATE INDEX IF NOT EXISTS idx_ledger_events_continuity_record_id
  ON ledger_events(conversation_id, ((metadata ->> 'recordId')))
  WHERE metadata ->> 'kind' = 'continuity_record';

CREATE INDEX IF NOT EXISTS idx_ledger_events_metadata_gin
  ON ledger_events USING GIN (metadata);

COMMIT;
```

Migration down drops these indexes.

- [x] **Step 2: Do not add SQL outside infrastructure**

Keep all SQL in the migration and existing PostgreSQL adapter files.

- [x] **Step 3: Run migration tests**

Run:

```bash
pnpm --filter @ledgermind/infrastructure test
```

## Task 15: Make Local Durability Frictionless

**Files:**

- Create: `packages/infrastructure/src/sqlite/*`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/mcp-server/src/config.ts`
- Modify: `packages/claude-code/src/config.ts`
- Modify: `packages/cli/src/config.ts`
- Test: `tests/conformance/persistence/*.conformance.ts`

- [x] **Step 1: Decide the embedded backend**

Preferred implementation if dependency policy allows it: SQLite with FTS5 and WAL.

If avoiding a native dependency is required for the alpha, use a file-backed JSONL store only for continuity records and keep full engine persistence PostgreSQL-only. The product should not claim full durable local memory until SQLite or an equivalent embedded backend passes conformance.

Implementation note: SQLite/full local durability is deferred for the alpha because no embedded dependency exists in the repo yet. Hooks now make the in-memory fallback explicit instead of claiming durable local memory.

- [ ] **Step 2: Implement all persistence ports**

SQLite must implement:

- `ConversationPort`
- `LedgerAppendPort`
- `LedgerReadPort`
- `ContextProjectionPort`
- `SummaryDagPort`
- `ArtifactStorePort`
- `UnitOfWorkPort`
- `OperatorExecutionPort` if operator continuity is included in the local promise.

- [x] **Step 3: Keep SQLite out of conformance until implemented**

Do not extend conformance to SQLite until all persistence ports exist. For the alpha, keep conformance on the implemented in-memory and PostgreSQL adapters and document SQLite as deferred.

Run:

```bash
pnpm vitest run tests/conformance --exclude '**/.tmp/**' --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**'
```

- [x] **Step 4: Make non-durable fallback explicit**

Claude Code should default to `.ledgermind/memory.sqlite` once SQLite exists. Until then, durable hook memory requires PostgreSQL through `LEDGERMIND_DB_URL`.

Until SQLite exists, hooks should warn when `LEDGERMIND_DB_URL` is missing:

```text
LedgerMind continuity is using in-memory storage; records will not survive process exit. Set LEDGERMIND_DB_URL for durable memory.
```

## Task 16: Add Continuity Probe Benchmarks

**Files:**

- Modify: `tests/probes/shared/probe-fixture.ts`
- Modify: `tests/probes/shared/run-probe-scenario.ts`
- Create: `tests/probes/fixtures/session-resume-handoff.fixture.ts`
- Create: `tests/probes/fixtures/stale-decision.fixture.ts`
- Create: `tests/probes/fixtures/verification-failure.fixture.ts`
- Create: `tests/probes/fixtures/tool-evidence.fixture.ts`
- Modify: `tests/probes/fixtures/index.ts`
- Modify: `tests/probes/shared/judge-scorer.ts`

- [x] **Step 1: Add probe type**

Add:

```ts
export type ProbeType =
  | 'recall'
  | 'artifact'
  | 'continuation'
  | 'decision'
  | 'tool_usage'
  | 'handoff'
  | 'staleness'
  | 'verification';
```

- [x] **Step 2: Simulate two sessions**

Extend `run-probe-scenario.ts` to support a fixture with:

```ts
sessionA: { events: ...; stopHandoff: ... }
sessionB: { question: ... }
```

Session B must only receive `recallForTask()` output and materialized context, not raw session A transcript.

- [x] **Step 3: Add fixtures**

Fixtures:

- `session-resume-handoff`: validates that the next task after reset is correct.
- `stale-decision`: validates superseded decisions are not treated as active.
- `verification-failure`: validates failed tests are remembered as blocking evidence.
- `tool-evidence`: validates a command/test/file reference is returned with provenance.

- [x] **Step 4: Run probes**

Run:

```bash
pnpm vitest run tests/probes
```

Gate for this direction:

- continuation probes pass.
- decision probes pass.
- handoff probes pass.
- staleness probes pass.
- verification probes pass.

## Task 17: Documentation and Positioning

**Files:**

- Create: `docs/agent-continuity-layer.md`
- Modify: `README.md`
- Modify: `docs/agent-integration-architecture.md`
- Modify: `docs/claude-code-integration.md`
- Modify: `docs/testing-strategy.md`
- Modify: `examples/ampcode/README.md`
- Modify: `examples/claude-code/.mcp.json` if present
- Modify: `packages/claude-code/src/templates/settings.json.example`
- Modify: `packages/claude-code/src/templates/CLAUDE.md.example`

- [x] **Step 1: Update README lead**

The first paragraph should lead with:

```text
LedgerMind makes coding-agent work resumable, inspectable, and evidence-backed across context resets, compaction, and handoffs.
```

Then explain ledger, DAG, artifacts, MCP, hooks, and CLI as implementation.

- [x] **Step 2: Add a continuity architecture doc**

`docs/agent-continuity-layer.md` should include:

- product promise
- current limitations
- continuity record schema
- current-state projection rules
- handoff shape
- task-start recall shape
- tool evidence policy
- staleness/supersession semantics
- storage recommendations
- MCP/CLI/Claude flows

- [x] **Step 3: Update Claude setup**

Docs must show:

- durable storage setup
- MCP server config
- `UserPromptSubmit`
- `SessionStart`
- `PreCompact`
- `Stop`
- `PostToolUse`
- recommended `CLAUDE.md` instructions:

```text
At task start, read LedgerMind current state or use memory.recallForTask.
After important decisions, constraints, progress, verification, failures, and next steps, record continuity.
Before stopping, create a handoff with done, next, risks, verification, and changed files.
```

- [x] **Step 4: Run docs checks**

Run:

```bash
pnpm format
```

## Task 18: Distribution and Agent UX

**Files:**

- Modify: `packages/claude-code/src/templates/settings.json.example`
- Modify: `packages/claude-code/src/templates/CLAUDE.md.example`
- Create: `examples/continuity/README.md`
- Create: `examples/continuity/claude-code-settings.json`
- Create: `examples/continuity/mcp.json`

- [x] **Step 1: Create one-copy example**

Example must show a local agent harness with:

- durable storage configured.
- MCP write tools enabled.
- continuity injection enabled.
- tool evidence enabled.
- CLI commands for inspecting state.

- [x] **Step 2: Add agent-facing instructions**

The instructions should be short and operational:

```text
Use LedgerMind to preserve operational state.
Record decisions, constraints, progress, verification, failures, next steps, and handoffs.
Prefer memory.recallForTask at task start.
Use memory.describe or memory.expand only when the current state references compressed evidence.
Mark stale records when decisions change.
```

- [x] **Step 3: Run package smoke checks**

Run:

```bash
pnpm mcp:smoke
pnpm cockpit:smoke
pnpm --filter @ledgermind/claude-code typecheck
```

## Milestone Order

1. **Continuity Core:** Tasks 1-7.
2. **Agent/Human Surfaces:** Tasks 8-10.
3. **Claude Automation:** Tasks 11-13.
4. **Durability and Performance:** Tasks 14-15.
5. **Evaluation:** Task 16.
6. **Positioning and Distribution:** Tasks 17-18.

## Acceptance Criteria

LedgerMind reaches the stated goal when:

- A session can stop, restart, and resume from a structured handoff without raw chat history.
- `recallForTask()` returns a compact state block with decisions, constraints, next steps, evidence, and reasons.
- Humans can inspect the same state through CLI without understanding summary DAG internals.
- MCP callers can record and read continuity records through stable tools.
- Claude Code can inject relevant continuity at session start and prompt submission.
- Tool evidence captures verification, failures, and artifact changes.
- Stale and superseded records do not pollute active current state.
- Durable local setup is not dependent on a manually managed Postgres instance for the default developer experience.
- Continuity probes pass across in-memory and PostgreSQL, and SQLite once implemented.

## Risks

- **Too many tools:** Prefer generic engine methods and friendly adapter tools. Keep tool descriptions short and schemas strict.
- **Over-recording:** Hooks should capture compact evidence summaries, not dump every tool output into active context.
- **False current truth:** Staleness and supersession must be visible early, or agents will obey obsolete constraints.
- **Storage friction:** Postgres-only durability is too much for the default coding-agent harness use case.
- **Privacy:** Tool output and transcripts may include secrets. Redaction must happen before continuity records are written.
- **Evaluation gap:** LOCOMO/LongMemEval do not prove coding-agent handoff quality. Session-resume probes are required.

## First Build Recommendation

Ship the narrow wedge first:

1. `recordContinuity`
2. `createHandoff`
3. `getCurrentState`
4. `recallForTask`
5. `memory.recallForTask`
6. `ledgermind state`
7. Claude `UserPromptSubmit`
8. Stop-time structured handoff
9. session-resume-handoff probe

This is the smallest slice that makes the new product promise real without rewriting the engine.
