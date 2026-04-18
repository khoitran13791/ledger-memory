# LedgerMind: High-Level Design Document

> **Canonical Technical Architecture — Clean Architecture & SOLID**
> Version: 1.2 | Date: April 18, 2026 | Status: Canonical
>
> This document is the single normative high-level design for LedgerMind.

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

### 1.1 Document Role & Precedence

This file is the canonical design contract for LedgerMind. When design
documents disagree, use this order:

1. `docs/high-level-design.md`
2. Code and tests, only when they clearly implement this document
3. `docs/design-decisions-addendum.md` as supporting decision history
4. `docs/paper/LCM.pdf` as upstream research context

If the code disagrees with this document, treat that as implementation drift
unless this document is updated first.

### 1.2 What This Document Governs

This document is authoritative for:

- core architecture and invariants
- public engine contracts
- memory tool behavior and safety boundaries
- LedgerMind-specific adaptations of the LCM paper
- review and update policy for architecture work

### 1.3 Canonical System Model

LedgerMind is a deterministic memory engine built around five core concepts:

- **Immutable Store** — every ledger event is persisted verbatim and is never
  mutated or deleted
- **Active Context** — the model-facing context is a mutable projection of raw
  message pointers and summary pointers; it is a cache, not the source of truth
- **Summary DAG** — leaf summaries cover messages, condensed summaries cover
  summaries, and the DAG must remain acyclic
- **Artifacts** — large external content is tracked by content-addressed IDs
  plus structural metadata and exploration summaries; path-backed content may
  remain on disk rather than being duplicated into the immutable ledger
- **Operator Runs** — `llmMap` and `agenticMap` are durable, engine-managed
  executions whose iteration, retries, and finalization are owned by the engine

### 1.4 What LedgerMind Provides

LedgerMind is **"Postgres for agent memory"** — a standalone, framework-agnostic memory infrastructure with formal compaction semantics for any LLM agent application.

Based on the **Lossless Context Management (LCM)** architecture (Ehrlich & Blackman, 2026), it provides:

- **Immutable append-only ledger** — every message, tool result, and event persisted verbatim
- **Hierarchical summary DAG** — leaf + condensed summaries with provenance links
- **Deterministic compaction loop** — soft/hard threshold with guaranteed convergence
- **Three-level escalation** — normal → aggressive → deterministic fallback
- **Type-aware large file handling** — 30+ explorers as plugins
- **Memory access tools** — `grep`, `expand`, `describe` for retrieval without context bloat
- **Operator-level recursion** — `llm_map` and `agentic_map` for data parallelism

### 1.5 Success Criteria (Testable)

| Criterion | Verification |
|-----------|-------------|
| **Append-only invariant** | No ledger event is ever mutated or deleted (enforced by schema constraints) |
| **Convergent compaction** | `materializeContext()` always returns context ≤ budget OR deterministic error |
| **Deterministic IDs** | Content-addressed SHA-256; same input → same ID across runs |
| **Framework independence** | Core has zero imports from Vercel AI SDK, LangChain, OpenAI SDK, etc. |
| **Pluggable explorers** | New file type explorer added without modifying any existing code |
| **DAG integrity** | 8 integrity checks pass after any sequence of operations |

### 1.6 Non-Goals

- Hosted SaaS / multi-tenant auth (Phase 3)
- UI / dashboard
- Embeddings-first RAG (DAG is primary; vector index is optional add-on)
- Framework-specific runtime ownership (LedgerMind is infrastructure, not an agent framework)

### 1.7 Relationship to LCM and Supporting Docs

The **LCM paper** is the conceptual foundation for LedgerMind, but the repo
does not treat the paper as the sole implementation contract. LedgerMind makes
these repo-specific decisions:

