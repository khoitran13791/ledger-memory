# Contract: Phase 1 Core Use Cases

This contract defines the executable behavior expected from the Phase 1 core use-case implementation built on `@ledgermind/domain` and existing `@ledgermind/application` port interfaces.

## 1) Driving Surface Contract (`MemoryEngine`)

The implementation MUST satisfy the driving API in:
- `packages/application/src/ports/driving/memory-engine.port.ts`

Methods in scope:
1. `append(input)`
2. `materializeContext(input)`
3. `runCompaction(input)`
4. `checkIntegrity(input)`
5. `grep(input)`
6. `describe(input)`
7. `expand(input)`
8. `storeArtifact(input)`
9. `exploreArtifact(input)`

All methods are asynchronous and MUST return typed outputs or typed failures.

---

## 2) Use-Case Contracts

## 2.1 Append Ledger Events

### Input
```ts
AppendLedgerEventsInput {
  conversationId: ConversationId;
  events: NewLedgerEvent[];
  idempotencyKey?: string;
}
```

### Output
```ts
AppendLedgerEventsOutput {
  appendedEvents: LedgerEvent[];
  contextTokenCount: TokenCount;
}
```

### Required behavior
- Persist immutable ledger events in conversation-local order.
- Maintain deterministic identity semantics through domain ID rules.
- Apply idempotency semantics:
  - same key + same payload -> no-op success,
  - same key + different payload -> typed idempotency conflict.
- Update active context projection for appended events.
- Emit append lifecycle event(s).
- When soft threshold is crossed, schedule non-blocking compaction trigger.

### Failure contract
- Invalid conversation or malformed input => typed application/domain error.
- Idempotency conflict => explicit typed error.
- Any mutation failure inside transactional scope => no partial writes.

---

## 2.2 Materialize Context

### Input
```ts
MaterializeContextInput {
  conversationId: ConversationId;
  budgetTokens: number;
  overheadTokens: number;
  pinRules?: PinRule[];
  retrievalHints?: RetrievalHint[];
}
```

### Output
```ts
MaterializeContextOutput {
  systemPreamble: string;
  modelMessages: ModelMessage[];
  summaryReferences: SummaryReference[];
  artifactReferences: ArtifactReference[];
  budgetUsed: TokenCount;
}
```

### Required behavior
- Compute available budget from window/overhead/reserve semantics.
- If hard threshold exceeded, execute blocking compaction before final assembly.
- Return model-ready ordered messages with summary/artifact references.
- Ensure output fits available budget.
- Emit context materialization lifecycle event(s).

### Failure contract
- If budget cannot be satisfied after required hard-trigger compaction, return typed budget/non-convergence failure.
- Never return oversized context silently.

---

## 2.3 Run Compaction

### Input
```ts
RunCompactionInput {
  conversationId: ConversationId;
  trigger: 'soft' | 'hard';
  targetTokens?: TokenCount;
}
```

### Output
```ts
RunCompactionOutput {
  rounds: number;
  nodesCreated: SummaryNodeId[];
  tokensFreed: TokenCount;
  converged: boolean;
}
```

### Required behavior
- Select candidates as oldest contiguous non-pinned block satisfying policy constraints.
- Enforce escalation sequence:
  1. normal,
  2. aggressive,
  3. deterministic fallback.
- Accept normal/aggressive output only if token-reducing.
- Deterministic fallback guarantees bounded output and termination path.
- Replace projection segment with summary pointer using expected context version.
- Persist summary nodes + DAG edges + artifact ID propagation.
- Emit compaction lifecycle event(s).

### Failure contract
- Version mismatch during replacement => explicit stale-version typed failure.
- For hard trigger, failure to reach budget within configured max rounds => deterministic non-convergence typed failure.
- Mutation failures must preserve transactional integrity.

---

## 2.4 Grep

### Input
```ts
GrepInput {
  conversationId: ConversationId;
  pattern: string;
  scope?: SummaryNodeId;
}
```

### Output
```ts
GrepOutput {
  matches: GrepMatch[];
}
```

### Required behavior
- Perform conversation-scoped pattern/regex retrieval over persisted memory.
- Return matches with sequence and excerpt, including covering summary linkage when available.
- Respect optional scope narrowing.

### Failure contract
- Invalid scope reference => typed invalid-reference failure.

---

## 2.5 Describe

### Input
```ts
DescribeInput { id: SummaryNodeId | ArtifactId }
```

### Output
```ts
DescribeOutput {
  kind: 'summary' | 'artifact';
  metadata: Record<string, unknown>;
  tokenCount: TokenCount;
  parentIds?: SummaryNodeId[];
  explorationSummary?: string;
}
```

### Required behavior
- Resolve summary/artifact metadata by identifier.
- Include provenance-oriented metadata fields where relevant.

