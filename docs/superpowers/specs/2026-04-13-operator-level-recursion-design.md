# Operator-Level Recursion And Durable Execution Design

## Goal

Implement the full documented scope for operator-level recursion in LedgerMind by adding durable `llmMap` and `agenticMap` execution, recursive child-conversation delegation, background-worker processing, and delegation safety rules without breaking the existing memory-engine architecture.

## Problem Statement

LedgerMind already implements the core LCM memory model: append-only ledger storage, active-context projection, hierarchical summary DAG compaction, artifact storage, and retrieval tools. The missing documented scope is operator-level recursion: the ability to run parallel itemized work durably, retry safely, delegate bounded scopes to child agent conversations, and materialize compact handles instead of flooding parent context.

The implementation must satisfy the existing design docs while preserving clean architecture boundaries:

- Domain remains framework-agnostic.
- Application owns business semantics and ports.
- Adapters map runtime/tool concerns.
- Infrastructure owns durable storage, SQL, worker wiring, and queue integration.
- SDK remains the public composition root.

## Scope

### In Scope

- Public `MemoryEngine` support for `llmMap` and `agenticMap`.
- Durable run/task persistence for operator execution.
- Queue-triggered background worker execution with DB-backed claiming, leasing, retries, and finalization.
- Child-conversation delegation for `agenticMap` with explicit `delegated_scope` and `kept_work` semantics.
- Structured output validation for both operator types.
- Input/output artifact handling for large payloads.
- Authorization and lineage enforcement for recursive delegation.
- In-memory and Postgres implementations of new persistence contracts.
- Tool exposure for recursion operators where appropriate.
- Tests for retries, duplicate delivery, race conditions, lineage, and ordered result reduction.

### Out Of Scope

- Generic workflow-engine abstractions beyond documented recursion operators.
- Cross-conversation summary or message references.
- Hosted orchestration, SaaS control planes, or multi-tenant scheduling.
- Human-in-the-loop review workflows.
- Rich dashboard or run-monitoring UI.

## Design Principles

1. **Database is the source of truth.** Queue delivery is at-least-once; execution state, claims, retries, and finalization are owned by persistence.
2. **Conversations remain the unit of memory isolation.** Parent and child conversations do not share context pointers.
3. **Delegation is explicit and bounded.** Child scope is snapshotted from declared references, not inherited implicitly.
4. **Artifacts carry large data.** Parent context stores handles and summaries, not full task payloads or full result sets.
5. **Do not build a generic workflow engine.** Implement exactly the recursion capabilities documented: `llmMap` and `agenticMap`.
6. **Runtime-specific execution stays behind ports.** Application defines semantics; adapters and infrastructure bind actual LLMs, sub-agent runtimes, workers, and queues.

## High-Level Architecture

### New Application Use Cases

- `LLMMapUseCase`
- `AgenticMapUseCase`
- `ExecuteOperatorTaskUseCase`
- `FinalizeOperatorRunUseCase`
- `GetOperatorRunUseCase`

### New Driven Ports

- `OperatorExecutionPort`
  - create runs and tasks
  - claim leased tasks
  - persist per-attempt progress
  - record success/failure
  - discover and claim runs needing finalization retry
  - finalize ordered output
  - query run/task state
- `StructuredGenerationPort`
  - accepts one item, prompt, output schema, and timeout
  - returns validated structured JSON or typed failure
  - does not mutate run/task persistence or artifact state
- `SubAgentExecutorPort`
  - executes an already-created, already-bootstrapped child conversation to a structured terminal result
  - accepts `childConversationId`, execution constraints, output schema, and timeout
  - does not create conversations, resolve delegated scope, or append bootstrap events
- `DelegationScopeResolverPort`
  - resolves `delegated_scope` references into a pure child-bootstrap payload
  - returns bootstrap events, child-local artifacts to create, and source-reference metadata
  - does not mutate conversations or persistence directly

### Existing Components Reused

- `ConversationPort` for parent/child lineage
- `ArtifactStorePort` for large inputs/outputs and result artifacts
- `LedgerAppendPort`, `LedgerReadPort`, `ContextProjectionPort`, and `SummaryDagPort` inside child conversations
- `JobQueuePort` as a trigger mechanism only
- `AuthorizationPort` for privileged operations such as `expand`

## Operator Semantics

### `llmMap`

