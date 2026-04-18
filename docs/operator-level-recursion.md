# Operator-Level Recursion

LedgerMind exposes two durable recursion operators on `MemoryEngine`:

- `llmMap()` — run one structured generation per item
- `agenticMap()` — run one child-conversation task per item
- `getOperatorRun()` — inspect durable run state, task state, and finalized output handles

These APIs are **submit-first**. They return a durable `runId` immediately and persist execution state in the operator store. Final ordered outputs are inspected later through `getOperatorRun()`.

## Execution Modes

LedgerMind supports two operator execution modes:

- **Durable** (default): submit the run, persist tasks, and let a worker claim and execute them.
- **Inline**: used for tests and local development. Submission still persists the same durable run/task records, but the SDK immediately drains execution in-process before returning.

```ts
import { createInMemoryMemoryEngine } from '@ledgermind/sdk';

const durableEngine = createInMemoryMemoryEngine();

const inlineEngine = createInMemoryMemoryEngine({
  operators: {
    executionMode: 'inline',
    structuredGeneration,
    subAgentExecutor,
    delegationScopeResolver,
  },
});
```

Inline mode requirements:

- `llmMap()` inline execution requires `operators.structuredGeneration`
- `agenticMap()` inline execution requires `operators.structuredGeneration`, `operators.subAgentExecutor`, and `operators.delegationScopeResolver`

## `llmMap()`

`llmMap()` runs a stateless structured generation for each item in a dataset.

```ts
interface LLMMapInput {
  conversationId: ConversationId;
  prompt: string;
  outputSchema: Readonly<Record<string, unknown>>;
  concurrencyLimit: number;
  retryPolicy: {
    maxRetries: number;
    retryBackoffSeconds: number;
  };
  idempotencyKey?: string;
  items?: readonly unknown[];
  inputArtifactId?: ArtifactId;
}

interface LLMMapOutput {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'completed_with_failures' | 'failed';
  inputArtifactId?: ArtifactId;
}
```

Rules:

- Provide **exactly one** of `items` or `inputArtifactId`
- inline datasets larger than `maxInlineOperatorInputBytes` are rejected and must be stored as artifacts first
- `concurrencyLimit` must be within the application-owned operator config ceiling
- `retryPolicy.maxRetries >= 0`
- `retryPolicy.retryBackoffSeconds > 0`
- submit returns a durable `runId`; final results are read through `getOperatorRun()`

If `items` are supplied inline, LedgerMind stores the canonical JSON dataset as an input artifact before creating tasks.

### Zero-item behavior

Zero-item `llmMap()` submissions are valid:

- the run is finalized immediately
- status becomes `completed`
- the output artifact is an empty JSONL payload
- no worker execution is required
- callers still inspect the finalized run through `getOperatorRun()`

## `agenticMap()`

`agenticMap()` runs each item inside a child conversation with durable child reuse across retries.

```ts
interface AgenticMapInput {
  conversationId: ConversationId;
  taskPrompt: string;
  delegatedScope: {
    messageIds?: readonly string[];
    summaryIds?: readonly string[];
    artifactIds?: readonly ArtifactId[];
    note?: string;
  };
  keptWork: {
    description: string;
    expectedOutput: string;
  };
  outputSchema: Readonly<Record<string, unknown>>;
  concurrencyLimit: number;
  retryPolicy: {
    maxRetries: number;
    retryBackoffSeconds: number;
  };
  idempotencyKey?: string;
  items?: readonly unknown[];
  inputArtifactId?: ArtifactId;
}

interface AgenticMapOutput {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'completed_with_failures' | 'failed';
  inputArtifactId?: ArtifactId;
}
```

Additional rules:

- `delegatedScope` is required and must contain at least one parent-owned reference or a note
- `keptWork.description` is required and must stay under `maxKeptWorkChars`
- child-originated recursive `agenticMap()` calls still need explicit `delegatedScope` and `keptWork`
- final ordered results are still read through `getOperatorRun()`

Current repo adaptations relative to Appendix C:

- LedgerMind does not currently expose standalone `Task()` / `Tasks()` APIs; nested delegation is represented through child-originated `agenticMap()` calls
- Appendix C.2's `read_only` control is not yet modeled on `agenticMap()` or the child-execution port, so child mutability remains runtime-owned today

### Delegated scope

`delegatedScope` is the explicit slice of parent context handed to a child task. It can include:

- parent message ids
- parent summary ids
- parent artifact ids
- an optional task-local note

The resolver snapshots that scope once during child bootstrap. Large delegated content should become child-local artifacts rather than duplicated parent context.

### Kept work

`keptWork` is the compact parent-side handle for delegated work. It should describe:

