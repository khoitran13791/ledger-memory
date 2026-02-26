# LedgerMind: High-Level Design Document

> **Technical Architecture Blueprint — Clean Architecture & SOLID**
> Version: 1.0 | Date: February 26, 2026 | Status: Draft

---

## Table of Contents

1. [Introduction & Goals](#1-introduction--goals)
2. [Glossary](#2-glossary)
3. [Architectural Principles](#3-architectural-principles)
4. [System Context (C4 Level 1)](#4-system-context-c4-level-1)
5. [Layered Architecture Overview](#5-layered-architecture-overview)
6. [Domain Model](#6-domain-model)
7. [Use Cases (Application Layer)](#7-use-cases-application-layer)
8. [Ports (Interfaces)](#8-ports-interfaces)
9. [Adapters](#9-adapters)
10. [Package Structure](#10-package-structure)
11. [Data Model & Persistence Mapping](#11-data-model--persistence-mapping)
12. [Compaction & Retrieval Algorithms](#12-compaction--retrieval-algorithms)
13. [Explorer Plugin Architecture](#13-explorer-plugin-architecture)
14. [Token Budget Computation](#14-token-budget-computation)
15. [Error Handling Strategy](#15-error-handling-strategy)
16. [Testing Strategy](#16-testing-strategy)
17. [Observability & Operations](#17-observability--operations)
18. [Security & Safety](#18-security--safety)
19. [Implementation Roadmap](#19-implementation-roadmap)

---

## 1. Introduction & Goals

### 1.1 What LedgerMind Provides

LedgerMind is **"Postgres for agent memory"** — a standalone, framework-agnostic memory infrastructure with formal compaction semantics for any LLM agent application.

Based on the **Lossless Context Management (LCM)** architecture (Ehrlich & Blackman, 2026), it provides:

- **Immutable append-only ledger** — every message, tool result, and event persisted verbatim
- **Hierarchical summary DAG** — leaf + condensed summaries with provenance links
- **Deterministic compaction loop** — soft/hard threshold with guaranteed convergence
- **Three-level escalation** — normal → aggressive → deterministic fallback
- **Type-aware large file handling** — 30+ explorers as plugins
- **Memory access tools** — `grep`, `expand`, `describe` for retrieval without context bloat
- **Operator-level recursion** — `llm_map` and `agentic_map` for data parallelism

### 1.2 Success Criteria (Testable)

| Criterion | Verification |
|-----------|-------------|
| **Append-only invariant** | No ledger event is ever mutated or deleted (enforced by schema constraints) |
| **Convergent compaction** | `materializeContext()` always returns context ≤ budget OR deterministic error |
| **Deterministic IDs** | Content-addressed SHA-256; same input → same ID across runs |
| **Framework independence** | Core has zero imports from Vercel AI SDK, LangChain, OpenAI SDK, etc. |
| **Pluggable explorers** | New file type explorer added without modifying any existing code |
| **DAG integrity** | 8 integrity checks pass after any sequence of operations |

### 1.3 Non-Goals

- Hosted SaaS / multi-tenant auth (Phase 3)
- UI / dashboard
- Embeddings-first RAG (DAG is primary; vector index is optional add-on)
- Framework-specific runtime ownership (LedgerMind is infrastructure, not an agent framework)

### 1.4 Reference Implementation

This design is informed by the Volt codebase (`Martian-Engineering/volt`), specifically the `packages/voltcode/src/session/lcm/` module. Key patterns adopted and adapted:

| Volt Pattern | LedgerMind Adaptation |
|---|---|
| Namespace-based modules with coupled SQL | Clean Architecture layers with port interfaces |
| Inline SQL in `db.ts` | Repository adapters implementing domain-defined ports |
| Direct LLM calls in `summarize.ts` | `SummarizerPort` abstraction with strategy pattern |
| Hardcoded threshold logic | Configurable `CompactionPolicy` value object |
| Bun-specific APIs | Platform-agnostic abstractions via ports |

---

## 2. Glossary

| Term | Definition |
|------|-----------|
| **Ledger Event** | An immutable record (user message, assistant response, tool result) persisted to the append-only store |
| **Active Context** | The mutable projection of ledger events + summary nodes currently sent to the LLM |
| **Context Item** | A pointer within the active context referencing either a raw message or a summary node |
| **Summary Node** | A DAG vertex — either a **leaf** (summarizes messages) or **condensed** (summarizes other summaries) |
| **DAG Edge** | A directed relationship from a summary node to its source(s) — messages for leaves, parent summaries for condensed nodes |
| **Artifact** | A large file or tool output stored externally with a content-addressed ID |
| **Explorer** | A type-aware plugin that produces a structural summary of a large file |
| **τ_soft** | Soft threshold — triggers asynchronous (non-blocking) compaction |
| **τ_hard** | Hard threshold — triggers blocking compaction before LLM inference |
| **Escalation** | The three-level compaction strategy: normal → aggressive → deterministic fallback |
| **Compaction** | The process of replacing raw messages or summaries in active context with more compressed summary nodes |
| **Materialization** | Assembling the final model-ready context from the active context projection |

---

## 3. Architectural Principles

### 3.1 Clean Architecture — The Dependency Rule

All source code dependencies point **inward**. Inner layers define abstractions; outer layers implement them.

```
┌─────────────────────────────────────────────────┐
│                Infrastructure                    │
│  (PostgreSQL, SQLite, filesystem, job runners)   │
│  ┌─────────────────────────────────────────────┐ │
│  │            Interface Adapters               │ │
│  │  (tool mappers, framework wrappers, Zod)    │ │
│  │  ┌─────────────────────────────────────────┐│ │
│  │  │        Application / Use Cases         │││
│  │  │  (compaction, materialization, tools)   │││
│  │  │  ┌─────────────────────────────────────┐│││
│  │  │  │           Domain                   ││││
│  │  │  │  (entities, value objects,         ││││
│  │  │  │   domain services, events)         ││││
│  │  │  └─────────────────────────────────────┘│││
│  │  └─────────────────────────────────────────┘││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

### 3.2 SOLID Enforcement

| Principle | Enforcement Mechanism |
|-----------|----------------------|
| **S — Single Responsibility** | Each module has one reason to change. Token accounting is separate from SQL schema. Compaction policy is separate from compaction execution. |
| **O — Open/Closed** | New storage backends, explorers, summarization strategies, and framework adapters added via ports — never by editing existing use cases. Explorer registry + strategy pattern. |
| **L — Liskov Substitution** | Ports define behavioral contracts (idempotency, ordering, consistency). Any adapter implementing a port must satisfy those contracts. Contract tests verify substitutability. |
| **I — Interface Segregation** | Storage is not one "God interface." Split into `LedgerAppendPort`, `LedgerReadPort`, `ContextProjectionPort`, `SummaryDagPort`, `ArtifactStorePort`. Clients depend only on the ports they use. |
| **D — Dependency Inversion** | Application layer depends on port interfaces defined in `application/ports/`. Infrastructure provides concrete implementations. Domain has zero external dependencies. |

### 3.3 Volt Coupling Avoidance Checklist

- ✅ No raw SQL in application or domain layers
- ✅ No LLM provider calls from domain
- ✅ No framework SDK types (Vercel, LangChain, OpenAI) inside core
- ✅ No Bun-specific or Node-specific APIs in domain/application
- ✅ Zod schemas live at adapter boundaries only, not in domain
- ✅ Content hashing is an injected primitive, not a hardcoded implementation

---

## 4. System Context (C4 Level 1)

### 4.1 System Context Diagram

```
                    ┌───────────────┐
                    │  Agent Runtime │
                    │ (Vercel AI SDK,│
                    │  LangChain,    │
                    │  OpenAI, etc.) │
                    └───────┬───────┘
                            │ append events, materialize context,
                            │ invoke tools
                            ▼
                    ┌───────────────┐
                    │  LedgerMind   │
                    │  Memory Engine│
                    └──┬────┬────┬──┘
                       │    │    │
              ┌────────┘    │    └────────┐
              ▼             ▼             ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ Database │  │   LLM    │  │   File   │
      │ (PG/     │  │ Provider │  │  System  │
      │  SQLite) │  │(for sums)│  │(artifacts│
      └──────────┘  └──────────┘  └──────────┘
```

### 4.2 Primary Actors

| Actor | Role |
|-------|------|
| **Agent Runtime** | Calls LedgerMind to append events, materialize context, and register tools |
| **LLM Provider** | Used by compaction engine for summarization (via `SummarizerPort`) |
| **Database** | Persistent store for ledger, DAG, context projection, artifacts |
| **File System** | Storage for path-backed large files; source for explorer analysis |
| **Background Worker** | Executes async compaction jobs and explorer tasks |

---

## 5. Layered Architecture Overview

### 5.1 Domain Layer

**Responsibility:** Define entities, value objects, domain services, domain events, and invariants. Pure business logic with zero external dependencies.

**Forbidden:** SQL, HTTP, filesystem I/O, LLM calls, Zod, framework SDKs, platform-specific APIs.

**Contains:**
- Entity definitions with invariants
- Value objects for type safety
- Domain services (pure logic)
- Domain events (data-only)
- Domain error types

### 5.2 Application Layer

**Responsibility:** Orchestrate use cases by composing domain logic with port interfaces. Define ports. Manage transaction boundaries and idempotency.

**Forbidden:** Concrete DB adapters, concrete LLM adapters, framework SDK types, raw SQL.

**Contains:**
- Use case implementations
- Port interface definitions
- DTOs for input/output boundaries
- Compaction policies and strategies
- Application-level error types

### 5.3 Interface Adapter Layer

**Responsibility:** Map between external representations and application DTOs. Validation at boundaries. Framework-specific tool wrappers.

**Contains:**
- Zod schemas for validation
- Framework tool adapters (Vercel AI SDK, LangChain, OpenAI Agents SDK)
- REST/HTTP mappers (Phase 3)
- DB row ↔ DTO mappers

### 5.4 Infrastructure Layer

**Responsibility:** Concrete implementations of all ports. Platform-specific code.

**Contains:**
- PostgreSQL adapter (SQL, migrations, connection pooling)
- SQLite adapter (embedded alternative)
- Tokenizer bindings (tiktoken, provider-specific)
- SHA-256 hashing implementation
- Job queue implementation
- Observability wiring (metrics, structured logging)

---

## 6. Domain Model

### 6.1 Aggregates & Entities

#### Conversation (Aggregate Root)

```typescript
// domain/entities/conversation.ts
interface Conversation {
  readonly id: ConversationId;
  readonly parentId: ConversationId | null;  // sub-agent lineage
  readonly config: ConversationConfig;
  readonly createdAt: Timestamp;
}

interface ConversationConfig {
  readonly modelName: string;
  readonly contextWindow: TokenCount;
  readonly thresholds: CompactionThresholds;
}
```

**Invariants:**
- `contextWindow` must be > 0
- `thresholds.soft` < `thresholds.hard`
- `parentId` must reference an existing conversation (referential integrity)

#### LedgerEvent (Entity — Immutable)

```typescript
// domain/entities/ledger-event.ts
interface LedgerEvent {
  readonly id: EventId;
  readonly conversationId: ConversationId;
  readonly sequence: SequenceNumber;       // monotonically increasing per conversation
  readonly role: MessageRole;              // system | user | assistant | tool
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly occurredAt: Timestamp;
  readonly metadata: EventMetadata;
}
```

**Invariants:**
- Events are **never mutated or deleted**
- `sequence` is monotonically increasing within a conversation
- `tokenCount` is always ≥ 0
- `content` hash matches `id` derivation

#### SummaryNode (Entity)

```typescript
// domain/entities/summary-node.ts
type SummaryKind = "leaf" | "condensed";

interface SummaryNode {
  readonly id: SummaryNodeId;              // content-addressed: "sum_" + SHA-256(content + timestamp)
  readonly conversationId: ConversationId;
  readonly kind: SummaryKind;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly artifactIds: ArtifactId[];      // propagated file references
  readonly createdAt: Timestamp;
}
```

**Invariants:**
- `id` is deterministic given content + timestamp
- A `leaf` node covers ≥ 1 raw messages
- A `condensed` node covers ≥ 1 parent summaries
- DAG is **acyclic** (no cycles in parent relationships)
- `artifactIds` are propagated through all compaction rounds (never lost)

#### DagEdge (Entity)

```typescript
// domain/entities/dag-edge.ts
type DagEdge =
  | { readonly summaryId: SummaryNodeId; readonly messageId: EventId; readonly order: number }      // leaf → message
  | { readonly summaryId: SummaryNodeId; readonly parentSummaryId: SummaryNodeId; readonly order: number }; // condensed → summary
```

#### ContextItem (Entity — Mutable Projection)

```typescript
// domain/entities/context-item.ts
type ContextItemRef =
  | { readonly type: "message"; readonly messageId: EventId }
  | { readonly type: "summary"; readonly summaryId: SummaryNodeId };

interface ContextItem {
  readonly conversationId: ConversationId;
  readonly position: number;               // ordered index
  readonly ref: ContextItemRef;
}
```

**Invariants:**
- Positions are contiguous (no gaps)
- Every ref points to an existing ledger event or summary node
- Context is rebuildable from ledger + DAG (projection, not source of truth)

#### Artifact (Entity)

```typescript
// domain/entities/artifact.ts
type StorageKind = "path" | "inline_text" | "inline_binary";

interface Artifact {
  readonly id: ArtifactId;                 // content-addressed: "file_" + SHA-256
  readonly conversationId: ConversationId;
  readonly storageKind: StorageKind;
  readonly originalPath: string | null;
  readonly mimeType: MimeType;
  readonly tokenCount: TokenCount;
  readonly explorationSummary: string | null;
  readonly explorerUsed: string | null;
}
```

**Invariants:**
- For `path` storage: `originalPath` must be non-null
- Content bytes/text match the content hash used to derive `id`
- `tokenCount` is an estimate (not exact) for path-backed files

### 6.2 Value Objects

```typescript
// domain/value-objects/

// Branded types for type safety
type ConversationId = string & { readonly __brand: "ConversationId" };
type EventId = string & { readonly __brand: "EventId" };
type SummaryNodeId = string & { readonly __brand: "SummaryNodeId" };
type ArtifactId = string & { readonly __brand: "ArtifactId" };
type SequenceNumber = number & { readonly __brand: "SequenceNumber" };

// Token accounting
interface TokenCount {
  readonly value: number;  // must be >= 0
}

interface TokenBudget {
  readonly contextWindow: TokenCount;
  readonly overhead: TokenCount;           // system prompt + tool definitions
  readonly reserve: TokenCount;            // output token reservation
  readonly available: TokenCount;          // contextWindow - overhead - reserve
}

interface CompactionThresholds {
  readonly soft: number;                   // fraction of context window (default 0.6)
  readonly hard: number;                   // fraction (default 1.0 minus overhead)
}

// Identity
interface ContentHash {
  readonly algorithm: "sha256";
  readonly hex: string;
}

// Message role
type MessageRole = "system" | "user" | "assistant" | "tool";

// MIME
type MimeType = string & { readonly __brand: "MimeType" };

// Timestamp
type Timestamp = Date & { readonly __brand: "Timestamp" };
```

### 6.3 Domain Events

Domain events are emitted by domain logic, published by application use cases, and consumed by adapters/infrastructure for side effects.

```typescript
// domain/events/

interface LedgerEventAppended {
  readonly type: "LedgerEventAppended";
  readonly conversationId: ConversationId;
  readonly eventId: EventId;
  readonly sequence: SequenceNumber;
  readonly tokenCount: TokenCount;
}

interface CompactionTriggered {
  readonly type: "CompactionTriggered";
  readonly conversationId: ConversationId;
  readonly trigger: "soft" | "hard";
  readonly currentTokens: TokenCount;
  readonly threshold: TokenCount;
}

interface SummaryNodeCreated {
  readonly type: "SummaryNodeCreated";
  readonly conversationId: ConversationId;
  readonly nodeId: SummaryNodeId;
  readonly kind: SummaryKind;
  readonly level: EscalationLevel;
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly coveredItemCount: number;
}

interface ArtifactStored {
  readonly type: "ArtifactStored";
  readonly conversationId: ConversationId;
  readonly artifactId: ArtifactId;
  readonly storageKind: StorageKind;
  readonly tokenCount: TokenCount;
}

interface ContextMaterialized {
  readonly type: "ContextMaterialized";
  readonly conversationId: ConversationId;
  readonly budgetUsed: TokenCount;
  readonly budgetTotal: TokenCount;
  readonly itemCount: number;
}

type DomainEvent =
  | LedgerEventAppended
  | CompactionTriggered
  | SummaryNodeCreated
  | ArtifactStored
  | ContextMaterialized;
```

### 6.4 Domain Services (Pure Logic)

```typescript
// domain/services/token-budget.service.ts
interface TokenBudgetService {
  computeBudget(config: ConversationConfig, overhead: TokenCount): TokenBudget;
  isOverSoftThreshold(currentTokens: TokenCount, budget: TokenBudget): boolean;
  isOverHardThreshold(currentTokens: TokenCount, budget: TokenBudget): boolean;
  computeTargetFreeTokens(budget: TokenBudget, freePercentage: number): TokenCount;
}

// domain/services/compaction-policy.service.ts
interface CompactionPolicyService {
  selectCandidates(
    contextItems: ContextItem[],
    pinRules: PinRule[],
  ): CompactionCandidate[];
  shouldEscalate(inputTokens: TokenCount, outputTokens: TokenCount): boolean;
}

// domain/services/id.service.ts
interface IdService {
  generateSummaryId(content: string, timestamp: Timestamp): SummaryNodeId;
  generateArtifactId(input: ArtifactIdInput): ArtifactId;
  generateEventId(content: string, conversationId: ConversationId, sequence: SequenceNumber): EventId;
}
```

### 6.5 Domain Errors

```typescript
// domain/errors/
class DomainError extends Error { readonly code: string; }

class InvalidDagEdgeError extends DomainError { }     // cycle detected or invalid reference
class HashMismatchError extends DomainError { }        // content doesn't match ID
class BudgetExceededError extends DomainError { }      // negative available budget
class InvariantViolationError extends DomainError { }  // generic invariant failure
class NonMonotonicSequenceError extends DomainError { } // sequence ordering violated
```

---

## 7. Use Cases (Application Layer)

Each use case defines: purpose, input, output, steps, failure modes, and transactional guarantees.

### 7.1 AppendLedgerEvents

**Purpose:** Persist new events to the immutable ledger and update active context.

```typescript
// application/use-cases/append-ledger-events.ts
interface AppendLedgerEventsInput {
  conversationId: ConversationId;
  events: NewLedgerEvent[];
  idempotencyKey?: string;
}

interface AppendLedgerEventsOutput {
  appendedEvents: LedgerEvent[];
  contextTokenCount: TokenCount;
}
```

**Steps:**
1. Validate idempotency key (skip if already processed)
2. Assign monotonic sequence numbers
3. Generate content-addressed event IDs
4. Persist events via `LedgerAppendPort`
5. Append context items via `ContextProjectionPort`
6. Emit `LedgerEventAppended` events
7. Check thresholds — schedule async compaction if over soft

**Transaction:** All events in a single call are atomic (single UoW).

### 7.2 MaterializeContext

**Purpose:** Assemble model-ready context within token budget.

```typescript
// application/use-cases/materialize-context.ts
interface MaterializeContextInput {
  conversationId: ConversationId;
  budgetTokens: number;
  overheadTokens: number;
  pinRules?: PinRule[];
  retrievalHints?: RetrievalHint[];
}

interface MaterializeContextOutput {
  systemPreamble: string;
  modelMessages: ModelMessage[];         // role + content, ready for LLM API
  summaryReferences: SummaryReference[]; // IDs available for tool calls
  artifactReferences: ArtifactReference[];
  budgetUsed: TokenCount;
}
```

**Steps:**
1. Compute token budget via `TokenBudgetService`
2. If over hard threshold → run `CompactionUseCase` (blocking)
3. Fetch current context via `ContextProjectionPort`
4. Inject summary ID headers into summary content
5. Assemble model messages with pinned items first, then recent, then relevant
6. Truncate to budget if needed
7. Emit `ContextMaterialized` event

**Guarantee:** Output `budgetUsed` ≤ input `budgetTokens - overheadTokens` OR returns `BudgetExceededError`.

### 7.3 RunCompaction (Core Engine)

**Purpose:** Reduce active context token count via summarization and condensation.

```typescript
// application/use-cases/run-compaction.ts
interface RunCompactionInput {
  conversationId: ConversationId;
  trigger: "soft" | "hard";
  targetTokens?: TokenCount;
}

interface RunCompactionOutput {
  rounds: number;
  nodesCreated: SummaryNodeId[];
  tokensFreed: TokenCount;
  converged: boolean;
}
```

**Steps (LCM Control Loop):**
```
1. Compute current context token count
2. Compute target = available budget × (1 - TARGET_FREE_PERCENTAGE)
3. round = 0
4. WHILE currentTokens > target AND round < MAX_ROUNDS (10):
     a. Select compaction candidates (oldest non-pinned block)
     b. Run escalation chain:
        i.   Normal summarization via SummarizerPort
        ii.  IF outputTokens >= inputTokens → Aggressive summarization
        iii. IF still not reduced → Deterministic fallback (512 tokens, no LLM)
     c. Create SummaryNode in DAG via SummaryDagPort
     d. Replace context items with summary pointer via ContextProjectionPort
     e. Emit SummaryNodeCreated event
     f. round++
5. IF trigger == "hard" AND still over budget → CompactionFailedToConverge error
6. Emit CompactionCompleted event
```

**Strategy Pattern — Escalation:**

```typescript
// application/strategies/summarization-strategy.ts
interface SummarizationStrategy {
  readonly level: EscalationLevel;
  summarize(input: SummarizationInput): Promise<SummarizationOutput>;
}

type EscalationLevel = 1 | 2 | 3;

// Implementations:
// Level 1: NormalSummarizationStrategy — full detail preservation via LLM
// Level 2: AggressiveSummarizationStrategy — bullet points, target T/2 via LLM
// Level 3: DeterministicFallbackStrategy — truncate to 512 tokens, no LLM call
```

**Convergence Guarantee:** Level 3 always produces ≤ 512 tokens regardless of input. Since `shouldEscalate()` triggers when output ≥ input, and Level 3 is deterministic, the loop provably terminates.

### 7.4 Memory Tools

#### GrepUseCase

```typescript
interface GrepInput {
  conversationId: ConversationId;
  pattern: string;                         // regex pattern
  scope?: SummaryNodeId;                   // optional DAG scope
}
interface GrepOutput {
  matches: GrepMatch[];                    // grouped by covering summary
}
```

#### DescribeUseCase

```typescript
interface DescribeInput {
  id: SummaryNodeId | ArtifactId;
}
interface DescribeOutput {
  kind: "summary" | "artifact";
  metadata: Record<string, unknown>;
  tokenCount: TokenCount;
  parentIds?: SummaryNodeId[];
  explorationSummary?: string;
}
```

#### ExpandUseCase (Guarded)

```typescript
interface ExpandInput {
  summaryId: SummaryNodeId;
  callerContext: CallerContext;             // includes isSubAgent flag
}
interface ExpandOutput {
  messages: LedgerEvent[];                 // original messages under the summary
}
```

**Authorization gate:** Expand is restricted to sub-agent callers via `AuthorizationPort`. This prevents uncontrolled context expansion in the main agent loop — a safety pattern from Volt.

### 7.5 StoreArtifact & ExploreArtifact

```typescript
// Store
interface StoreArtifactInput {
  conversationId: ConversationId;
  source: { kind: "path"; path: string } | { kind: "text"; content: string } | { kind: "binary"; data: Buffer };
  mimeType?: MimeType;
}
interface StoreArtifactOutput {
  artifactId: ArtifactId;
  tokenCount: TokenCount;
}

// Explore
interface ExploreArtifactInput {
  artifactId: ArtifactId;
  explorerHints?: { preferredExplorer?: string };
}
interface ExploreArtifactOutput {
  explorerUsed: string;
  summary: string;
  metadata: Record<string, unknown>;
  tokenCount: TokenCount;
}
```

### 7.6 Operator-Level Recursion

#### LLMMapUseCase

```typescript
interface LLMMapInput {
  items: unknown[];                        // or JSONL file path
  prompt: string;
  outputSchema: JsonSchema;
  concurrency?: number;                    // default 16
  retryPolicy?: { maxRetries: number };    // default 3
}
interface LLMMapOutput {
  results: unknown[];
  artifactId: ArtifactId;                  // stored output file
  failures: { index: number; error: string }[];
}
```

**Steps:**
1. Register input as artifact
2. Create worker pool with concurrency limit
3. Each worker: stateless LLM call → schema validation → retry on failure
4. Collect results → write output JSONL → register as artifact
5. Return summary handle (not full content) to active context

#### AgenticMapUseCase

Same interface but spawns full sub-agent sessions per item with tool access. Sub-agents inherit parent conversation lineage.

---

## 8. Ports (Interfaces)

### 8.1 Driving Ports (External → LedgerMind)

```typescript
// application/ports/driving/

// Primary facade — the public API
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

// Tool provider — creates framework-specific tool definitions
interface ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[];
}

// Event subscriber — for external systems to react to domain events
interface DomainEventSubscriber {
  on(event: DomainEvent): void;
}
```

### 8.2 Driven Ports (LedgerMind → External)

Split by **Interface Segregation Principle** — no God interfaces:

#### Persistence Ports

```typescript
// application/ports/driven/persistence/

interface LedgerAppendPort {
  appendEvents(conversationId: ConversationId, events: LedgerEvent[]): Promise<void>;
  getNextSequence(conversationId: ConversationId): Promise<SequenceNumber>;
}

interface LedgerReadPort {
  getEvents(conversationId: ConversationId, range?: SequenceRange): Promise<LedgerEvent[]>;
  searchEvents(conversationId: ConversationId, query: string): Promise<LedgerEvent[]>;
  regexSearchEvents(conversationId: ConversationId, pattern: string, scope?: SummaryNodeId): Promise<GrepMatch[]>;
}

interface ContextProjectionPort {
  getCurrentContext(conversationId: ConversationId): Promise<ContextItem[]>;
  getContextTokenCount(conversationId: ConversationId): Promise<TokenCount>;
  appendContextItems(conversationId: ConversationId, items: ContextItem[]): Promise<void>;
  replaceContextItems(
    conversationId: ConversationId,
    positionsToRemove: number[],
    replacement: ContextItem,
  ): Promise<void>;
}

interface SummaryDagPort {
  createNode(node: SummaryNode): Promise<void>;
  getNode(id: SummaryNodeId): Promise<SummaryNode | null>;
  addLeafEdges(summaryId: SummaryNodeId, messageIds: EventId[]): Promise<void>;
  addCondensedEdges(summaryId: SummaryNodeId, parentSummaryIds: SummaryNodeId[]): Promise<void>;
  expandToMessages(summaryId: SummaryNodeId): Promise<LedgerEvent[]>;  // recursive walk
  searchSummaries(conversationId: ConversationId, query: string): Promise<SummaryNode[]>;
  checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport>;
}

interface ArtifactStorePort {
  store(artifact: Artifact, content?: Buffer | string): Promise<void>;
  getMetadata(id: ArtifactId): Promise<Artifact | null>;
  getContent(id: ArtifactId): Promise<Buffer | string | null>;
  updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void>;
}

interface ConversationPort {
  create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation>;
  get(id: ConversationId): Promise<Conversation | null>;
  getAncestorChain(id: ConversationId): Promise<ConversationId[]>;
}
```

#### Transaction Port

```typescript
// application/ports/driven/persistence/

interface UnitOfWorkPort {
  execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

interface UnitOfWork {
  readonly ledger: LedgerAppendPort;
  readonly context: ContextProjectionPort;
  readonly dag: SummaryDagPort;
  readonly artifacts: ArtifactStorePort;
  readonly conversations: ConversationPort;
}
```

#### LLM & Tokenization Ports

```typescript
// application/ports/driven/llm/

interface SummarizerPort {
  summarize(input: SummarizationInput): Promise<SummarizationOutput>;
}

interface SummarizationInput {
  messages: { role: MessageRole; content: string }[];
  mode: "normal" | "aggressive";
  targetTokens?: number;
  artifactIdsToPreserve: ArtifactId[];
}

interface SummarizationOutput {
  content: string;
  tokenCount: TokenCount;
  preservedArtifactIds: ArtifactId[];
}

interface TokenizerPort {
  countTokens(text: string): TokenCount;
  estimateFromBytes(byteLength: number): TokenCount;
}
```

#### Explorer Port

```typescript
// application/ports/driven/explorer/

interface ExplorerPort {
  readonly name: string;
  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number; // 0 = no, higher = better match
  explore(input: ExplorerInput): Promise<ExplorerOutput>;
}

interface ExplorerInput {
  content: string | Buffer;
  path: string;
  mimeType: MimeType;
  maxTokens?: number;
}

interface ExplorerOutput {
  summary: string;
  metadata: Record<string, unknown>;
  tokenCount: TokenCount;
}

interface ExplorerRegistryPort {
  register(explorer: ExplorerPort): void;
  resolve(mimeType: MimeType, path: string, hints?: ExplorerHints): ExplorerPort;
}
```

#### Background Job Port

```typescript
// application/ports/driven/jobs/

interface JobQueuePort {
  enqueue<T>(job: Job<T>): Promise<JobId>;
  onComplete(jobId: JobId, callback: (result: unknown) => void): void;
}

interface Job<T> {
  type: string;
  payload: T;
  priority?: "low" | "normal" | "high";
}
```

#### Authorization Port

```typescript
// application/ports/driven/auth/

interface AuthorizationPort {
  canExpand(caller: CallerContext): boolean;
  canReadArtifact(caller: CallerContext, artifactId: ArtifactId): boolean;
}

interface CallerContext {
  conversationId: ConversationId;
  isSubAgent: boolean;
  parentConversationId?: ConversationId;
}
```

#### Clock Port (Testability)

```typescript
// application/ports/driven/clock/

interface ClockPort {
  now(): Timestamp;
}
```

---

## 9. Adapters

### 9.1 Storage Adapters

#### PostgreSQL Adapter (Primary)

| Port | Implementation Notes |
|------|---------------------|
| `LedgerAppendPort` | `INSERT INTO ledger_events` with `ON CONFLICT DO NOTHING` for idempotency |
| `LedgerReadPort` | FTS via `plainto_tsquery`, regex via `~` operator, recursive CTE for ancestor chains |
| `ContextProjectionPort` | `context_items` table with ordered positions |
| `SummaryDagPort` | `summary_nodes` + `summary_edges` tables; recursive CTE for `expandToMessages()` |
| `ArtifactStorePort` | `artifacts` table with `path`, `inline_text`, `inline_binary` variants |
| `UnitOfWorkPort` | PostgreSQL transaction with `BEGIN`/`COMMIT`/`ROLLBACK` |

**Schema enforcement:**
- `ledger_events` has no `UPDATE`/`DELETE` triggers (append-only by convention + optional trigger guard)
- GIN indexes on `tsvector` columns for FTS
- `UNIQUE (conversation_id, seq)` enforces monotonic ordering
- `CHECK` constraint on `context_items` ensures exactly one ref type

#### SQLite Adapter (Embedded)

Compatible schema subset. Key differences documented:
- FTS via SQLite FTS5 extension (different syntax from PostgreSQL `tsvector`)
- Recursive CTE support available but performance differs at scale
- No `tsvector` — use FTS5 virtual tables instead
- Single-writer constraint (WAL mode recommended)

### 9.2 LLM Provider Adapters

Implement `SummarizerPort`:

| Adapter | Notes |
|---------|-------|
| **OpenAI** | `ChatCompletion.create()` with system prompt for summarization |
| **Anthropic** | `messages.create()` with summarization instructions |
| **Vercel AI SDK** | `generateText()` wrapper |
| **Generic** | Any provider exposing a chat completion API |

Each adapter handles retry/backoff internally. Deterministic fallback (Level 3) is in the application layer — no LLM call.

### 9.3 Framework Tool Adapters

Implement `ToolProviderPort`:

| Framework | Tool Mapping |
|-----------|-------------|
| **Vercel AI SDK** | `tool()` definitions for `memory.grep`, `memory.describe`, `memory.expand` |
| **OpenAI Agents SDK** | Function schemas with JSON Schema parameters |
| **LangChain** | `StructuredTool` subclass or `DynamicStructuredTool` |
| **Generic** | Plain objects with `{ name, description, parameters, execute }` |

### 9.4 Explorer Plugin Adapters

Built-in explorers register with `ExplorerRegistryPort`:

| Explorer | File Types | Strategy |
|----------|-----------|----------|
| `PythonExplorer` | `.py` | AST-based: classes, functions, imports |
| `TypeScriptExplorer` | `.ts`, `.tsx`, `.js`, `.jsx` | Parser-driven structural analysis |
| `GoExplorer` | `.go` | Package, type, function signatures |
| `RustExplorer` | `.rs` | `struct`, `impl`, `fn` extraction |
| `JsonExplorer` | `.json` | Schema shape, key structure, array lengths |
| `CsvExplorer` | `.csv` | Column names, row count, value distributions |
| `SqlExplorer` | `.sql` | Statement types, table references |
| `YamlExplorer` | `.yaml`, `.yml` | Key structure, nested depth |
| `MarkdownExplorer` | `.md` | Heading structure, section summaries |
| `PdfExplorer` | `.pdf` | Page count, text extraction, structure |
| `ImageExplorer` | `.png`, `.jpg`, etc. | Dimensions, format, basic metadata |
| `LogExplorer` | `.log` | Pattern detection, error frequency |
| `FallbackExplorer` | `*` | LLM-generated summary (200KB sample for large files) |

**Third-party extension:** New explorers are added by implementing `ExplorerPort` and registering with the registry — zero modifications to existing code (OCP).

---

## 10. Package Structure

```
packages/
├── domain/                          # Zero external dependencies
│   ├── package.json                 # { "dependencies": {} }
│   └── src/
│       ├── entities/
│       │   ├── conversation.ts
│       │   ├── ledger-event.ts
│       │   ├── summary-node.ts
│       │   ├── dag-edge.ts
│       │   ├── context-item.ts
│       │   └── artifact.ts
│       ├── value-objects/
│       │   ├── token-count.ts
│       │   ├── token-budget.ts
│       │   ├── compaction-thresholds.ts
│       │   ├── content-hash.ts
│       │   ├── ids.ts
│       │   └── message-role.ts
│       ├── services/
│       │   ├── token-budget.service.ts
│       │   ├── compaction-policy.service.ts
│       │   └── id.service.ts
│       ├── events/
│       │   └── domain-events.ts
│       └── errors/
│           └── domain-errors.ts
│
├── application/                     # Depends on: domain
│   ├── package.json                 # { "dependencies": { "@ledgermind/domain": "..." } }
│   └── src/
│       ├── use-cases/
│       │   ├── append-ledger-events.ts
│       │   ├── materialize-context.ts
│       │   ├── run-compaction.ts
│       │   ├── grep.ts
│       │   ├── describe.ts
│       │   ├── expand.ts
│       │   ├── store-artifact.ts
│       │   ├── explore-artifact.ts
│       │   ├── llm-map.ts
│       │   └── agentic-map.ts
│       ├── ports/
│       │   ├── driving/
│       │   │   ├── memory-engine.port.ts
│       │   │   ├── tool-provider.port.ts
│       │   │   └── event-subscriber.port.ts
│       │   └── driven/
│       │       ├── persistence/
│       │       │   ├── ledger-append.port.ts
│       │       │   ├── ledger-read.port.ts
│       │       │   ├── context-projection.port.ts
│       │       │   ├── summary-dag.port.ts
│       │       │   ├── artifact-store.port.ts
│       │       │   ├── conversation.port.ts
│       │       │   └── unit-of-work.port.ts
│       │       ├── llm/
│       │       │   ├── summarizer.port.ts
│       │       │   └── tokenizer.port.ts
│       │       ├── explorer/
│       │       │   ├── explorer.port.ts
│       │       │   └── explorer-registry.port.ts
│       │       ├── jobs/
│       │       │   └── job-queue.port.ts
│       │       ├── auth/
│       │       │   └── authorization.port.ts
│       │       └── clock/
│       │           └── clock.port.ts
│       ├── strategies/
│       │   ├── summarization-strategy.ts
│       │   ├── normal-summarization.ts
│       │   ├── aggressive-summarization.ts
│       │   └── deterministic-fallback.ts
│       ├── dto/
│       │   └── *.ts
│       └── errors/
│           └── application-errors.ts
│
├── adapters/                        # Depends on: application, domain
│   ├── package.json
│   └── src/
│       ├── storage/
│       │   ├── postgres/
│       │   │   ├── pg-ledger.adapter.ts
│       │   │   ├── pg-context.adapter.ts
│       │   │   ├── pg-summary-dag.adapter.ts
│       │   │   ├── pg-artifact.adapter.ts
│       │   │   ├── pg-conversation.adapter.ts
│       │   │   ├── pg-unit-of-work.adapter.ts
│       │   │   └── mappers/
│       │   │       └── *.ts               # Row ↔ DTO ↔ Domain mappers
│       │   └── sqlite/
│       │       └── ...                    # Same structure for SQLite
│       ├── llm/
│       │   ├── openai-summarizer.adapter.ts
│       │   ├── anthropic-summarizer.adapter.ts
│       │   └── vercel-ai-summarizer.adapter.ts
│       ├── tokenizer/
│       │   ├── tiktoken.adapter.ts
│       │   └── simple-estimator.adapter.ts
│       ├── tools/
│       │   ├── vercel-ai-tools.adapter.ts
│       │   ├── openai-agents-tools.adapter.ts
│       │   ├── langchain-tools.adapter.ts
│       │   └── generic-tools.adapter.ts
│       ├── explorers/
│       │   ├── registry.ts
│       │   ├── python-explorer.ts
│       │   ├── typescript-explorer.ts
│       │   ├── json-explorer.ts
│       │   ├── csv-explorer.ts
│       │   └── ...                        # 30+ explorer implementations
│       ├── jobs/
│       │   ├── in-memory-queue.adapter.ts
│       │   └── pg-boss-queue.adapter.ts
│       └── validation/
│           └── schemas/                   # Zod schemas (boundary validation)
│               └── *.ts
│
├── infrastructure/                  # Depends on: adapters, application
│   ├── package.json
│   └── src/
│       ├── sql/
│       │   ├── postgres/
│       │   │   └── migrations/
│       │   │       ├── 001_initial.sql
│       │   │       └── ...
│       │   └── sqlite/
│       │       └── migrations/
│       │           └── ...
│       ├── crypto/
│       │   └── sha256.ts
│       ├── observability/
│       │   ├── metrics.ts
│       │   └── structured-logger.ts
│       └── config/
│           └── env.ts
│
└── sdk/                             # Public API package
    ├── package.json                 # { "dependencies": all internal packages }
    └── src/
        ├── index.ts                 # MemoryEngine factory + re-exports
        ├── create-engine.ts
        └── presets/
            ├── postgres.ts          # Pre-wired PostgreSQL setup
            └── sqlite.ts            # Pre-wired SQLite setup
```

### Dependency Rule Enforcement

| Package | May Import | Must NOT Import |
|---------|-----------|----------------|
| `domain` | Nothing (zero deps) | application, adapters, infrastructure, any npm package |
| `application` | `domain` | adapters, infrastructure, SQL, LLM SDKs, Zod |
| `adapters` | `application`, `domain` | infrastructure internals |
| `infrastructure` | `adapters`, `application`, `domain` | — |
| `sdk` | All internal packages | — |

**Enforcement mechanisms:**
- TypeScript project references with `composite: true`
- ESLint boundary rules (e.g., `eslint-plugin-boundaries` or `@nx/enforce-module-boundaries`)
- Package-level `package.json` with explicit dependency declarations

---

## 11. Data Model & Persistence Mapping

### 11.1 PostgreSQL Schema

```sql
-- Enums
CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
CREATE TYPE summary_kind AS ENUM ('leaf', 'condensed');
CREATE TYPE context_item_type AS ENUM ('message', 'summary');
CREATE TYPE storage_kind AS ENUM ('path', 'inline_text', 'inline_binary');

-- 1. Conversations
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES conversations(id),
  model_name      TEXT NOT NULL,
  context_window  INTEGER NOT NULL,
  soft_threshold  NUMERIC(5,4) NOT NULL DEFAULT 0.6000,
  hard_threshold  NUMERIC(5,4) NOT NULL DEFAULT 1.0000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Ledger Events (append-only)
CREATE TABLE ledger_events (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  role            message_role NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL CHECK (token_count >= 0),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, idempotency_key)
);
CREATE INDEX idx_ledger_events_fts ON ledger_events USING GIN (content_tsv);

-- 3. Summary Nodes (DAG vertices)
CREATE TABLE summary_nodes (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            summary_kind NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL CHECK (token_count >= 0),
  artifact_ids    JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX idx_summary_nodes_fts ON summary_nodes USING GIN (content_tsv);

-- 4. DAG Edges: Leaf → Messages
CREATE TABLE summary_message_edges (
  summary_id      TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,
  ord             INTEGER NOT NULL,
  PRIMARY KEY (summary_id, ord)
);

-- 5. DAG Edges: Condensed → Parent Summaries
CREATE TABLE summary_parent_edges (
  summary_id        TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  ord               INTEGER NOT NULL,
  PRIMARY KEY (summary_id, ord)
);

-- 6. Context Projection (mutable active context)
CREATE TABLE context_items (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  item_type       context_item_type NOT NULL,
  message_id      TEXT,
  summary_id      TEXT,
  PRIMARY KEY (conversation_id, position),
  CONSTRAINT ctx_exactly_one_ref CHECK (
    (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
    (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
  )
);

-- 7. Artifacts (large files & tool outputs)
CREATE TABLE artifacts (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  storage_kind        storage_kind NOT NULL DEFAULT 'path',
  original_path       TEXT,
  mime_type           TEXT NOT NULL,
  content_text        TEXT,
  content_binary      BYTEA,
  token_count         BIGINT NOT NULL CHECK (token_count >= 0),
  exploration_summary TEXT,
  explorer_used       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 11.2 Mapping Boundaries

```
DB Row → Adapter Mapper → Application DTO → Domain Entity
         (Zod validation)   (plain objects)   (branded types + invariants)
```

**Rule:** Domain entities never see SQL row shapes. Adapters perform all mapping.

---

## 12. Compaction & Retrieval Algorithms

### 12.1 Threshold Computation

```
contextWindow       = conversation.config.contextWindow
overhead            = systemPromptTokens + toolDefinitionTokens
reserve             = min(20_000, contextWindow × 0.25, model.maxOutputTokens)

hardLimit           = contextWindow - overhead - reserve
softThreshold       = min(contextWindow × softFraction - overhead, hardLimit)

overSoft            = currentContextTokens > softThreshold
overHard            = currentContextTokens > hardLimit
```

### 12.2 Compaction Loop (Pseudocode)

```
function runCompaction(conversationId, trigger):
  budget ← computeBudget(conversation)
  target ← budget.available × (1 - TARGET_FREE_PERCENTAGE)
  current ← getContextTokenCount(conversationId)
  round ← 0
  created ← []

  while current > target AND round < MAX_ROUNDS:
    candidates ← selectCandidates(getContext(conversationId), pinRules)
    if candidates.empty: break

    block ← candidates.oldest
    result ← escalate(block):
      L1: summary ← summarizer.summarize(block.messages, mode="normal")
          if summary.tokenCount < block.tokenCount → ACCEPT
      L2: summary ← summarizer.summarize(block.messages, mode="aggressive")
          if summary.tokenCount < block.tokenCount → ACCEPT
      L3: summary ← deterministicTruncate(block.content, maxTokens=512)
          → ALWAYS ACCEPT (guaranteed convergence)

    node ← createSummaryNode(summary, block)
    saveNode(node) + saveEdges(node, block.items)
    replaceContextItems(conversationId, block.positions, node)
    created.push(node.id)
    current ← getContextTokenCount(conversationId)
    round++

  if trigger == "hard" AND current > budget.available:
    throw CompactionFailedToConverge

  return { rounds: round, created, tokensFreed, converged: current <= target }
```

### 12.3 Candidate Selection

1. Exclude pinned items (system prompt, explicit pins)
2. Sort remaining by position (oldest first)
3. Group into blocks of adjacent items (configurable block size, default: all contiguous non-pinned oldest items)
4. Return oldest block as primary candidate

### 12.4 Condensation (Multi-Summary Compaction)

When the context contains many summary nodes (after multiple rounds), condensation merges them:

1. Select adjacent summary nodes in context
2. Create condensed summary via `SummarizerPort` with parent content concatenated
3. Apply same three-level escalation
4. Replace parent summaries with single condensed node
5. Preserve all `artifactIds` from parents

### 12.5 Retrieval via DAG Walk

`expandToMessages(summaryId)` uses a recursive traversal:

```sql
WITH RECURSIVE walk(id) AS (
  SELECT summary_id FROM summary_parent_edges WHERE summary_id = $1
  UNION ALL
  SELECT spe.parent_summary_id FROM summary_parent_edges spe
  JOIN walk w ON spe.summary_id = w.id
)
SELECT le.* FROM summary_message_edges sme
JOIN walk w ON sme.summary_id = w.id
JOIN ledger_events le ON le.id = sme.message_id
ORDER BY le.seq;
```

---

## 13. Explorer Plugin Architecture

### 13.1 Plugin Interface

```typescript
interface ExplorerPort {
  readonly name: string;

  // Score 0 = can't handle; higher = better match
  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number;

  // Produce structural summary
  explore(input: ExplorerInput): Promise<ExplorerOutput>;
}
```

### 13.2 Resolution Strategy

```
1. Extension match → scored by specificity (e.g., ".tsx" > ".ts" > "*")
2. MIME type match → if no extension match
3. Magic bytes (8KB header read) → if no MIME match
4. Fallback explorer → LLM-generated summary (always available)
```

Highest score wins. Ties broken deterministically by explorer registration order.

### 13.3 Isolation Rules

- Explorers must NOT write to the database directly
- Explorers return `ExplorerOutput` to the application layer, which persists via ports
- Explorers may read file content but must respect the `maxTokens` limit
- For files > 50MB: read a 200KB sample (beginning + middle + end)

### 13.4 Conformance Testing

Every explorer must pass a conformance test suite:

```typescript
interface ExplorerConformanceTest {
  name: string;
  input: { content: string; path: string; mimeType: MimeType };
  expectations: {
    summaryContains?: string[];
    metadataKeys?: string[];
    tokenCountLessThan?: number;
  };
}
```

---

## 14. Token Budget Computation

### 14.1 Budget Model

```
┌──────────────────────────────────────────────────┐
│                  Context Window                   │
│                                                   │
│  ┌─────────────┐  ┌────────────────┐  ┌────────┐ │
│  │  Overhead    │  │   Available    │  │Reserve │ │
│  │ (sys prompt  │  │  (conversation │  │(output)│ │
│  │  + tools)    │  │   content)     │  │        │ │
│  └─────────────┘  └────────────────┘  └────────┘ │
└──────────────────────────────────────────────────┘
```

### 14.2 What Counts Toward Budget

| Category | Counted By |
|----------|-----------|
| System prompt | `TokenizerPort.countTokens()` |
| Tool definitions (schemas) | `TokenizerPort.countTokens()` |
| Pinned summaries | Stored `tokenCount` on `SummaryNode` |
| Recent messages | Stored `tokenCount` on `LedgerEvent` |
| Retrieved DAG nodes | Stored `tokenCount` |
| Summary ID headers | Estimated (small fixed overhead per summary) |

### 14.3 Estimation vs Exact Counts

- **Exact:** Used for ledger events and summary nodes (counted at creation time)
- **Estimated:** Used for path-backed artifacts (`byteLength / 4`)
- **Guardrail:** When uncertain, assume worst-case (higher estimate)
- **Drift check:** Integrity checker warns if stored vs re-estimated counts diverge > 20%

---

## 15. Error Handling Strategy

### 15.1 Error Taxonomy by Layer

#### Domain Errors (Invariant Violations)

| Error | Trigger |
|-------|---------|
| `InvalidDagEdgeError` | Cycle detected or invalid reference in DAG |
| `HashMismatchError` | Content doesn't match content-addressed ID |
| `BudgetNegativeError` | Available budget computed as negative |
| `NonMonotonicSequenceError` | Event sequence number not increasing |
| `InvariantViolationError` | Generic invariant failure |

#### Application Errors (Use Case Failures)

| Error | Trigger |
|-------|---------|
| `CompactionFailedToConvergeError` | Hard compaction exceeded MAX_ROUNDS without reaching budget |
| `UnauthorizedExpandError` | Non-sub-agent attempted `expand` |
| `IdempotencyConflictError` | Duplicate idempotency key with different content |
| `ConversationNotFoundError` | Referenced conversation doesn't exist |
| `ArtifactNotFoundError` | Referenced artifact doesn't exist |

#### Infrastructure Errors (Transient & Permanent)

| Error | Retryable | Trigger |
|-------|-----------|---------|
| `DbConnectionError` | Yes | Database connection failed |
| `DbTimeoutError` | Yes | Query timed out |
| `LlmRateLimitedError` | Yes | LLM provider rate limited |
| `LlmUnavailableError` | Yes | LLM provider temporarily down |
| `SerializationError` | No | Data corruption |
| `MigrationFailedError` | No | Schema migration failed |

### 15.2 Mapping Rules

- Infrastructure errors never leak raw driver errors across boundaries
- All errors map to typed domain/application errors at adapter boundaries
- Retryability is a property of the error type; retry logic lives in application policies

---

## 16. Testing Strategy

### 16.1 Test Pyramid by Layer

```
                    ┌───────┐
                    │  E2E  │  Golden transcript → deterministic DAG
                   ┌┴───────┴┐
                   │ Contract │  Same suite runs against PG + SQLite
                  ┌┴─────────┴┐
                  │ Application│  Use cases with in-memory fake ports
                 ┌┴───────────┴┐
                 │   Domain     │  Pure unit tests, no I/O
                 └──────────────┘
```

### 16.2 Domain Tests

- Pure unit tests — no database, no mocking
- Test invariants: hash generation, budget computation, threshold logic, sequence validation
- Test domain services: `TokenBudgetService`, `CompactionPolicyService`, `IdService`
- Example: given a budget config, verify `isOverSoftThreshold()` returns correct result

### 16.3 Application Tests

- Use cases tested with **in-memory fake ports** (not mocks — fakes with real behavior)
- Key test scenarios:
  - **Convergence:** Hard compaction always brings context under budget
  - **Escalation correctness:** Level 1 → 2 → 3 triggered in correct order
  - **Idempotency:** Duplicate append with same key is no-op
  - **Authorization gating:** Expand fails for non-sub-agent callers
  - **Artifact ID propagation:** File IDs survive arbitrary compaction rounds
  - **DAG integrity:** No cycles after any sequence of compactions

### 16.4 Adapter / Contract Tests

- **Storage contract tests:** Same test suite runs against PostgreSQL AND SQLite adapters
  - Verify: append-only invariant, FTS behavior, recursive CTE expansion, idempotency
- **Explorer conformance tests:** Golden inputs → expected output structure for each explorer
- **Summarizer adapter tests:** Verify retry behavior, token counting, artifact ID preservation

### 16.5 End-to-End Tests

- **Golden transcript test:** Fixed input transcript → run full pipeline → assert deterministic DAG state
- **Tool integration:** `grep` + `describe` + `expand` return consistent results across storage backends
- **Budget enforcement:** Verify materialized context never exceeds budget

### 16.6 Test Double Guidance

- **Prefer fakes** for ports (in-memory implementations with real logic)
- **Avoid mocking domain** — domain is pure, test it directly
- **Mock only:** external LLM calls (use recorded responses), time (inject `ClockPort`)

---

## 17. Observability & Operations

### 17.1 Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `compaction_rounds_total` | Counter | Total compaction rounds executed |
| `compaction_tokens_freed` | Histogram | Tokens freed per compaction run |
| `compaction_escalation_level` | Histogram | Escalation level reached (1/2/3) |
| `summarizer_cost_tokens` | Counter | Total tokens sent to LLM for summarization |
| `context_utilization_ratio` | Gauge | Current context tokens / available budget |
| `artifact_count` | Gauge | Number of stored artifacts per conversation |
| `job_queue_lag_seconds` | Gauge | Time between enqueue and execution |
| `dag_node_count` | Gauge | Total summary nodes in DAG |

### 17.2 Structured Logging

All log entries include correlation IDs:

```json
{
  "level": "info",
  "msg": "compaction_round_complete",
  "conversationId": "conv_abc123",
  "requestId": "req_xyz789",
  "round": 2,
  "escalationLevel": 1,
  "inputTokens": 15000,
  "outputTokens": 3200,
  "duration_ms": 1450
}
```

### 17.3 Audit Trail

Every compaction creates traceable domain events:
- `CompactionTriggered` → `SummaryNodeCreated` → `ContextMaterialized`
- Events can be replayed to reconstruct the DAG evolution history

---

## 18. Security & Safety

### 18.1 Tool Gating

| Tool | Access Level | Enforcement |
|------|-------------|-------------|
| `memory.grep` | All callers | No restriction |
| `memory.describe` | All callers | No restriction |
| `memory.expand` | Sub-agents only | `AuthorizationPort.canExpand()` check |
| `memory.read` (artifact content) | Sub-agents only | `AuthorizationPort.canReadArtifact()` check |

**Rationale (from Volt):** `expand` and full artifact reads can flood the active context with unbounded content. Restricting to sub-agents ensures the main agent loop remains within budget.

### 18.2 Data Boundaries

- Ledger events are immutable — no deletion API (only conversation-level cascade)
- No raw content in logs — only IDs and token counts
- Artifact retention policy is configurable via hooks (not hardcoded)

### 18.3 Extension Points

- **Redaction/masking:** Optional `ContentFilterPort` for PII/secret filtering before persistence
- **Encryption at rest:** Delegate to database-level encryption (transparent to application)

---

## 19. Implementation Roadmap

### Phase 1 — Core Engine (Extract + Stabilize)

**Goal:** Standalone library, works locally, no Volt assumptions.

| Deliverable | Packages | Notes |
|-------------|----------|-------|
| Domain model + value objects | `domain` | Pure TypeScript, zero deps |
| Port interfaces | `application/ports` | All driven + driving ports |
| Core use cases | `application/use-cases` | Append, Materialize, Compaction, Tools |
| PostgreSQL adapter | `adapters/storage/postgres` | Full schema + migrations |
| Basic tokenizer | `adapters/tokenizer` | Simple estimator + tiktoken |
| 5 core explorers | `adapters/explorers` | TS, Python, JSON, Markdown, Fallback |
| SDK entrypoint | `sdk` | `createMemoryEngine()` factory |
| Vercel AI SDK adapter | `adapters/tools/vercel` | First framework integration |
| Golden test suite | All packages | Deterministic DAG evolution tests |

**Non-goals:** server mode, multi-tenant, vector DB, UI

### Phase 2 — Ecosystem + Hardening

**Goal:** Easy adoption across frameworks; production safety.

| Deliverable | Notes |
|-------------|-------|
| LangChain adapter | Context provider pattern |
| OpenAI Agents SDK adapter | Tool bundle pattern |
| 25+ more explorers | Full type coverage from Volt |
| SQLite adapter | Embedded alternative for local dev |
| Operator recursion (LLM-Map, Agentic-Map) | Worker pool + schema validation |
| Observation masking | Rule-based pre-summarization filtering |
| Composite retrieval scoring | Recency + DAG relevance + optional semantic |
| Backpressure / job queue | Production compaction scheduling |

### Phase 3 — Infrastructure Mode

**Goal:** Shared memory layer for teams/products.

| Deliverable | Notes |
|-------------|-------|
| HTTP server mode | Hono/Express with REST API |
| Multi-tenancy + auth | Per-user schema isolation |
| Python SDK | Thin HTTP client |
| MCP server wrapper | Universal tool exposure |
| Optional vector index | Add-on for semantic recall (DAG stays primary) |

---

## Appendix A: Integration Code Examples

### A.1 Vercel AI SDK (Pattern A: Drop-in Middleware)

```typescript
import { createMemoryEngine } from "@ledgermind/sdk";
import { createVercelTools } from "@ledgermind/adapters/tools/vercel";
import { streamText } from "ai";

const engine = await createMemoryEngine({
  storage: "postgres",
  connectionUrl: "postgres://...",
  summarizer: { provider: "openai", model: "gpt-4o-mini" },
});

// Per-request
const ctx = await engine.materializeContext({
  conversationId,
  budgetTokens: 128_000,
  overheadTokens: systemPromptTokens + toolSchemaTokens,
});

const result = await streamText({
  model: openai("gpt-4o"),
  messages: [
    { role: "system", content: ctx.systemPreamble },
    ...ctx.modelMessages,
    ...incomingMessages,
  ],
  tools: { ...appTools, ...createVercelTools(engine) },
});

await engine.append({
  conversationId,
  events: toLedgerEvents(result),
});
```

### A.2 LangChain (Pattern C: Context Provider)

```typescript
import { createMemoryEngine } from "@ledgermind/sdk";
import { LedgerMindRetriever } from "@ledgermind/adapters/tools/langchain";

const engine = await createMemoryEngine({ storage: "postgres", ... });
const retriever = new LedgerMindRetriever(engine);

const context = await retriever.getRelevantDocuments(conversationId, {
  budgetTokens: 16_000,
});
// Returns: Document[] with summaries + recent messages
```

### A.3 Custom Agent (Direct API)

```typescript
const engine = await createMemoryEngine({ storage: "sqlite", ... });

// Append events
await engine.append({ conversationId, events });

// Materialize context
const ctx = await engine.materializeContext({ conversationId, budgetTokens: 24_000, overheadTokens: 2_000 });

// Use tools
const grepResult = await engine.grep({ conversationId, pattern: "auth.*token" });
const desc = await engine.describe({ id: "sum_abc123def456" });
```

---

## Appendix B: Dependency Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│                    sdk (public API)                   │
│  createMemoryEngine() → wires everything together    │
└────────────────────────┬────────────────────────────┘
                         │ depends on
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  adapters/   │ │  adapters/   │ │  adapters/   │
│  storage/pg  │ │  llm/openai  │ │  tools/      │
│              │ │              │ │  vercel      │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       └────────────────┼────────────────┘
                        │ implements ports from
                        ▼
              ┌──────────────────┐
              │   application    │
              │   (use cases +   │
              │    port defs)    │
              └────────┬─────────┘
                       │ depends on
                       ▼
              ┌──────────────────┐
              │     domain       │
              │  (entities, VOs, │
              │   services,      │
              │   events)        │
              └──────────────────┘
                  ZERO DEPS
```