| Topic | Canonical LedgerMind Decision |
|---|---|
| Tool names | Public tools use `memory.*` naming rather than `lcm_*`; the repo currently exposes both `memory.recall` (MCP catalog) and `memory.grep` (Vercel adapter) over the same retrieval use case family |
| Engine surface | LedgerMind exposes a typed programmatic API in addition to tool contracts |
| Operator inputs | The core contract accepts inline items or artifact-backed datasets; JSONL files on disk are an adapter/runtime convention |
| Supporting docs | `design-decisions-addendum.md` and `operator-level-recursion.md` are supporting references, not competing authorities |
| Redirect doc | `source-of-truth.md` exists only as a compatibility redirect to this HLD |

### 1.8 Update and Review Policy

When reviewing or changing architecture:

1. Start with this document.
2. Use the addendum to understand rationale and prior clarifications.
3. Use `LCM.pdf` to evaluate conceptual alignment, not to silently override
   LedgerMind-specific decisions.
4. Update this document first when contracts or invariants change.

### 1.9 Reference Implementation

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
│ (PostgreSQL, filesystem, host runtimes, workers) │
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

### 3.4 Canonical Invariants

The following invariants are mandatory:

- **Immutable ledger:** ledger events are append-only; no per-event mutation or
  delete API exists
- **Deterministic IDs:** content-addressed IDs use canonical SHA-256 rules and
  exclude timestamps from hash inputs
- **Active context is rebuildable:** context is a projection derived from the
  ledger and summary DAG, never the source of truth
- **Optimistic context versioning:** context replacements must use
  `context_versions.version` and fail on stale writes
- **Three-level compaction escalation:** compaction always escalates
  `normal -> aggressive -> deterministic fallback` and must terminate
- **Artifact propagation:** artifact IDs referenced by source messages or source
  summaries are preserved through every compaction round
- **DAG integrity:** the eight integrity checks in Section 11.3 are part of the
  core contract
