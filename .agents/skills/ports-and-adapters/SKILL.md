---
name: ports-and-adapters
description: All port interface definitions, UnitOfWork pattern, and adapter implementation guidelines for LedgerMind's hexagonal architecture.
---

# Ports & Adapters Reference

## Driving Ports (External → LedgerMind)

Defined in `application/ports/driving/`:

### MemoryEngine (Primary Facade)
```typescript
interface MemoryEngine {
  append(input: AppendLedgerEventsInput): Promise<AppendLedgerEventsOutput>;
  materializeContext(input: MaterializeContextInput): Promise<MaterializeContextOutput>;
  runCompaction(input: RunCompactionInput): Promise<RunCompactionOutput>;
  grep(input: GrepInput): Promise<GrepOutput>;
  describe(input: DescribeInput): Promise<DescribeOutput>;
  expand(input: ExpandInput): Promise<ExpandOutput>;
  storeArtifact(input: StoreArtifactInput): Promise<StoreArtifactOutput>;
  exploreArtifact(input: ExploreArtifactInput): Promise<ExploreArtifactOutput>;
}
```

### ToolProviderPort
```typescript
interface ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[];
}
```

## Driven Ports (LedgerMind → External)

Defined in `application/ports/driven/`:

### Persistence (segregated by ISP)
- **LedgerAppendPort** — `appendEvents()`, `getNextSequence()`
- **LedgerReadPort** — `getEvents()`, `searchEvents()`, `regexSearchEvents()`
- **ContextProjectionPort** — `getCurrentContext()` (returns items + version), `getContextTokenCount()`, `appendContextItems()`, `replaceContextItems(expectedVersion)`
- **SummaryDagPort** — `createNode()`, `getNode()`, `addLeafEdges()`, `addCondensedEdges()`, `expandToMessages()`, `searchSummaries()`, `checkIntegrity()`
- **ArtifactStorePort** — `store()`, `getMetadata()`, `getContent()`, `updateExploration()`
- **ConversationPort** — `create()`, `get()`, `getAncestorChain()`

### Transaction
- **UnitOfWorkPort** — `execute<T>(work: (uow) => Promise<T>): Promise<T>`
- **UnitOfWork** — provides `ledger`, `context`, `dag`, `artifacts`, `conversations`

### LLM & Tokenization
- **SummarizerPort** — `summarize(input): Promise<SummarizationOutput>`
- **TokenizerPort** — `countTokens(text)`, `estimateFromBytes(byteLength)`

### Explorer
- **ExplorerPort** — `canHandle()`, `explore()`
- **ExplorerRegistryPort** — `register()`, `resolve()`

### Infrastructure
- **HashPort** — `sha256(input: Uint8Array): string`
- **ClockPort** — `now(): Timestamp`
- **JobQueuePort** — `enqueue()`, `onComplete()`
- **AuthorizationPort** — `canExpand()`, `canReadArtifact()`

## UnitOfWork Pattern

```typescript
// Application use case:
async execute(input) {
  return this.unitOfWork.execute(async (uow) => {
    // All operations within this callback are atomic
    await uow.ledger.appendEvents(...);
    await uow.context.appendContextItems(...);
    // If any step fails → entire transaction rolls back
  });
}
```

## Adapter Implementation Guidelines

1. Each adapter implements exactly one port (or a few closely related ones)
2. Adapters handle mapping between domain types and external representations
3. In-memory adapters provide full behavioral fidelity (not just stubs)
4. PostgreSQL adapters use parameterized queries only (no string interpolation)
5. All adapters must pass the conformance test suite
6. Adapters use `Uint8Array` instead of `Buffer` in port interfaces