`llmMap` runs a stateless structured generation for each item in a dataset.

Input requirements:
- items or input artifact reference
- prompt/instructions
- output JSON schema
- concurrency limit
- retry policy
- optional idempotency key

Submit validation rules for v1:
- exactly one of `items` or `inputArtifactId` is required
- `items` must be a JSON array
- `inputArtifactId` must resolve to an artifact in the same conversation and use the v1 dataset format: one JSON array payload
- `prompt` must be non-empty and bounded by application config
- `outputSchema` must be a non-empty JSON-schema object payload and bounded by application config
- `concurrencyLimit` must be an integer in `1..maxConcurrencyLimit`
- retry policy fields must satisfy `maxRetries >= 0` and `retryBackoffSeconds > 0`
- inline `items` payload must stay under `maxInlineOperatorInputBytes`; otherwise submission is rejected and artifact-backed input is required

Zero-item behavior for v1:
- submitting a zero-item dataset is valid
- the run is finalized immediately without worker execution
- final status is `completed`
- output artifact contains an empty ordered result set
- the parent still receives a compact result handle

Execution behavior:
1. Persist the full input dataset as an artifact if raw items are supplied inline.
2. Create a durable operator run and one task per item.
3. Queue tasks for workers.
4. Each task claims a lease, executes one structured generation, validates output, retries if allowed, and persists a terminal result.
5. When all tasks are terminal, finalize the run into an ordered JSONL artifact and compact run-level summary handle.

Return contract:
- `llmMap()` is an asynchronous submit operation, not a wait-for-completion call
- it returns `runId`, initial run status, and any immediately available metadata such as input artifact ID
- final ordered results, output artifact ID, and failures are obtained through `getOperatorRun()` after worker finalization
- inline execution mode used in tests/local dev may complete synchronously, but it must still persist and expose the same run/task records

### `agenticMap`

`agenticMap` runs each item in a child conversation with tool access and recursive delegation support.

Input requirements:
- items or input artifact reference
- task prompt
- output JSON schema
- explicit `delegated_scope`
- explicit `kept_work`
- concurrency limit
- retry policy
- optional idempotency key

Submit validation rules for v1:
- exactly one of `items` or `inputArtifactId` is required
- `items` must be a JSON array
- `inputArtifactId` must resolve to an artifact in the same conversation and use the v1 dataset format: one JSON array payload
- `taskPrompt` must be non-empty and bounded by application config
- `outputSchema` must be a non-empty JSON-schema object payload and bounded by application config
- `delegated_scope` is required and must be non-empty for recursive child-originated delegation
- `kept_work.description` is required and non-empty
- `concurrencyLimit` must be an integer in `1..maxConcurrencyLimit`
- retry policy fields must satisfy `maxRetries >= 0` and `retryBackoffSeconds > 0`
- inline `items` payload must stay under `maxInlineOperatorInputBytes`; otherwise submission is rejected and artifact-backed input is required

Zero-item behavior for v1 matches `llmMap`:
- submitting a zero-item dataset is valid
- no child conversations are created
- the run is finalized immediately as `completed`
- output artifact contains an empty ordered result set
- the parent still receives a compact result handle

Execution behavior:
1. Persist the input dataset as an artifact if needed.
2. Create durable run/task records.
3. For each task, create or reuse a child conversation with `parentId` pointing to the parent conversation.
4. Resolve and snapshot the declared `delegated_scope` into child-local bootstrap events and/or artifacts.
5. Execute the child task via `SubAgentExecutorPort`.
6. Validate the final child output against the declared schema.
7. Persist task results and finalize the run into an ordered JSONL artifact.

Return contract matches `llmMap`: `agenticMap()` submits a durable run and returns `runId` plus initial metadata, while final ordered results are read through `getOperatorRun()`. Each task may also expose `childConversationId` for inspection and auditing.

## Delegation Model

### `delegated_scope`

`delegated_scope` is the bounded slice of work handed to a child. It must be explicit. It may contain:
- message IDs from the parent conversation
- summary IDs from the parent conversation
- artifact IDs from the parent conversation
- an optional task-local note or instruction block

Resolution rules:
- scope must reference entities that belong to the parent conversation
- references are resolved once at delegation time
- resolved content is copied or summarized into the child conversation as bootstrap context
- large delegated content should be stored as child-local artifacts and referenced compactly in the child context

### `kept_work`