- **Clean Architecture boundaries:** dependency direction remains
  `domain <- application <- adapters <- infrastructure <- sdk`

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
      │ Database │  │ Runtime /│  │   File   │
      │  (PG)    │  │   LLM    │  │  System  │
      │          │  │ Executors│  │(artifacts│
      └──────────┘  └──────────┘  └──────────┘
```

### 4.2 Primary Actors

| Actor | Role |
|-------|------|
| **Agent Runtime** | Calls LedgerMind to append events, materialize context, and register tools |
| **LLM Provider** | Used by compaction engine for summarization (via `SummarizerPort`) |
| **Database** | Persistent store for ledger, DAG, context projection, artifacts |
| **File System** | Storage for path-backed large files; source for explorer analysis |
| **Background Worker** | Executes polling-first operator tasks/finalization plus async compaction/explorer work |

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
- Tool adapters and catalogs (`memory.recall` / `memory.grep` surfaces)
- Framework-specific wrappers (currently Vercel AI SDK)
- MCP/server-facing mapping layers
- DB row ↔ DTO mappers
- REST/HTTP mappers (Phase 3)

### 5.4 Infrastructure Layer

**Responsibility:** Concrete implementations of all ports. Platform-specific code.

**Contains:**
- PostgreSQL adapter (SQL, migrations, connection pooling)
- Filesystem bindings
- Runtime executor bindings for operator workers
- SHA-256 hashing implementation
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
  readonly id: SummaryNodeId;              // content-addressed: "sum_" + SHA-256(canonical content fields)
  readonly conversationId: ConversationId;
  readonly kind: SummaryKind;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly artifactIds: ArtifactId[];      // propagated file references
  readonly createdAt: Timestamp;
}
```

**Invariants:**
- `id` is deterministic given canonical content fields (`content`, `conversationId`, `kind`)
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
type ContextVersion = number & { readonly __brand: "ContextVersion" };

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

#### Canonical Identity Rules

All content-addressed IDs use **SHA-256 over a canonical UTF-8 JSON byte
string** with lexicographically sorted keys, no extra whitespace, standard JSON
number formatting, and no timestamps in the hash input. `undefined` values are
omitted before hashing.

| Entity | Prefix | Hashed Fields | Excluded |
|---|---|---|---|
| **LedgerEvent** | `evt` | `{ content, conversationId, role, sequence }` | `occurredAt`, `metadata` |
| **SummaryNode** | `sum` | `{ content, conversationId, kind }` | `createdAt`, `tokenCount`, `artifactIds` |
| **Artifact** | `file` | `{ contentHash }` where `contentHash = SHA-256(raw bytes)` | `originalPath`, `mimeType`, `tokenCount` |

These rules guarantee "same content -> same ID across runs" for the canonical
entity inputs above.

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

interface CompactionCompleted {
  readonly type: "CompactionCompleted";
  readonly conversationId: ConversationId;
  readonly rounds: number;
  readonly nodesCreated: SummaryNodeId[];
  readonly tokensFreed: TokenCount;
  readonly converged: boolean;
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
  | CompactionCompleted
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
  generateSummaryId(content: string, conversationId: ConversationId, kind: SummaryKind): SummaryNodeId;
  generateArtifactId(input: ArtifactIdInput): ArtifactId;
  generateEventId(content: string, conversationId: ConversationId, role: MessageRole, sequence: SequenceNumber): EventId;
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
  offset?: number;                         // zero-based match offset
  limit?: number;                          // page size (default 25, capped at 100)
}
interface GrepOutput {
  groups: GrepGroup[];                     // contiguous groups by current covering summary
  page: {
    offset: number;
    limit: number;
    returnedMatchCount: number;
    totalMatchCount: number;
    hasMore: boolean;
    nextOffset?: number;
  };
}
```

**Implementation contract:** the engine returns matches ordered by ascending
event sequence, paginates that ordered stream via `offset` and `limit`, then
groups the returned page into contiguous buckets by the summary node that
currently covers each match. When a `scope` is provided, all returned matches
are grouped under that scope.

**Tool exposure note:** the core use case is `grep()`. The current MCP catalog
surfaces this capability as `memory.recall`, while the Vercel adapter surfaces
it as `memory.grep`.

#### DescribeUseCase

```typescript
interface DescribeInput {
  id: SummaryNodeId | ArtifactId;
}
interface DescribeOutput {
  kind: "summary" | "artifact";
  metadata: Record<string, unknown>;       // summary: { content }; artifact: { originalPath?, explorerUsed? }
  tokenCount: TokenCount;
  parentIds?: SummaryNodeId[];
  explorationSummary?: string;
  planningSignals?: DescribeSummaryPlanningSignals | DescribeArtifactPlanningSignals;
}
```

**Current implementation contract:** summary metadata includes `content`.
Artifact metadata includes `originalPath` and `explorerUsed` when available.
The current code does not yet include `SummaryNode.kind` or `Artifact.mimeType`
inside `metadata`; callers that need richer planning data should use
`planningSignals`, `parentIds`, and `explorationSummary` where present.

#### ExpandUseCase (Guarded)

```typescript
interface ExpandInput {
  summaryId: SummaryNodeId;
  callerContext: CallerContext;             // runtime-authenticated caller context, not user-asserted tool input
}
interface ExpandOutput {
  messages: LedgerEvent[];                 // original messages under the summary
}
```

**Current implementation contract:** `expand()` is restricted to callers that
pass `AuthorizationPort.canExpand(callerContext)`. The use case then verifies
that the caller conversation exists, that it is itself a child conversation, and
that the stored `parentId` matches `callerContext.parentConversationId`.

The expanded summary must belong either to the caller conversation or to that
caller conversation's stored direct parent. Expansion does not cross beyond the
direct parent lineage.

#### CheckIntegrityUseCase

```typescript
interface CheckIntegrityInput {
  conversationId: ConversationId;
}
interface CheckIntegrityOutput {
  report: IntegrityReport;
}
```

### 7.5 StoreArtifact & ExploreArtifact

```typescript
// Store
interface StoreArtifactInput {
  conversationId: ConversationId;
  source: { kind: "path"; path: string } | { kind: "text"; content: string } | { kind: "binary"; data: Uint8Array };
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
  conversationId: ConversationId;
  prompt: string;
  outputSchema: Readonly<Record<string, unknown>>;
  concurrencyLimit: number;
  retryPolicy: { maxRetries: number; retryBackoffSeconds: number };
  idempotencyKey?: string;
  items?: unknown[];
  inputArtifactId?: ArtifactId;
}
interface LLMMapOutput {
  runId: string;
  status: OperatorRunStatus;
  inputArtifactId?: ArtifactId;
}
```

**Execution model:**
1. Validate that exactly one of `items` or `inputArtifactId` is present.
2. Persist inline datasets as artifacts when needed.
3. Create a durable operator run plus one task per item.
4. Workers claim tasks with leases, execute one attempt, and persist success/failure state.
5. Finalization writes ordered JSONL output to an artifact and appends a compact parent handle.
6. Callers inspect terminal results later through `getOperatorRun()`.

Zero-item submissions are valid and finalize immediately to an empty JSONL output artifact.

The core LedgerMind contract accepts either inline `items` or an
`inputArtifactId` that points at a stored dataset. JSONL input and output files
are valid adapter/runtime conventions, but they are not the only canonical
representation at the engine layer.

#### AgenticMapUseCase

```typescript
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
  retryPolicy: { maxRetries: number; retryBackoffSeconds: number };
  idempotencyKey?: string;
  items?: unknown[];
  inputArtifactId?: ArtifactId;
}
interface AgenticMapOutput {
  runId: string;
  status: OperatorRunStatus;
  inputArtifactId?: ArtifactId;
}
```

`agenticMap` follows the same durable submit/inspect contract as `llmMap`, but
each task executes inside a child conversation.

**Current implementation rules:**
1. `delegatedScope` is required and must include at least one delegated
   reference or a note.
2. `keptWork.description` and `keptWork.expectedOutput` are required.
3. Child-originated recursive `agenticMap()` submissions still require explicit
   `delegatedScope` and `keptWork`.
4. Each operator task maps to at most one child conversation.
5. Child assignment and bootstrap state are persisted so retries reuse the same
   child conversation rather than creating duplicates.

**Current repo adaptation of the paper:** the codebase does not currently expose
standalone `Task()` / `Tasks()` APIs. Recursive delegation is represented
through child-originated `agenticMap()` calls with explicit bounded scope.

#### GetOperatorRunUseCase

```typescript
type OperatorRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "completed_with_failures"
  | "failed";

