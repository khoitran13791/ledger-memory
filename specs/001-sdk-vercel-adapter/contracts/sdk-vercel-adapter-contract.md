# Contract: SDK Entrypoint and Vercel Memory Adapter

This contract defines required behavior for delivering the Phase 1 SDK public entrypoint experience and Vercel AI SDK adapter integration for memory tools.

## 1) Boundary Contracts

### 1.1 Public SDK entrypoint contract

```ts
interface MemoryEngineConfig {
  readonly storage:
    | { readonly type: 'in-memory' }
    | { readonly type: 'postgres'; readonly connectionString: string };
  readonly summarizer?: { readonly type: 'deterministic' };
  readonly tokenizer?: MemoryEngineTokenizerConfig;
  readonly compaction?: Partial<RunCompactionConfig>;
}

declare function createMemoryEngine(config: MemoryEngineConfig): MemoryEngine;
```

### 1.2 Tool provider boundary contract

```ts
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(input: unknown): Promise<unknown>;
}

interface ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[];
}
```

### 1.3 Memory engine runtime methods (adapter-consumed subset)

```ts
interface MemoryEngine {
  grep(input: GrepInput): Promise<GrepOutput>;
  describe(input: DescribeInput): Promise<DescribeOutput>;
  expand(input: ExpandInput): Promise<ExpandOutput>;
  // plus remaining stable core methods
}
```

### Contract rules
- Existing application/domain contracts above remain stable for this feature.
- Framework-specific integration behavior is implemented at adapter layer.
- SDK entrypoint remains the canonical engine creation surface.

---

## 2) SDK Entrypoint Contract

### Required behavior
- Provide one generic create function via SDK public surface.
- Provide named presets for common setups that include at minimum:
  - in-memory engine preset
  - PostgreSQL engine preset
- Presets must compose through the same underlying creation path as generic create.

### Initialization validation rules
- Invalid/incomplete config must fail at initialization.
- Failures return actionable validation feedback.
- No partially initialized engine instance may be returned on failure.

### Stability rules
- Engine returned by generic create and presets exposes one stable runtime contract.
- Entry-point changes in this feature must not alter core method semantics.

---

## 3) Vercel Tool Bundle Contract

### Required behavior
- Provide a Vercel AI SDK-compatible tool bundle creator that accepts a `MemoryEngine`.
- Returned bundle must include callable memory operations for:
  - search (`grep`)
  - metadata lookup (`describe`)
  - controlled expansion (`expand`)

### Tool definition rules
- Each tool has stable name, description, and parameter schema.
- Each execute handler returns structured envelope output (success or error).
- Tool bundle creation must fail fast if engine is missing/invalid.

---

## 4) Runtime Authorization Contract (Restricted Operations)

### Required behavior
- Restricted operations (expand) must require caller context and enforce existing runtime authorization policy.
- Authorization denial must return controlled, structured failure output.

### Authorization source of truth
- Adapter uses existing application path:
  - `ExpandUseCase` authorization gate through `AuthorizationPort.canExpand(caller)`.
- Current Phase 1 policy remains:
  - sub-agents authorized
  - non-sub-agents denied

### Denial behavior
- Unauthorized restricted calls must not crash runtime.
- Denial output must use the same canonical error envelope as all other tool failures.

---

## 5) Structured Tool Response Contract

### 5.1 Success envelope

All successful tool calls return:

```ts
{
  ok: true,
  data: Record<string, unknown>,
  references?: {
    summaryIds?: string[];
    artifactIds?: string[];
    eventIds?: string[];
  },
  meta?: Record<string, unknown>
}
```

### 5.2 Error envelope

All failed tool calls return:

```ts
{
  ok: false,
  error: {
    code: string,
    message: string,
    details?: Record<string, unknown>
  },
  references?: {
    summaryIds?: string[];
    artifactIds?: string[];
    eventIds?: string[];
  }
}
```

### Envelope rules
- `ok` discriminator is mandatory for all responses.
- Error envelopes always include `error.code` and `error.message`.
- Envelope shape is consistent across every adapter tool.

---

## 6) Error Mapping Contract

### Required mapped codes (minimum)
- `UNAUTHORIZED_EXPAND`
- `INVALID_REFERENCE`
- `ARTIFACT_NOT_FOUND`
- `CONVERSATION_NOT_FOUND`
- `TOOL_EXECUTION_FAILED` (unexpected/internal fallback)

### Mapping rules
- Known typed application errors map to stable adapter `error.code` values.
- Unknown/unexpected failures map to one generic internal adapter code.
- Adapter never throws unhandled errors from tool execute path.

---

## 7) Follow-up Reference Preservation Contract

### Required behavior
- Tool outputs must preserve identifiers needed for subsequent retrieval/inspection actions.
- Reference preservation must include relevant IDs from success results:
  - summary IDs
  - artifact IDs
  - event IDs (when applicable)

### Consistency rules
- Reference fields are predictable and operation-appropriate.
- Empty result scenarios still return valid structured response shape.

---

## 8) Test Conformance Contract

### Required test groups

1. **SDK entrypoint tests**
   - generic create returns usable engine for valid in-memory config
   - generic create returns usable engine for valid PostgreSQL config
   - invalid/incomplete config fails with actionable error
   - presets produce same runtime contract as generic create

2. **Tool bundle registration tests**
   - Vercel tool bundle returns callable definitions
   - expected memory tool names are present
   - schema/handler surfaces are stable

3. **Success-path tool execution tests**
   - grep/describe execute and return success envelope
   - references are preserved when applicable

4. **Restricted-operation tests**
   - authorized expand succeeds with success envelope
   - unauthorized expand returns structured denial envelope

5. **Error envelope tests (negative paths)**
   - invalid reference maps to canonical error envelope
   - not-found conditions map to canonical error envelope
   - unexpected internal exception maps to `TOOL_EXECUTION_FAILED`

### Negative-path threshold
- 100% of defined negative-path scenarios for this feature must be covered by automated tests.

---

## 9) Out-of-Scope Guardrails

This contract excludes:
- additional framework adapter implementations beyond Vercel,
- server-mode/MCP hosting behavior,
- changes to domain/application core method signatures for framework-specific needs,
- new persistence backends beyond existing in-memory and PostgreSQL initialization support.
