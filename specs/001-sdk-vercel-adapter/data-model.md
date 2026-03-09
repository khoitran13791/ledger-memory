# Data Model: SDK Entrypoint and Vercel Memory Adapter

This feature defines the integration-facing data contracts for creating a memory engine through the SDK and executing memory capabilities through a Vercel-compatible tool bundle.

## 1) Engine Initialization Request

### Description
Input contract used by SDK consumers to construct a `MemoryEngine` instance through the public entrypoint.

### Core fields
- `storage`: engine persistence selection
  - `{ type: 'in-memory' }`
  - `{ type: 'postgres'; connectionString: string }`
- `tokenizer?`: tokenizer behavior selection
- `summarizer?`: summarizer behavior selection (deterministic in current phase)
- `compaction?`: optional compaction config overrides

### Validation rules
- `storage` is required.
- For postgres storage, `connectionString` is required and non-empty.
- Unknown storage/tokenizer/summarizer variants are rejected at initialization.
- Invalid initialization must fail before returning an engine instance.

### Behavioral rules
- Generic entrypoint and named presets must converge to the same underlying engine contract.
- Initialization failures never return partially initialized engines.

---

## 2) Memory Engine Instance

### Description
Stable runtime interface returned by SDK entrypoint and used by adapters/tool providers.

### Surface (existing application contract)
- `append`
- `materializeContext`
- `runCompaction`
- `checkIntegrity`
- `grep`
- `describe`
- `expand`
- `storeArtifact`
- `exploreArtifact`

### Validation rules
- Engine instance must expose the same core method set regardless of initialization path (generic vs preset).

### Behavioral rules
- Methods preserve existing application-level typed semantics.
- Restricted operations (notably `expand`) remain authorization-gated through caller context.

---

## 3) Tool Bundle Definition

### Description
Adapter-produced set of Vercel-compatible tool definitions that wrap memory engine operations.

### Core fields
- `tools`: named collection of executable tool definitions
  - expected Phase 1 memory operations:
    - memory search (`grep`)
    - memory metadata lookup (`describe`)
    - controlled expansion (`expand`)

### Validation rules
- Bundle creation requires a valid initialized `MemoryEngine`.
- Tool names are stable and unambiguous within bundle scope.
- Every tool execute handler must return a structured result envelope (success or error).

### Behavioral rules
- Tool bundle is runtime-callable in Vercel AI SDK workflows.
- Bundle remains framework-bound at adapter layer and does not alter core engine contracts.

---

## 4) Tool Execution Context

### Description
Runtime context supplied to restricted tool operations for authorization and conversation scoping.

### Core fields
- `callerContext.conversationId`
- `callerContext.isSubAgent`
- `callerContext.parentConversationId?`
- optional adapter-level metadata for traceability

### Validation rules
- Restricted operations require caller context.
- Missing/invalid restricted-operation context is treated as unauthorized/invalid request and returned via structured error envelope.

### Behavioral rules
- Authorization decision for expand uses existing `AuthorizationPort.canExpand(caller)` flow.
- Runtime denial is controlled and non-crashing.

---

## 5) Tool Result Envelope

### Description
Canonical response envelope returned by adapter tools for both success and failure paths.

### Success envelope fields
- `ok: true`
- `data: Record<string, unknown>` (operation payload)
- `references: {
    summaryIds?: string[];
    artifactIds?: string[];
    eventIds?: string[];
  }`
- optional `meta` (tool name/version/context hints)

### Error envelope fields
- `ok: false`
- `error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }`
- optional `references` when useful for follow-up diagnostics

### Validation rules
- Every tool response must include `ok` discriminator.
- Error responses must include `error.code` and `error.message`.
- Envelope shape is consistent across all adapter tools.

### Behavioral rules
- Success responses preserve follow-up identifiers required for describe/expand inspection flows.
- Failures are mapped from typed application/runtime errors into one consistent envelope shape.

---

## 6) Adapter Error Mapping Model

### Description
Normalization model that maps application/runtime exceptions into the Tool Result Envelope error shape.

### Canonical mapped codes (minimum set)
- `UNAUTHORIZED_EXPAND`
- `INVALID_REFERENCE`
- `ARTIFACT_NOT_FOUND`
- `CONVERSATION_NOT_FOUND`
- `TOOL_EXECUTION_FAILED` (unexpected/internal)

### Validation rules
- Known typed application errors map to stable `error.code` values.
- Unknown errors map to a generic internal adapter code without crashing the runtime.

### Behavioral rules
- Adapter returns controlled structured denial for unauthorized restricted operations.
- Mapping is deterministic for identical error conditions.

---

## 7) Relationships

- One `Engine Initialization Request` produces zero or one `Memory Engine Instance`.
- One `Memory Engine Instance` can create one or more `Tool Bundle Definition` instances.
- Each tool call uses one `Tool Execution Context` and returns one `Tool Result Envelope`.
- `Adapter Error Mapping Model` transforms failures from engine/use-case execution into the envelope error section.
- Success envelopes include references that connect subsequent describe/expand workflows.

---

## 8) Requirement Mapping Matrix

- FR-001, FR-002, FR-003, FR-004 -> Sections 1, 2
- FR-005, FR-006 -> Sections 2, 3
- FR-007 -> Sections 2, 4, 6
- FR-008 -> Sections 3, 5
- FR-009 -> Sections 5, 6
- FR-010 -> Sections 1, 2, 3, 5
- FR-011, FR-012 -> Sections 3, 4, 5, 6

---

## 9) Out-of-Scope Guardrails

- No changes to domain/application core port signatures for framework-specific concerns.
- No additional framework adapters beyond Vercel in this feature.
- No server-mode or multi-tenant concerns.
- No new persistence backend beyond existing in-memory/PostgreSQL options.