interface GetOperatorRunInput {
  runId: string;
}

interface GetOperatorRunOutput {
  runId: string;
  conversationId: ConversationId;
  operatorKind: "llmMap" | "agenticMap";
  status: OperatorRunStatus;
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

`getOperatorRun()` is the current canonical inspection API for durable operator
state. Final ordered results are only inlined when the output artifact fits
under the configured inline-results ceiling; otherwise callers are expected to
follow `outputArtifactId`.

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
  checkIntegrity(input: CheckIntegrityInput): Promise<CheckIntegrityOutput>;
  grep(input: GrepInput): Promise<GrepOutput>;
  describe(input: DescribeInput): Promise<DescribeOutput>;
  expand(input: ExpandInput): Promise<ExpandOutput>;
  storeArtifact(input: StoreArtifactInput): Promise<StoreArtifactOutput>;
  exploreArtifact(input: ExploreArtifactInput): Promise<ExploreArtifactOutput>;
  llmMap(input: LLMMapInput): Promise<LLMMapOutput>;
  agenticMap(input: AgenticMapInput): Promise<AgenticMapOutput>;
  getOperatorRun(input: GetOperatorRunInput): Promise<GetOperatorRunOutput>;
}

// Tool provider — creates framework-specific tool definitions
interface ToolProviderPort {
  createTools(engine: MemoryEngine, runtime: ToolRuntimeContextProvider): ToolDefinition[];
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
  /**
   * Appends events atomically. The persistence boundary owns sequence
   * allocation — no standalone next-sequence operation is exposed.
   * This ensures sequence numbers are assigned atomically with persistence,
   * preventing gaps and race conditions.
   */
  appendEvents(conversationId: ConversationId, events: LedgerEvent[]): Promise<void>;
}