`kept_work` is the compact description of what remains in the caller after delegation. It is not a second copy of the delegated context. It must remain small and should usually contain:
- run ID or task ID
- child conversation ID once created
- expected output contract
- current status and output artifact once complete

V1 contract for `kept_work`:
- required fields: a non-empty description plus expected output contract
- maximum size: bounded by `maxKeptWorkChars` in application-owned operator config
- invalid when it embeds raw delegated payloads beyond that ceiling

### Delegation Guard

The system must reject recursive delegation requests that do not provide a non-empty `kept_work` description.

V1 defines no exemption path. The required behavior is:
- root conversations may initiate operator runs without proving prior delegation lineage
- child conversations may recursively delegate only if they declare both `delegated_scope` and `kept_work`
- read-only retrieval tools remain governed by existing authorization and conversation boundaries

## Child Conversation Bootstrapping

Application owns child lifecycle and bootstrap in v1.

When `agenticMap` creates a child conversation, it should bootstrap that conversation with:

1. a system event describing child role and constraints
2. a user or assistant event containing the delegated task prompt
3. scope-derived bootstrap events and/or child-local artifact references
4. metadata linking the child to the operator run/task and source references

Retry-safe child reuse rules for v1:
- reuse key is `taskId`; one operator task maps to at most one child conversation
- `operator_tasks.child_conversation_id` is assigned once and reused on every retry
- bootstrap completion must be persisted explicitly so retries can distinguish `bootstrap_not_started`, incomplete bootstrap, and completed bootstrap
- if a worker crashes after child creation but before bootstrap completes, the next attempt must reuse the same child and finish bootstrap instead of creating a second child
- bootstrap appends must be idempotent via deterministic append idempotency keys or an equivalent append-once mechanism
- child execution must not start until bootstrap is marked complete

Durable bootstrap-state contract for v1:
- each operator task persists `bootstrap_state` with values `bootstrap_not_started | bootstrap_in_progress | bootstrap_completed`
- `OperatorExecutionPort` must provide primitives to read current bootstrap state, mark bootstrap started, and mark bootstrap completed
- assigning `child_conversation_id` and transitioning out of `bootstrap_not_started` must be durable so retries never create a second child for the same task

This preserves existing conversation-local invariants:
- compaction stays local to the child
- `expand` stays local to the child
- DAG integrity checks remain conversation-scoped
- materialization continues to work without cross-conversation logic

## Durable Execution Model

### Source Of Truth

The database owns durable execution state. Workers are replaceable executors.

Queue semantics:
- queue messages may be duplicated
- queue messages may be delivered late
- queue ordering is not trusted
- queue is not the result backend

Persistence semantics:
- task claims use leases or equivalent conditional updates
- duplicate deliveries become no-ops when a claim cannot be obtained
- completion writes are conditional so only the first terminal transition wins
- retries are scheduled from durable state

### Recommended Run Lifecycle

Run states for v1:
- `pending`
- `running`
- `completed`
- `completed_with_failures`
- `failed`

Task states for v1:
- `pending`
- `running`
- `retryable_failure`
- `succeeded`
- `failed`

Terminal run-state rules for v1:
- `completed` means every task succeeded
- `completed_with_failures` means the run finalized successfully and produced an ordered output artifact, but one or more tasks ended in terminal failure entries
- `failed` means the run did not finalize successfully and therefore produced no valid finalized output artifact; this is reserved for irrecoverable run-level setup/finalization failure, not for an all-failed-but-successfully-finalized task set

Finalization contract for v1:
- `completed` and `completed_with_failures` both produce a finalized output artifact
- the finalized artifact is ordered by `item_index` and includes one entry per input item
- each line uses the same discriminated result-entry shape as `GetOperatorRunOutput.inlineResults`
- succeeded entries contain structured result payloads or result-artifact references
- failed entries contain terminal failure metadata instead of structured output
- an all-failed task set still becomes `completed_with_failures` if finalization succeeds and the ordered artifact is written
- `failed` run state means no valid finalized output artifact could be produced; the parent still receives a compact failure handle with run status and diagnostic metadata
- parent-handle append is required for every terminal run state, including total failure

