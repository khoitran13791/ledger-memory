# Contract: `@ledgermind/application` Port Interfaces (Phase 1)

This contract defines the expected Phase 1 port interface surface for `packages/application/src/ports/**`.

## 1) Contract Scope

The feature MUST define:

1. Driving ports (external runtime -> application)
2. Driven ports (application -> external capabilities)
3. Transaction boundary abstraction
4. Supporting contract shapes required for conformance-ready implementations

Out of scope for this contract artifact:
- concrete adapter logic,
- SQL schema/migrations,
- framework-specific tool wrappers,
- runtime wiring/factories.

---

## 2) Driving Port Contracts

## 2.1 MemoryEngine

```ts
export interface MemoryEngine {
  append(input: AppendLedgerEventsInput): Promise<AppendLedgerEventsOutput>;
  materializeContext(input: MaterializeContextInput): Promise<MaterializeContextOutput>;
  runCompaction(input: RunCompactionInput): Promise<RunCompactionOutput>;
  checkIntegrity(input: CheckIntegrityInput): Promise<CheckIntegrityOutput>;
  grep(input: GrepInput): Promise<GrepOutput>;
  describe(input: DescribeInput): Promise<DescribeOutput>;
  expand(input: ExpandInput): Promise<ExpandOutput>;
  storeArtifact(input: StoreArtifactInput): Promise<StoreArtifactOutput>;
  exploreArtifact(input: ExploreArtifactInput): Promise<ExploreArtifactOutput>;
}
```

Behavior requirements:
- Operations are conversation-scoped for Phase 1 retrieval/search behavior.
- Public contract surface must map to core use cases without exposing adapter internals.

## 2.2 ToolProviderPort

```ts
export interface ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[];
}
```

Behavior requirements:
- Accepts `MemoryEngine` abstraction only.
- Must not leak framework-specific types into domain/application core.

## 2.3 DomainEventSubscriber

```ts
export interface DomainEventSubscriber {
  on(event: DomainEvent): void;
}
```

Behavior requirements:
- Event handling is subscription contract only; no event bus implementation in this feature.

---

## 3) Driven Persistence Contracts (ISP)

## 3.1 LedgerAppendPort

```ts
export interface LedgerAppendPort {
  appendEvents(conversationId: ConversationId, events: readonly LedgerEvent[]): Promise<void>;
}
```

Behavior requirements:
- Sequence allocation is part of append semantics.
- Contract set must not expose standalone next-sequence allocation operation in Phase 1.

## 3.2 LedgerReadPort

```ts
export interface LedgerReadPort {
  getEvents(conversationId: ConversationId, range?: SequenceRange): Promise<readonly LedgerEvent[]>;
  searchEvents(conversationId: ConversationId, query: string): Promise<readonly LedgerEvent[]>;
  regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    scope?: SummaryNodeId,
  ): Promise<readonly GrepMatch[]>;
}
```

Behavior requirements:
- Retrieval and search are conversation-scoped in Phase 1.
- Search contract requirements are limited to keyword/full-text and regex behavior.
- Semantic/vector search interfaces are not required in this phase.

## 3.3 ContextProjectionPort

```ts
export interface ContextProjectionPort {
  getCurrentContext(conversationId: ConversationId): Promise<{
    items: readonly ContextItem[];
    version: ContextVersion;
  }>;
  getContextTokenCount(conversationId: ConversationId): Promise<TokenCount>;
  appendContextItems(conversationId: ConversationId, items: readonly ContextItem[]): Promise<ContextVersion>;
  replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: readonly number[],
    replacement: ContextItem,
  ): Promise<ContextVersion>;
}
```

Behavior requirements:
- `replaceContextItems` requires caller-provided expected version.
- Stale-version mismatch must produce explicit conflict signaling.
- Silent overwrite behavior is forbidden for versioned mutation paths.

## 3.4 SummaryDagPort

```ts
export interface SummaryDagPort {
  createNode(node: SummaryNode): Promise<void>;
  getNode(id: SummaryNodeId): Promise<SummaryNode | null>;
  addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void>;
  addCondensedEdges(summaryId: SummaryNodeId, parentSummaryIds: readonly SummaryNodeId[]): Promise<void>;
  expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]>;
  searchSummaries(conversationId: ConversationId, query: string): Promise<readonly SummaryNode[]>;
  checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport>;
}
```