interface LedgerReadPort {
  getEvents(conversationId: ConversationId, range?: SequenceRange): Promise<LedgerEvent[]>;
  searchEvents(conversationId: ConversationId, query: string): Promise<LedgerEvent[]>;
  regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    page: {
      scope?: SummaryNodeId;
      offset: number;
      limit: number;
    },
  ): Promise<{
    matches: GrepMatch[];
    totalMatchCount: number;
  }>;
}

interface ContextProjectionPort {
  getCurrentContext(conversationId: ConversationId): Promise<{
    items: ContextItem[];
    version: ContextVersion;
  }>;
  getContextTokenCount(conversationId: ConversationId): Promise<TokenCount>;
  appendContextItems(conversationId: ConversationId, items: ContextItem[]): Promise<ContextVersion>;
  replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: number[],
    replacement: ContextItem,
  ): Promise<ContextVersion>;
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
  store(artifact: Artifact, content?: Uint8Array | string): Promise<void>;
  getMetadata(id: ArtifactId): Promise<Artifact | null>;
  getContent(id: ArtifactId): Promise<Uint8Array | string | null>;
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
  content: string | Uint8Array;
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
  subscribe<T>(type: string, handler: JobHandler<T>): Promise<JobSubscription>;
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
  // canReadArtifact — Phase 2: artifact access control gating
}