V1 finalized JSONL result-entry shape:
- success entry: `itemIndex`, `taskId`, `status: "succeeded"`, optional `childConversationId`, and exactly one of `output` or `outputArtifactId`
- failure entry: `itemIndex`, `taskId`, `status: "failed"`, optional `childConversationId`, and `error { code, message, retryable: false, attemptCount }`
- exactly one line is written per input item
- lines are sorted by ascending `itemIndex`

Cancellation is explicitly out of v1 execution semantics. If needed later, it should be added as a separate design increment affecting run state, task state, tool contracts, and worker shutdown behavior.

### Claiming And Leasing

Workers should claim tasks by conditional transition from claimable states to `running` with:
- `leaseOwner`
- `leaseExpiresAt`
- incremented `attemptCount`

A task is claimable when:
- it is `pending`, or
- it is `retryable_failure` and `nextRetryAt` has passed, or
- it is `running` but its lease expired

Run-level concurrency invariant for v1:
- `concurrency_limit` is enforced by `OperatorExecutionPort.claimTaskLease()`
- a claim must fail if the run already has `concurrency_limit` non-expired leased tasks in `running`
- this check belongs in durable persistence so multiple workers cannot over-claim the same run under race

### Finalization

A separate `FinalizeOperatorRunUseCase` should:
- verify all tasks are terminal
- order results by item index
- write output JSONL artifact
- write run summary metadata
- set terminal run status
- append one compact result handle into the parent conversation

V1 finalization trigger rules:
- `ExecuteOperatorTaskUseCase` must attempt finalization immediately after recording a terminal task state
- finalization must be idempotent so multiple workers can race safely and only one successful terminalization wins
- if finalization fails transiently, durable persistence must mark the run as needing finalization retry so polling workers can re-drive `FinalizeOperatorRunUseCase` even when no tasks remain claimable
- worker polling must therefore look for both claimable tasks and runs flagged for finalization retry
- finalization recovery must be stage-aware: retries reuse an existing `outputArtifactId`, detect whether the parent handle was already appended, and continue from the first incomplete stage rather than rewriting completed stages
- parent-handle append must use a deterministic per-run idempotency key so retries cannot duplicate handle events
- `GetOperatorRunUseCase` is inspection-only and must not hide missing finalization by synthesizing terminal state

Durable finalization-stage contract for v1:
- each run persists `finalization_stage` with values `not_started | artifact_written | handle_appended | completed`
- `OperatorExecutionPort` must provide durable progress updates for finalization-stage transitions
- retries of `FinalizeOperatorRunUseCase` resume from persisted `finalization_stage` rather than inferring progress indirectly

## Persistence Design

### New Persistence Contract

`OperatorExecutionPort` should expose the minimum durable primitives needed by the application layer, such as:
- create run
- create task batch
- get run
- get task
- list tasks for run
- claim task lease
- record task success
- record task failure / retryable failure
- mark task child conversation
- get task bootstrap state
- mark bootstrap started
- mark bootstrap completed
- claim run finalization retry work
- advance finalization stage
- finalize run
- look up run by idempotency key

Run creation semantics for v1:
- create-run and create-task-batch must be atomic at the persistence boundary
- if atomic setup fails, no partial task set may remain claimable
- initial queue wake-up is best-effort and non-atomic relative to durable setup; worker polling is the recovery path
- irrecoverable setup failure after durable run creation but before successful completion must move the run to terminal `failed` with diagnostic metadata rather than leaving orphaned non-terminal state

### Recommended Postgres Tables

#### `operator_runs`

Fields:
- `id`
- `conversation_id`
- `kind`
- `status`
- `prompt`
- `output_schema_json`
- `input_artifact_id`
- `output_artifact_id`
- `concurrency_limit`
- `max_retries`
- `retry_backoff_seconds`
- `needs_finalization_retry`
- `finalization_stage`
- `parent_handle_appended_at`
- `idempotency_key`
- `created_at`
- `updated_at`
- `completed_at`

#### `operator_tasks`

Fields:
- `id`
- `run_id`
- `item_index`
- `item_payload_json`
- `status`
- `attempt_count`
- `lease_owner`
- `lease_expires_at`
- `next_retry_at`
- `last_error`
- `child_conversation_id`
- `bootstrap_state`
- `result_json`
- `result_artifact_id`
- `created_at`
- `updated_at`
- `completed_at`

Recommended constraints:
- unique `(conversation_id, idempotency_key)` when idempotency key present
- unique `(run_id, item_index)`