Behavior requirements:
- Expansion and summary search are scoped by conversation lineage semantics.
- Integrity contract must return structured pass/fail result with per-check details.

## 3.5 ArtifactStorePort

```ts
export interface ArtifactStorePort {
  store(artifact: Artifact, content?: string | Uint8Array): Promise<void>;
  getMetadata(id: ArtifactId): Promise<Artifact | null>;
  getContent(id: ArtifactId): Promise<string | Uint8Array | null>;
  updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void>;
}
```

Behavior requirements:
- Binary payload representation uses `Uint8Array`.
- Metadata and raw content access operations are open to normal callers in Phase 1.

## 3.6 ConversationPort

```ts
export interface ConversationPort {
  create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation>;
  get(id: ConversationId): Promise<Conversation | null>;
  getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]>;
}
```

Behavior requirements:
- Conversation retrieval contracts remain conversation-scoped.

---

## 4) Transaction Boundary Contracts

## 4.1 UnitOfWorkPort

```ts
export interface UnitOfWorkPort {
  execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
```

## 4.2 UnitOfWork

```ts
export interface UnitOfWork {
  readonly ledger: LedgerAppendPort;
  readonly context: ContextProjectionPort;
  readonly dag: SummaryDagPort;
  readonly artifacts: ArtifactStorePort;
  readonly conversations: ConversationPort;
}
```

Behavior requirements:
- `execute` represents an atomic application-level transaction boundary.
- Capability grouping must be explicit and complete for core persistence operations.

---

## 5) Driven Non-Persistence Capability Contracts

## 5.1 SummarizerPort

```ts
export interface SummarizerPort {
  summarize(input: SummarizationInput): Promise<SummarizationOutput>;
}
```

## 5.2 TokenizerPort

```ts
export interface TokenizerPort {
  countTokens(text: string): TokenCount;
  estimateFromBytes(byteLength: number): TokenCount;
}
```

## 5.3 ExplorerPort / ExplorerRegistryPort

```ts
export interface ExplorerPort {
  readonly name: string;
  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number;
  explore(input: ExplorerInput): Promise<ExplorerOutput>;
}

export interface ExplorerRegistryPort {
  register(explorer: ExplorerPort): void;
  resolve(mimeType: MimeType, path: string, hints?: ExplorerHints): ExplorerPort;
}
```

## 5.4 JobQueuePort

```ts
export interface JobQueuePort {
  enqueue<T>(job: Job<T>): Promise<JobId>;
  onComplete(jobId: JobId, callback: (result: unknown) => void): void;
}
```

## 5.5 AuthorizationPort

```ts
export interface AuthorizationPort {
  canExpand(caller: CallerContext): boolean;
}
```

Behavior requirements:
- Guarded expansion authorization must be explicit in contract surface.

## 5.6 ClockPort

```ts
export interface ClockPort {
  now(): Timestamp;
}
```

## 5.7 HashPort

```ts
export interface HashPort {
  sha256(input: Uint8Array): string;
}
```

Behavior requirements:
- Hash abstraction is required to avoid concrete runtime crypto dependency leakage into inner layers.

---

## 6) Supporting Contract Types

## 6.1 CallerContext

```ts
export interface CallerContext {
  conversationId: ConversationId;
  isSubAgent: boolean;
  parentConversationId?: ConversationId;
}
```

## 6.2 IntegrityReport

```ts
export interface IntegrityReport {
  readonly passed: boolean;
  readonly checks: readonly IntegrityCheckResult[];
}

export interface IntegrityCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
  readonly affectedIds?: readonly string[];
}
```

Behavior requirements:
- Supporting types must be stable and sufficiently explicit for adapter conformance test planning.

---

## 7) Clean Architecture & Dependency Constraints

- Port interfaces are owned by `packages/application` and may depend on `@ledgermind/domain` types.
- Contracts must not import concrete adapters, infrastructure bindings, SQL, framework SDKs, or runtime-only types.
- Interface definitions must preserve segregation and avoid mixed concerns.

---

## 8) Verification Checklist

1. Contract coverage includes all required driving and driven port families (SC-001).
2. Behavior expectations are explicit for ordering, versioning, authorization, and atomicity semantics (SC-002).
3. Core use-case dependency mapping can be completed without adding undeclared interfaces (SC-003).
4. Architecture review confirms no dependency boundary violations in contract organization (SC-004).
5. Conformance-test planning inputs can be derived directly from these contracts without unresolved ambiguity (SC-005).