interface CallerContext {
  conversationId: ConversationId;
  isSubAgent: boolean;                     // derived from trusted runtime/session state
  parentConversationId?: ConversationId;  // direct parent lineage for child conversations
}
```

**Rule:** framework adapters, MCP bridges, and tool wrappers must overwrite or
derive `CallerContext` from trusted runtime metadata. They must never treat
caller-supplied sub-agent identity as authoritative.

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

#### In-Memory Adapters

| Port | Implementation Notes |
|------|---------------------|
| `LedgerAppendPort` | In-memory append-only collections keyed by conversation |
| `LedgerReadPort` | Deterministic regex/keyword traversal over stored events |
| `ContextProjectionPort` | Ordered in-memory context projection with version tracking |
| `SummaryDagPort` | In-memory DAG edges plus recursive expansion |
| `ArtifactStorePort` | In-memory metadata/content store |
| `OperatorExecutionPort` | In-memory durable run/task state for tests and local execution |

These adapters live in `packages/adapters/src/storage/in-memory/` and are the
default fake/embedded runtime used by tests and the in-memory SDK preset.

#### PostgreSQL Adapter (Persistent)

| Port | Implementation Notes |
|------|---------------------|
| `LedgerAppendPort` | `INSERT INTO ledger_events` with `ON CONFLICT DO NOTHING` for idempotency |
| `LedgerReadPort` | FTS via `plainto_tsquery`, regex via `~` operator, recursive CTE for ancestor chains |
| `ContextProjectionPort` | `context_items` + `context_versions` for ordered positions and optimistic concurrency |
| `SummaryDagPort` | `summary_nodes` + `summary_edges` tables; recursive CTE for `expandToMessages()` |
| `ArtifactStorePort` | `artifacts` table with `path`, `inline_text`, `inline_binary` variants |
| `OperatorExecutionPort` | `operator_runs` + `operator_tasks` tables for durable submit/inspect workflows |
| `UnitOfWorkPort` | PostgreSQL transaction with `BEGIN`/`COMMIT`/`ROLLBACK` |

**Schema enforcement:**
- `ledger_events` has no `UPDATE`/`DELETE` triggers (append-only by convention + optional trigger guard)
- GIN indexes on `tsvector` columns for FTS
- `UNIQUE (conversation_id, seq)` enforces monotonic ordering
- `CHECK` constraint on `context_items` ensures exactly one ref type

**Current scope note:** SQLite is not implemented in the current repo. The
active persistence backends are in-memory and PostgreSQL.

### 9.2 LLM Provider Adapters

Current repo implementations:

| Adapter | Notes |
|---------|-------|
| **DeterministicSummarizerAdapter** | Test/local summarizer that preserves contract shape without provider calls |
| **StructuredGenerationPort** | Host-injected runtime executor used by operator workers |
| **SubAgentExecutorPort** | Host-injected child-session executor used by `agenticMap()` |

Deterministic fallback (Level 3) remains in the application layer — no LLM
call. Provider-backed summarizers and structured-generation runtimes are
expected to be supplied by host environments rather than hardcoded into the
core repo today.

### 9.3 Framework Tool Adapters

Implement `ToolProviderPort`:

| Framework | Tool Mapping |
|-----------|-------------|
| **Vercel AI SDK** | `tool()` definitions for `memory.grep`, `memory.describe`, `memory.expand`, `memory.llmMap`, `memory.agenticMap`, `memory.getOperatorRun` |
| **Canonical Generic Catalog** | Plain tool definitions for `memory.recall`, `memory.describe`, `memory.expand` |
| **MCP Server Wrapper** | Exposes the canonical generic catalog over MCP transport |

**Current scope note:** OpenAI Agents SDK and LangChain tool adapters are not
implemented in the current repo.

### 9.4 Explorer Plugin Adapters

Built-in explorers register with `ExplorerRegistryPort`:

| Explorer | File Types | Strategy |
|----------|-----------|----------|
| `PythonExplorer` | `.py` | AST-based: classes, functions, imports |
| `TypeScriptExplorer` | `.ts`, `.tsx` | Deterministic structural analysis of imports, exports, and top-level declarations |
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
| `FallbackExplorer` | `*` | Deterministic fallback summarization/classification with metadata-rich previews and guidance |

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
│       │   └── in-memory/
│       │       ├── in-memory-ledger-store.ts
│       │       ├── in-memory-context-projection.ts
│       │       ├── in-memory-summary-dag.ts
│       │       ├── in-memory-artifact-store.ts
│       │       ├── in-memory-conversation-store.ts
│       │       ├── in-memory-operator-execution-store.ts
│       │       └── in-memory-unit-of-work.ts
│       ├── llm/
│       │   └── deterministic-summarizer.adapter.ts
│       ├── tokenizer/
│       │   ├── simple-tokenizer.adapter.ts
│       │   ├── simple-estimator.adapter.ts
│       │   ├── tiktoken-tokenizer.adapter.ts
│       │   └── validating-tokenizer.adapter.ts
│       ├── tools/
│       │   ├── vercel-ai-memory-tools.adapter.ts
│       │   └── canonical-memory-tool-catalog.ts
│       ├── auth/
│       │   └── sub-agent-authorization.adapter.ts
│       ├── explorers/
│       │   ├── explorer-registry.ts
│       │   ├── default-explorer-registry.ts
│       │   ├── python-explorer.ts
│       │   ├── typescript-explorer.ts
│       │   ├── json-explorer.ts
│       │   ├── markdown-explorer.ts
│       │   └── fallback-explorer.ts
│       ├── jobs/
│       │   └── in-memory-job-queue.adapter.ts
│       └── testing/
│           ├── fixed-clock.ts
│           ├── deterministic-summarizer.ts
│           └── simple-tokenizer.ts
│
├── infrastructure/                  # Depends on: adapters, application
│   ├── package.json
│   └── src/
│       ├── postgres/
│       │   ├── pg-ledger-store.ts
│       │   ├── pg-context-projection.ts
│       │   ├── pg-summary-dag.ts
│       │   ├── pg-artifact-store.ts
│       │   ├── pg-conversation-store.ts
│       │   ├── pg-operator-execution-store.ts
│       │   ├── pg-unit-of-work.ts
│       │   └── __tests__/
│       ├── config/
│       │   └── create-pg-pool.ts
│       └── filesystem/
│           └── node-file-reader.ts
│
└── sdk/                             # Public API package
    ├── package.json                 # { "dependencies": all internal packages }
    └── src/
        ├── index.ts                 # MemoryEngine factory + re-exports
        └── presets/
            ├── in-memory.ts
            └── postgres.ts
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
  metadata        JSONB NOT NULL DEFAULT '{}',
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

-- 7. Context projection versioning (optimistic locking)
CREATE TABLE context_versions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version         BIGINT NOT NULL DEFAULT 0
);

-- 8. Artifacts (large files & tool outputs)
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

### 11.3 Canonical Integrity Checks

The summary DAG integrity contract consists of these eight checks:

| # | Check | Requirement |
|---|---|---|
| 1 | **No orphan edges** | Every summary edge points to an existing message or summary |
| 2 | **No orphan context refs** | Every context item points to an existing message or summary |
| 3 | **Acyclic DAG** | Recursive traversal never revisits the same summary node |
| 4 | **Leaf covers >= 1 message** | Every leaf summary has at least one message edge |
| 5 | **Condensed covers >= 1 summary** | Every condensed summary has at least one parent-summary edge |
| 6 | **Contiguous context positions** | Context positions form `[0, 1, 2, ..., N-1]` with no gaps |
| 7 | **Monotonic ledger sequence** | Conversation-local ledger sequences are strictly increasing with no gaps |
| 8 | **Artifact ID propagation** | Summary `artifact_ids` preserve the union of source artifact references |

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
    contextSnapshot ← getContext(conversationId)     // returns { items, version }
    candidates ← selectCandidates(contextSnapshot.items, pinRules)
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
    replaceContextItems(conversationId, contextSnapshot.version, block.positions, node)
    created.push(node.id)
    current ← getContextTokenCount(conversationId)
    round++

  if trigger == "hard" AND current > budget.available:
    throw CompactionFailedToConverge

  return { rounds: round, created, tokensFreed, converged: current <= target }
```