Idempotency rule for v1:
- if the same `(conversation_id, idempotency_key)` is submitted with the same normalized operator input, return the existing run
- if the same `(conversation_id, idempotency_key)` is submitted with different normalized operator input, reject the request as an idempotency conflict

Normalization basis for v1 operator idempotency:
- operator kind (`llmMap` vs `agenticMap`)
- conversation ID
- prompt/task prompt
- normalized item payloads or input artifact ID
- output schema JSON in canonical form
- declared retry policy and concurrency limit
- declared `delegated_scope` and `kept_work` for `agenticMap`

Normalization should use the same canonical JSON discipline already used elsewhere in LedgerMind: stable field subset, sorted keys, omitted `undefined`, and deterministic serialization before hashing.

### In-Memory Fidelity

The in-memory adapter must preserve the same behavioral semantics as Postgres for:
- idempotent run creation
- duplicate claim rejection
- lease expiry handling
- ordered finalization
- child conversation reuse

## Public API Changes

### `MemoryEngine`

Add:
- `llmMap(input): Promise<LLMMapOutput>`
- `agenticMap(input): Promise<AgenticMapOutput>`
- `getOperatorRun(input): Promise<GetOperatorRunOutput>`

V1 API contract:
- `llmMap()` and `agenticMap()` submit durable runs and return immediately with `runId`
- `getOperatorRun()` is the canonical inspection API for run status, task status, output artifact ID, and failures
- `getOperatorRun()` may inline ordered results only when the serialized result payload is under `maxInlineRunResultsBytes` in application-owned operator config; otherwise it returns artifact metadata only
- synchronous completion is allowed only as an implementation detail in inline/local mode; it must not change the public contract

### New DTO Families

Add driving-port types for:
- map inputs/outputs
- delegation scope references
- kept work descriptors
- run/task status inspection
- retry policy config
- worker execution config

`GetOperatorRunOutput` must be explicit enough to test independently. V1 should include:
- run ID, conversation ID, operator kind, status, created/updated/completed timestamps
- input artifact ID and output artifact ID when present
- run-level diagnostics such as task counts by state and terminal error summary
- ordered inline results only when under the size ceiling; otherwise artifact-only metadata
- per-task inspection entries containing item index, status, attempt count, child conversation ID when present, result reference when present, and terminal failure metadata when present
- `inlineResults` must use the same result-entry shape defined for finalized JSONL output

Config ownership for v1:
- per-run retry policy and concurrency belong in map input DTOs and are persisted on `operator_runs`
- worker polling interval and batch/claim limits belong to worker-app configuration, not `MemoryEngine`
- execution timeout, lease duration, retry-backoff defaults, `maxKeptWorkChars`, and `maxInlineRunResultsBytes` belong to application-owned operator config surfaced through SDK/worker composition, with sane repo defaults and explicit override points

## Worker Architecture

### New Worker App

Create a dedicated worker app/package in the repo rather than hiding execution only inside the SDK.

The v1 worker mode should be **polling-first with DB leasing as the authoritative coordination mechanism**. Queue messages remain useful as wake-up hints, but correctness must not depend on broker callbacks, subscriptions, or delivery ordering.

This app should:
- poll for claimable tasks on a configurable interval and immediately attempt DB-backed claims
- optionally consume queue wake-up signals to shorten latency, without changing correctness semantics
- execute one task at a time through application use cases
- emit structured logs and task/run metrics
- support graceful shutdown without corrupting leases
- support local development with inline or polling mode

### Inline Execution For Tests And Local Dev

Keep an inline executor path for:
- unit tests
- integration tests
- local smoke runs without a background worker

Inline mode must still write the same durable run/task state so behavior matches worker mode.

## Tool Surface

V1 should expose documented recursion operators through adapter-layer tools once the application surface exists. Tool adapters should:
- bind caller context from runtime, not from model-controlled payloads
- reject malformed or oversized inline item payloads beyond configured limits
- prefer artifact-backed datasets when payload size is large
- surface run IDs and artifact IDs instead of dumping full result bodies into context

Tool exposure is part of the first full-scope implementation, not deferred to a later phase.

## Security And Safety

### Conversation Isolation

Do not introduce cross-conversation summary or message references. All child context must be local to the child conversation.

### Authorization Hardening

Current caller context is too easy to spoof if taken from raw model input. The implementation should:
- bind caller context in the runtime/tool adapter layer
- verify real lineage through `ConversationPort`
- restrict `expand` to actual child conversations only in v1