- what the child is expected to return
- the durable operator/task handle
- compact progress or provenance metadata

It should **not** duplicate the delegated payload. Full delegated and finalized data live in artifacts and child conversations.

### Child bootstrap and retry-safe reuse

Each `agenticMap` task maps to at most one child conversation.

Durable bootstrap semantics:

- the task stores `childConversationId` once and reuses it on every retry
- bootstrap state persists as `bootstrap_not_started`, `bootstrap_in_progress`, or `bootstrap_completed`
- if a worker crashes after child creation but before bootstrap completes, the next worker reuses the same child and finishes bootstrap
- child execution does not start until bootstrap is marked complete
- parent-side `expand()` checks actual conversation lineage rather than trusting model-controlled payloads, and only permits summaries owned by the child conversation or its direct parent

## `getOperatorRun()`

`getOperatorRun()` is the canonical inspection API for durable operator state.

```ts
interface GetOperatorRunInput {
  runId: string;
}

interface GetOperatorRunOutput {
  runId: string;
  conversationId: ConversationId;
  operatorKind: 'llmMap' | 'agenticMap';
  status: 'pending' | 'running' | 'completed' | 'completed_with_failures' | 'failed';
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt?: Timestamp;
  inputArtifactId?: ArtifactId;
  outputArtifactId?: ArtifactId;
  taskCount: number;
  succeededTaskCount: number;
  failedTaskCount: number;
  retryableFailureTaskCount: number;
  runningTaskCount: number;
  pendingTaskCount: number;
  terminalFailureSummary?: OperatorFailureMetadata;
  inlineResults?: readonly OperatorResultEntry[];
  tasks: readonly OperatorTaskInspection[];
}
```

Inspection semantics:

- `tasks` always expose per-item durable state
- `inlineResults` are only returned when the finalized JSONL payload fits under `maxInlineRunResultsBytes`
- large finalized result sets must be read from `outputArtifactId`
- `agenticMap()` tasks may expose `childConversationId` for audit and follow-up inspection

## Worker Execution Model

The worker package lives in `apps/operator-worker`.

Important runtime behavior:

- polling is the correctness mechanism
- queue wake-up hints are optional accelerators only
- each poll iteration drains claimable tasks before attempting finalization retries
- expired running-task leases can be reclaimed by another worker
- finalization retries are idempotent and resume from persisted stages
- `JobQueuePort` uses `subscribe(type, handler)` rather than completion callbacks

### Startup commands

Repo entrypoints:

```bash
pnpm worker:operator
pnpm worker:operator:test
pnpm --filter @ledgermind/operator-worker test -- --run src/__tests__/config.test.ts
```

The worker package also exports programmatic APIs:

- `parseOperatorWorkerConfig()`
- `validateOperatorWorkerRuntime()`
- `createOperatorWorker()`
- `runCli()`

### Runtime requirements

The worker fails fast when required runtime executors are missing.

At minimum:

- durable `llmMap` processing requires `structuredGeneration`
- durable `agenticMap` processing additionally requires `subAgentExecutor` and `delegationScopeResolver`

The bare CLI in this repo is a thin entrypoint around the worker package. Production hosts are expected to inject their concrete runtime executors when constructing the worker.

## Minimal Local Workflow

Durable mode:

1. create or choose a conversation
2. call `llmMap()` or `agenticMap()` and keep the returned `runId`
3. start an operator worker process for your host environment
4. poll `getOperatorRun({ runId })` until the run reaches a terminal status
5. read `outputArtifactId` if `inlineResults` are omitted

Inline mode:

1. create the engine with `operators.executionMode: 'inline'`
2. inject the required runtime executors
3. call `llmMap()` or `agenticMap()`
4. inspect the durable run through `getOperatorRun()` exactly as you would in durable mode

## Tool Surface

The Vercel adapter exposes operator-related tools:

- `memory.llmMap`
- `memory.agenticMap`
- `memory.getOperatorRun`

It also keeps the existing conversation-bound read tools:

- `memory.grep`
- `memory.describe`
- `memory.expand`

Tool-runtime behavior:

- conversation-bound tools derive ownership from runtime caller context rather than model payloads
- `memory.getOperatorRun` rejects runs owned by a different conversation than the bound runtime caller
- submit tools return compact durable handles such as `runId`, `status`, and artifact references
- `memory.getOperatorRun` returns a compact summary plus provenance references instead of dumping full `inlineResults` or `tasks` into context

## Known V1 Limits

V1 intentionally does **not** include:

- cancellation semantics
- a generic workflow engine or DAG orchestrator beyond `llmMap` and `agenticMap`
- hosted control planes or dashboards
- human review checkpoints
- cross-conversation summary/message references outside explicit delegation