### 12.3 Candidate Selection

1. Exclude pinned items (system prompt, tail window, explicit pins)
2. Sort remaining by position (oldest first)
3. Build a **contiguous oldest non-pinned block** up to `blockTokenTargetFraction × availableBudget`
4. Enforce `minBlockSize` (default: 2); if fewer candidates remain, skip compaction this round

A compaction block is therefore defined as the oldest contiguous run of
non-pinned context items that satisfies the minimum block size and token target
rules. The engine never compacts a single item in isolation.

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

### 12.6 Deterministic Fallback Contract

Level 3 fallback is **head-only truncation** with no LLM call:

- the maximum output is 512 tokens
- the output appends a marker instructing the caller to use
  `memory.expand(summary_id)` for full content
- the engine trims to a word boundary and re-checks token count until the
  result is within the cap
- this level is always accepted, which gives the compaction loop a hard
  termination guarantee

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
4. Fallback explorer → deterministic fallback summarization/classification (always available)
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
| `StaleContextError` | `ContextProjectionPort.replaceContextItems()` expected version mismatch during concurrent mutation |
| `UnauthorizedExpandError` | Untrusted or invalid-lineage caller attempted `expand` |
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
                   │ Contract │  Same suite runs against PG + in-memory
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
  - **Authorization gating:** Expand fails for self-attested or invalid-lineage callers
  - **Expand delegated parent history:** Valid child lineage allows expansion of summaries owned by the caller conversation or its stored direct parent, but not unrelated conversations
  - **Artifact ID propagation:** File IDs survive arbitrary compaction rounds
  - **DAG integrity:** No cycles after any sequence of compactions

### 16.4 Adapter / Contract Tests