V1 defines no additional non-child privileged contexts for `expand`.

### Data Minimization

- parent contexts should keep only run handles and compact summaries
- delegated content should be summarized or artifact-backed when large
- final outputs should live in artifacts, with only handles added to active context

### Failure Containment

- child failures do not corrupt parent conversation memory
- retries reuse the same child conversation for the same task
- task side effects outside LedgerMind must be documented as requiring idempotent external tools

## Performance And Operations

### Concurrency

- concurrency is configured per run with safe defaults
- workers should support horizontal scaling via DB claims
- long-running and short-running operators may need separate queues later, but do not over-design this initially

### Observability

Track at minimum:
- run creation/completion/failure counts
- task claim latency
- retry counts
- lease expiry recoveries
- child conversation creation count
- output artifact sizes
- queue lag or polling lag

### Timeouts

Define and enforce for v1:
- per-task execution timeout
- fixed lease duration
- explicit retry backoff policy

V1 should **not** implement heartbeat-driven or lease-renewal semantics. Instead, task execution must be bounded so one lease duration safely covers one attempt with margin. Lease renewal can be added later only if real workloads prove it necessary.

## Testing Strategy

### Unit Tests

- DTO validation and coercion
- delegation-scope resolution rules
- kept-work validation
- retry eligibility rules
- ordered finalization behavior

### Application Integration Tests

- `llmMap` success path
- `llmMap` schema-validation failure and retry
- `agenticMap` child creation and reuse on retry
- rejection when `delegated_scope` or `kept_work` is invalid
- lineage verification for privileged operations

### Persistence Contract Tests

Run against both in-memory and Postgres:
- idempotent run creation
- task claim races
- expired lease reclamation
- duplicate completion writes
- finalization idempotency

### Worker Tests

- queue duplicate delivery
- worker crash before completion with later lease recovery
- graceful shutdown behavior
- polling or queue-trigger loop correctness

### End-To-End Tests

- parent conversation starts `agenticMap`
- child conversations execute and may recursively delegate
- outputs reduce into JSONL artifact in item order
- parent receives compact result handle only

## Risks

1. **Overbuilding a generic workflow engine.** Avoid by limiting scope to documented recursion operators.
2. **Caller context spoofing.** Fix by runtime-bound caller context and lineage checks.
3. **Cross-conversation reference leakage.** Avoid by child-local snapshotting only.
4. **Queue coupling becoming authoritative.** Keep queue as trigger only; DB owns state.
5. **Parent context bloat.** Store large inputs/outputs in artifacts and append only compact handles.
6. **Non-idempotent external tool side effects.** Document and test around this explicitly.

## Recommended Delivery Phases

### Phase 1: Contracts And Durable State

- add driving DTOs and `MemoryEngine` methods
- add new driven ports
- add in-memory + Postgres execution persistence
- add run/task status inspection

### Phase 2: `llmMap`

- implement structured generation path
- implement worker task execution and run finalization
- add artifact-backed dataset handling

### Phase 3: `agenticMap`

- implement child conversation bootstrapping
- implement sub-agent execution port and adapters
- enforce delegation guard semantics

### Phase 4: Tooling, Worker App, And Hardening

- add worker package/app
- add runtime-bound tool adapters
- add observability, timeout, and retry hardening
- add documentation and examples

## Success Criteria

The implementation is successful when:

1. `MemoryEngine` exposes durable `llmMap` and `agenticMap` APIs.
2. Queue duplicates and worker failures do not corrupt run/task state.
3. `agenticMap` creates child conversations with explicit bounded scope.
4. Parent contexts receive compact handles, not full delegated payloads.
5. Recursive child execution works without cross-conversation memory references.
6. In-memory and Postgres adapters satisfy the same execution contract.
7. Authorization and lineage checks prevent spoofed privileged access.
8. The design stays within existing clean-architecture boundaries.

## Open Questions Resolved By This Design

- **Should we ship a real worker path now?** Yes. Full documented scope should include a real worker app/package in this repo, plus inline mode for tests and local dev.
- **Should queue or DB own state?** DB owns durable state; queue only triggers execution.
- **Should child conversations share parent memory references?** No. Scope is snapshotted into the child.
- **Should we build a generic orchestration framework?** No. Implement only the documented recursion operators.