### Failure contract
- Unknown ID => typed invalid-reference failure.

---

## 2.6 Expand

### Input
```ts
ExpandInput {
  summaryId: SummaryNodeId;
  callerContext: CallerContext;
}
```

### Output
```ts
ExpandOutput {
  messages: LedgerEvent[];
}
```

### Required behavior
- Authorize caller via `AuthorizationPort.canExpand`.
- Expand summary lineage to ordered source messages.

### Failure contract
- Unauthorized caller => explicit typed authorization error.
- Unknown summary => typed invalid-reference failure.

---

## 2.7 Store Artifact

### Input
```ts
StoreArtifactInput {
  conversationId: ConversationId;
  source:
    | { kind: 'path'; path: string }
    | { kind: 'text'; content: string }
    | { kind: 'binary'; data: Uint8Array };
  mimeType?: MimeType;
}
```

### Output
```ts
StoreArtifactOutput {
  artifactId: ArtifactId;
  tokenCount: TokenCount;
}
```

### Required behavior
- Persist artifact metadata + content reference/content payload.
- Return stable artifact ID and token estimate/count.
- Emit artifact stored lifecycle event(s).

### Failure contract
- Invalid source/mime/content => typed validation/application failure.

---

## 2.8 Explore Artifact

### Input
```ts
ExploreArtifactInput {
  artifactId: ArtifactId;
  explorerHints?: { preferredExplorer?: string };
}
```

### Output
```ts
ExploreArtifactOutput {
  explorerUsed: string;
  summary: string;
  metadata: Record<string, unknown>;
  tokenCount: TokenCount;
}
```

### Required behavior
- Resolve artifact and dispatch through explorer registry.
- Persist/update exploration summary metadata.
- Return selected explorer and structured metadata.

### Failure contract
- Unknown artifact => typed invalid-reference failure.
- No suitable explorer path => typed exploration failure (or deterministic fallback behavior if configured).

---

## 2.9 Check Integrity

### Input
```ts
CheckIntegrityInput { conversationId: ConversationId }
```

### Output
```ts
CheckIntegrityOutput { report: IntegrityReport }
```

### Required behavior
- Return per-check status report for all configured integrity checks.
- Preserve check names/details/affected IDs as contract payload.

### Failure contract
- Conversation not found or integrity subsystem failure => typed application failure.

---

## 3) Driven Port Usage Contract

Phase 1 use cases MUST be implemented by composing these existing contracts:
- Persistence: `LedgerAppendPort`, `LedgerReadPort`, `ContextProjectionPort`, `SummaryDagPort`, `ArtifactStorePort`, `ConversationPort`
- Transaction: `UnitOfWorkPort`
- LLM/tokenization: `SummarizerPort`, `TokenizerPort`
- Authorization: `AuthorizationPort`
- Explorer: `ExplorerRegistryPort`
- Jobs: `JobQueuePort`
- Clock/hash utilities via existing contract abstractions

### Transaction rule
Mutations spanning multiple persistence concerns MUST execute inside `UnitOfWorkPort.execute`.

### Concurrency rule
Versioned replacement operations MUST pass `expectedVersion` and propagate stale conflict semantics.

---

## 4) Error Surface Contract

The implementation MUST expose explicit typed failures (application/domain) for:
1. idempotency conflict,
2. stale context version,
3. invalid reference,
4. authorization denial,
5. budget exceeded / non-convergence,
6. integrity execution failures.

Silent fallback behavior that masks these failure classes is forbidden.

---

## 5) Determinism and Safety Contract

1. Deterministic ID rules from domain/addendum must remain intact.
2. L1/L2 compaction outputs accepted only when shrinking.
3. Deterministic fallback provides bounded output for termination.
4. Artifact ID propagation must preserve full source unions across compaction/condensation.
5. No partial state corruption on any failing operation.

---

## 6) Verification Contract (SC Alignment)

- **SC-001**: P1 append + materialization acceptance scenarios pass.
- **SC-002**: Materialization always returns within budget or explicit typed budget/convergence error.
- **SC-003**: Deterministic replay yields stable IDs/lineage in golden fixtures.
- **SC-004**: Escalation-path regressions prove L1/L2 non-shrinking outputs escalate and terminate.
- **SC-005**: Defined integrity checks pass for successful append+compaction sequences on in-memory + PostgreSQL.
- **SC-006**: Search -> describe -> expand retrieval workflow reaches >=90% task success target.
- **SC-007**: Artifact propagation remains 100% across multi-round compaction/condensation.

---

## 7) Out-of-Scope Contract Guardrails

The Phase 1 implementation MUST NOT include:
- operator recursion (`llm_map`, `agentic_map`),
- multi-tenant/server-mode concerns,
- framework runtime types in domain/application layers,
- SQLite adapter parity requirements.