- **Storage contract tests:** Same test suite runs against PostgreSQL and in-memory adapters
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
| `memory.recall` (MCP) / `memory.grep` (Vercel) | All callers | No restriction |
| `memory.describe` | All callers | No restriction |
| `memory.expand` | Sub-agents only | `AuthorizationPort.canExpand()` + trusted runtime/session binding |
| `memory.llmMap` / `memory.agenticMap` | Bound conversation callers | Conversation ID is derived from runtime binding; application layer validates operator inputs |
| `memory.getOperatorRun` | Bound conversation callers | Tool adapter rejects runs owned by a different bound conversation |

**Rationale (from Volt):** `expand` and full artifact reads can flood the active context with unbounded content. Restricting to sub-agents ensures the main agent loop remains within budget.

**Canonical enforcement detail:** a tool payload may include caller context for
transport convenience, but sub-agent identity is not self-attested. Runtimes
must derive or overwrite `isSubAgent` from trusted session metadata. The
application layer validates child lineage before expansion and only allows
summaries owned by the bound child conversation or its stored direct parent
conversation.

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
| PostgreSQL adapter | `infrastructure/postgres` | Full schema + migrations |
| Basic tokenizer | `adapters/tokenizer` | Simple estimator + tiktoken |
| 5 core explorers | `adapters/explorers` | TS, Python, JSON, Markdown, Fallback |
| SDK entrypoint | `sdk` | `createMemoryEngine()` factory |
| Vercel AI SDK adapter | `adapters/tools` | First framework integration |
| Operator recursion | `application/use-cases` + storage | Durable submit/inspect API with child bootstrap reuse |
| Golden test suite | All packages | Deterministic DAG evolution tests |

**Non-goals:** HTTP server mode, multi-tenant, vector DB, UI

### Phase 2 — Ecosystem + Hardening

**Goal:** Easy adoption across frameworks; production safety.

| Deliverable | Notes |
|-------------|-------|
| 25+ more explorers | Full type coverage from Volt |
| MCP hardening | Align session-bound caller derivation and tool naming across adapters |
| Additional framework adapters | OpenAI Agents SDK, LangChain, or similar host integrations |
| Observation masking | Rule-based pre-summarization filtering |
| Composite retrieval scoring | Recency + DAG relevance + optional semantic |
| Backpressure / job queue | Optional wake-up hints via `subscribe(type, handler)`; polling remains the correctness path |

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

### A.1 Vercel AI SDK

```typescript
import { createMemoryEngine } from "@ledgermind/sdk";
import { createVercelMemoryTools } from "@ledgermind/adapters";
import { streamText } from "ai";

const engine = createMemoryEngine({
  storage: { type: "postgres", connectionString: "postgres://..." },
  summarizer: { type: "deterministic" },
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
  tools: {
    ...appTools,
    ...createVercelMemoryTools(engine, {
      getCallerContext: () => ({
        conversationId,
        isSubAgent: false,
      }),
    }),
  },
});

await engine.append({
  conversationId,
  events: toLedgerEvents(result),
});
```

### A.2 MCP Server

```typescript
import { createLedgermindMcpServer } from "@ledgermind/mcp-server";

const runtime = createLedgermindMcpServer({
  config: {
    storage: { type: "in-memory" },
    enableWriteTools: false,
    readOnly: true,
  },
});

// Exposes memory.recall, memory.describe, memory.expand over MCP transport.
```

### A.3 Custom Agent (Direct API)

```typescript
const engine = createMemoryEngine({
  storage: { type: "in-memory" },
  summarizer: { type: "deterministic" },
});

// Append events
await engine.append({ conversationId, events });

// Materialize context
const ctx = await engine.materializeContext({ conversationId, budgetTokens: 24_000, overheadTokens: 2_000 });

// Use tools
const grepResult = await engine.grep({ conversationId, pattern: "auth.*token", limit: 10 });
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
│infrastructure│ │  adapters/   │ │  adapters/   │
│ /postgres    │ │     llm      │ │    tools     │
│              │ │deterministic │ │   + MCP      │
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
