# LedgerMind: A Standalone LCM-Based Memory Framework for LLM Agents

> **Research & Planning Document**
> Date: February 26, 2026
> Status: Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The LCM Paper: Core Concepts](#2-the-lcm-paper-core-concepts)
3. [LCM Implementation in Volt: Paper-to-Code Mapping](#3-lcm-implementation-in-volt-paper-to-code-mapping)
4. [Industry Landscape: Memory in LLM Frameworks](#4-industry-landscape-memory-in-llm-frameworks)
5. [Market Gap Analysis](#5-market-gap-analysis)
6. [LCM Coupling Analysis: What Can Be Extracted](#6-lcm-coupling-analysis-what-can-be-extracted)
7. [Framework Design: LedgerMind](#7-framework-design-ledgermind)
8. [Phased Roadmap](#8-phased-roadmap)
9. [Key Technical Decisions & Tradeoffs](#9-key-technical-decisions--tradeoffs)
10. [Integration Patterns](#10-integration-patterns)
11. [References](#11-references)

---

## 1. Executive Summary

We propose extracting the **Lossless Context Management (LCM)** architecture from the Volt codebase into a standalone, framework-agnostic memory layer framework for any coding agent or LLM application.

**Positioning:** LedgerMind is **"Postgres for agent memory"** — a standalone memory infrastructure with formal compaction semantics. It provides an immutable ledger + hierarchical compaction DAG that any agent framework can plug into.

**Key differentiator (positioning claim, based on surveyed sources as of Feb 2026):** Memory is typically delivered as part of a framework runtime rather than as standalone context infrastructure. LedgerMind is positioned as a framework-agnostic memory substrate with:

- Immutable append-only message store
- Hierarchical summary DAG (not flat summaries)
- Multi-level compaction escalation with guaranteed convergence
- Soft/hard threshold-based control loop
- Type-aware large file handling with 30+ explorers
- Operator-level recursion (map-reduce over items)
- Memory-access tools (grep, expand, describe)

---

## 2. The LCM Paper: Core Concepts

**Paper:** *LCM: Lossless Context Management* — Clint Ehrlich & Theodore Blackman, Voltropy PBC (Feb 14, 2026)

### 2.1 Dual-State Memory Architecture

LCM uses two complementary stores:

- **Immutable Store**: Source of truth. Every user message, assistant response, and tool result is persisted verbatim and never modified.
- **Active Context**: The window actually sent to the LLM. Assembled from recent raw messages + precomputed summary nodes (materialized views over the immutable history).

### 2.2 The Hierarchical DAG

The core data structure is a Directed Acyclic Graph (DAG) maintained in a persistent store that supports transactional writes, foreign-key integrity, and indexed search.

- **Leaf summaries**: Compress raw messages
- **Condensed summaries**: Compress other summaries (high-fanout DAG nodes)
- Overcomes limitations of both flat-file grep (requires knowing the substring) and embedding-based RAG (returns decontextualized fragments)

### 2.3 Context Control Loop (Algorithm)

```
Input: New item h, Store D, Active Context C
1. Persist h into D with metadata (role, tokens, timestamp)
2. Append h to C (as a pointer)
3. IF Tok(C) > τ_soft THEN trigger asynchronous compaction
4. WHILE Tok(C) > τ_hard DO
     Identify oldest block in C
     S ← EscalatedSummary(block)
     Replace block in C with pointer to S
   END WHILE
5. RETURN Updated C to Model
```

### 2.4 Three-Level Summarization Escalation

Guarantees convergence — if a summarization level fails to reduce token count, the system escalates:

| Level | Strategy | Target |
|-------|----------|--------|
| 1 (Normal) | LLM-Summarize with detail preservation | Full detail |
| 2 (Aggressive) | LLM-Summarize as bullet points | T/2 tokens |
| 3 (Fallback) | Deterministic truncation (no LLM) | 512 tokens |

### 2.5 Large File Handling

- LCM uses a layered offload policy rather than a single cutoff:
  - **LCM defaults**: files are treated as large at `>25,000` estimated tokens or `>100,000` bytes
  - **Read tool proactive offload**: files above ~`7.5KB` are stored in LCM (unless explicit line limits are requested)
  - **Read-path safety offload**: content is also offloaded when adding it would exceed context thresholds or parallel-read token reservations
  - **Large tool output policy**: tool outputs above `10,000` tokens are stored as large artifacts with retrievable IDs
- **Exploration Summary**: Type-aware dispatcher selects analysis strategy based on file type
  - Structured formats (JSON, CSV, SQL): schema and shape extraction
  - Code files: parser-driven structural analysis where available, with optional LLM-assisted summarization on selected paths
  - Unstructured text/PDF and fallback paths: LLM-generated summary
- File IDs propagate through context and summary lineage so compacted nodes can still reference retrievable artifacts

### 2.6 Continuity Below Soft Threshold

Below `τ_soft`, compaction/summarization is skipped, but the runtime still performs per-turn sync, budget computation, threshold checks, and context assembly. The continuity claim is that no compaction job is triggered in this regime, not that per-turn overhead is literally zero.

### 2.7 Operator-Level Recursion

Two tools replace model-written loops:

- **LLM-Map**: Processes each item as a single, stateless LLM call (classification, extraction, scoring)
- **Agentic-Map**: Spawns a full sub-agent session for each item with tool access
- Both use file-based I/O (JSONL) external to the active context
- Schema-validated output with retry on validation failure

### 2.8 Memory-Access Tools

| Tool | Purpose |
|------|---------|
| `lcm_grep(pattern, summary_id?)` | Regex search across immutable history, grouped by covering summary |
| `lcm_describe(id)` | Returns metadata for any LCM identifier (file or summary) |
| `lcm_expand(summary_id)` | Retrieves original messages covered by a summary (sub-agent only) |

---

## 3. LCM Implementation in Volt: Paper-to-Code Mapping

### 3.1 Architecture Mapping

| Paper Concept | Key Files | Key Functions |
|---|---|---|
| **§2 Dual-State Memory** | `db.ts` | `appendMessage()` → `messages` table; `context_items` table = mutable active context |
| **§2.1 Hierarchical DAG** | `summary.ts`, `db.ts` | `Summary.createLeaf()`, `Summary.createCondensed()`; stored in `summaries` + `summary_parents` + `summary_messages` |
| **§2.3 Control Loop** (τ_soft / τ_hard) | `context.ts`, `prompt.ts` | `isOverThreshold()` (soft≈60% after overhead); `scheduleCompaction()` (async) vs `compactUntilUnderLimit()` (blocking) |
| **§2.4 Three-Level Escalation** | `summarize.ts`, `condense.ts`, `context.ts` | `summarize()` → `summarizeAggressive()` → `summarizeFallback()` (512-token deterministic truncation) |
| **§2.5 Large File Handling** | `large-file-threshold.ts`, `tool/read.ts`, `session/large-tool-output.ts`, `explore/dispatcher.ts`, `db.ts` | Layered policy: 25K token / 100KB defaults + read-tool proactive/context/parallel offload + large-tool-output offload; type-aware explorers; `insertLargeFileFromPath()` stores path-only refs |
| **§2.6 Continuity Below Soft Threshold** | `context.ts`, `prompt.ts` | `checkAndHandle()` returns null below τ_soft, while turn pipeline still runs sync/budget/threshold/materialization steps |
| **§3.1 LLM-Map** | `tool/llm-map.ts` | Stateless parallel LLM calls over JSONL, schema-validated output |
| **§3.1 Agentic-Map** | `tool/agentic-map.ts` | Full sub-agent sessions per JSONL item with tool access |
| **Appendix C.1 Tools** | `tool/lcm-grep.ts`, `tool/lcm-describe.ts`, `tool/lcm-expand.ts` | Regex search with DAG-scoped CTE walk; expand restricted to sub-agents |

### 3.2 Database Schema (PostgreSQL)

```
conversations          — Per-session config (model, context window, threshold)
messages               — Full-fidelity, append-only (with FTS via tsvector)
message_parts          — First-class persisted message-part payloads used by runtime sync and model-message reconstruction
summaries              — Leaf + condensed nodes with FTS
summary_messages       — Leaf → messages (ordered)
summary_parents        — Condensed → parent summaries (ordered, high fan-out DAG)
context_items          — Current active context (ordered list of message+summary refs)
large_files            — External file references (path, inline_text, inline_binary)
```

### 3.3 Notable Deviations from Paper

1. **Active context is persisted** in Postgres `context_items` (not in-memory)
2. **`lcm_expand`/`lcm_read` gated to sub-agents** as a safety mechanism
3. **Large-file IDs use path+mtime hash** (not pure content hash) for path-backed files
4. **Continuity below `τ_soft` still pays sync/budget/threshold/materialization overhead** even when compaction is not triggered
5. **Bun-specific APIs** used (`Bun.file()`, `Bun.CryptoHasher`)

---

## 4. Industry Landscape: Memory in LLM Frameworks

> Snapshot note (as of February 2026): this section reflects the surveyed public docs/code at the time of writing and may lag fast-moving framework releases.

### 4.1 Framework Comparison Matrix

| Feature | LangChain Classic | LangGraph | Letta/MemGPT | AutoGen | CrewAI | Mem0 |
|---|---|---|---|---|---|---|
| **Buffer eviction** | FIFO token-based | No (user impl) | Message count | FIFO / Middle / Head+Tail | LanceDB TTL | No (fact-based) |
| **Summarization** | Rolling summary chain | No (user impl) | 4 compaction modes w/ fallback | No | No | No |
| **Persistent backend** | Pluggable (15+ adapters) | PostgresSaver | PostgreSQL (Alembic ORM) | No built-in | LanceDB | Vector + Graph |
| **Archival memory** | Vector store only | Store (kv) | Passage store (vector + PG) | External | Scoped store | Vector store |
| **Entity memory** | Explicit entity store | No | Core memory blocks | No | Scope hierarchy | Graph store |
| **Semantic retrieval** | VectorStore retriever | No built-in | Archival search | No built-in | RecallFlow | Primary mechanism |
| **Importance scoring** | No | No | No | No | Yes (composite) | No |
| **Context accounting** | Token count only | No | Rich breakdown (per-section) | Token count | No | No |
| **Agent self-edits memory** | No | No | Yes (tool calls) | No | No | No |
| **Cross-session persistence** | Backend-dependent | Thread_id + checkpointer | PostgreSQL | No | LanceDB | Yes |
| **Immutable history** | No | Checkpoints (append-only) | Yes (recall DB) | No | No | No |
| **Hierarchical DAG** | No | No | No | No | No | No |

### 4.2 LangChain Classic (Deprecated)

All memory types deprecated as of v0.3.1 in favor of LangGraph. Key patterns:

- **ConversationBufferMemory**: Stores full history. Hard eviction (FIFO), no compression.
- **ConversationSummaryMemory**: Single flat rolling string. Rewrites entire summary each turn.
- **ConversationSummaryBufferMemory**: Most sophisticated — recent messages verbatim up to token limit, evicted messages summarized into a `moving_summary_buffer`. One-level compaction, no persistence.
- **ConversationEntityMemory**: LLM-extracted per-entity key-value summaries.
- **VectorStoreRetrieverMemory**: Embeds each turn, retrieves by semantic similarity. No temporal ordering.

### 4.3 LangGraph (Modern Replacement)

Replaces LangChain memory with two orthogonal systems:

- **Checkpointers**: Full graph state snapshots per step, keyed by `thread_id`. `PostgresSaver` recommended for production. Immutable snapshots (time-travel/fork).
- **Long-term Store**: Namespaced key-value store (`BaseStore`/`InMemoryStore`). No built-in summarization — context management is developer's responsibility.

### 4.4 Letta/MemGPT (Most Sophisticated)

Three-tier memory model:

| Tier | Description | Storage |
|------|-------------|---------|
| **Core Memory** | In-context structured blocks (persona, human). Agent edits via tool calls. | System prompt (XML blocks) |
| **Recall Memory** | All past messages persisted, searchable | PostgreSQL |
| **Archival Memory** | Agent-written notes with embeddings | PostgreSQL + pgvector |

Four compaction modes with fallback chains:

| Mode | Strategy | Fallback |
|------|----------|----------|
| `all` | Summarize entire conversation | — |
| `sliding_window` | Keep newest 30%, summarize rest | → `all` |
| `self_compact_all` | Agent rewrites own memory blocks | → `self_compact_sliding_window` → `all` |
| `self_compact_sliding_window` | Agent rewrites with sliding window | → `all` |

Three-tier fallback for summarization itself:
1. Normal summarization
2. Clamp tool-return content
3. `middle_truncate_text()` — keep head 30% + tail 30%

Rich `ContextWindowOverview` with per-section token breakdown.

### 4.5 Microsoft AutoGen

Separates **model context** from **memory**:

- **UnboundedChatCompletionContext**: All messages, no limits
- **BufferedChatCompletionContext**: Keep last N messages
- **TokenLimitedChatCompletionContext**: Drop from **middle** (not front)
- **HeadAndTailChatCompletionContext**: Keep first N + last M, insert placeholder

No built-in summarization. `Memory` interface: `update_context()`, `query()`, `add()`.

### 4.6 CrewAI

Unified memory with composite relevance scoring:

```
composite = semantic_weight × semantic_score     (0.5)
          + recency_weight × decay               (0.3)
          + importance_weight × importance        (0.2)

decay = 0.5^(age_days / half_life_days)          (half-life: 30 days)
```

Features:
- Hierarchical scopes (`/company/team/user`)
- Consolidation on write (similarity ≥ 0.85 triggers LLM merge/update/delete)
- Adaptive recall depth (confidence-based routing)

### 4.7 Mem0

Pure memory-as-a-service layer (48k stars):

- **LLM extracts semantic facts** from conversation (not raw messages)
- Dual store: **vector** (semantic similarity) + **graph** (Neo4j/Kuzu for entity relationships)
- Three orthogonal scopes: `user_id`, `agent_id`, `run_id`
- Parallel writes to both stores
- Framework-agnostic but lacks hierarchical structure

### 4.8 JetBrains Research (NeurIPS 2025)

Key findings on context management efficiency:

- **Observation masking** (hiding old tool outputs with placeholders) often **matches or beats LLM summarization** while being cheaper
- LLM summarization causes **trajectory elongation** — agents run 15% longer because summaries smooth over stop signals
- Summary-generation API calls can add 7%+ to total cost
- **Hybrid approach** (masking first, summarize only when truly needed) achieved:
  - 7% cost reduction vs pure masking
  - 11% cost reduction vs pure summarization
  - 2.6% solve rate improvement
- Hyperparameter tuning (masking window size) is agent-specific

---

## 5. Market Gap Analysis

### 5.1 What Was Not Observed in the Surveyed Frameworks (as of February 2026)

| LCM Feature | Current Industry Gap |
|---|---|
| **Immutable PostgreSQL append-only store** | LangGraph provides append-only checkpoints (graph-state snapshots, not message-level ledgers). Letta has message persistence but as part of a tightly integrated runtime. |
| **Hierarchical summary DAG** | Not observed in surveyed frameworks; common patterns are flat/rolling summaries or non-hierarchical memory stores. |
| **Multi-level compaction escalation** | Letta has multiple compaction modes and fallback chains but no hierarchical summary DAG. LangChain classic provides one-level summary-buffer style memory. |
| **Soft/hard threshold system** | Explicit dual-threshold control loops were not surfaced as a first-class public abstraction in surveyed frameworks. |
| **Operator-level recursion** | Purpose-built memory tools for recursive map/reduce-style compaction were not observed in surveyed frameworks. |
| **Framework-agnostic memory layer** | Most memory systems are framework/runtime-scoped; Mem0 is closest to standalone but centers semantic memory rather than hierarchical context compaction. |
| **Guaranteed convergence** | Deterministic final fallback with explicit size-reduction guarantees was not clearly documented in surveyed systems. |
| **Type-aware large file handling** | Broad parser/explorer catalogs specialized for large file context handling were not observed in surveyed frameworks. |

### 5.2 Key Insight

> In the surveyed ecosystem snapshot, memory is usually packaged as a runtime/framework capability rather than an independently deployed context infrastructure layer. LCM's differentiation is the combination of immutable history, hierarchical compaction, and explicit control-loop semantics in a design that can be exposed as standalone infrastructure.

---

## 6. LCM Coupling Analysis: What Can Be Extracted

### 6.1 Cleanly Extractable (No Volt Internals)

| Module | What It Does | Dependencies to Abstract |
|--------|-------------|--------------------------|
| `LcmDb` | Full PostgreSQL data layer | `postgres` npm, `Bun.file()` → `node:fs`, `Bun.CryptoHasher` → `node:crypto` |
| `Summary` | Pure data model + ID generation | None — pure TypeScript |
| `LargeFile` | Pure data model + ID generation | None |
| `LargeFileThreshold` | Byte/token threshold detection | None |
| Most `explore/` parsers with dedicated parsers | Primarily deterministic file type analysis | Usually parser-driven; some paths still accept model/session context via shared interfaces |
| `migration.ts` / `integrity.ts` | DB schema management | Only `LcmDb` |

### 6.2 Extractable with Interface Abstraction

| Module | Coupling to Abstract |
|--------|---------------------|
| `LcmSummarize` | Replace `Provider.Model` + `Provider.getLanguage()` with generic `LanguageModel`. Replace `MessageV2.WithParts` with generic `{ role, content }[]` |
| `Condense` | Same: `Provider.Model` → `LanguageModel`, remove `MessageV2` dependency |
| `LcmContext` | Replace `MessageV2.User` with plain struct. Replace `Bus` with callback/event emitter. `Provider.Model` → `LanguageModel + contextWindow` |
| `ExploreDispatcher` | Replace `Provider.Model` with direct `LanguageModel` abstraction and pass explicit optional model/session capabilities to explorer calls |
| `text-explorer`, `pdf-explorer`, and LLM-assisted language explorers | Replace `Provider.getLanguage()` with injected `LanguageModel`; keep deterministic parser paths available when model is absent |

### 6.3 Tightly Coupled to Volt (Must Redesign)

| Integration Point | Why It's Coupled |
|---|---|
| `syncSessionMessagesToLcm` + `formatMessageForLcm` | Converts `MessageV2.WithParts` (all 12 part types) → LCM DB rows. **Hardest seam to cut.** |
| `buildLcmModelMessages` | Reconstitutes `ModelMessage[]` from LCM context. Depends on Vercel AI SDK types and model capability flags. |
| `getOrCreateLcmConversation` | Session→conversation mapping stored in DB title field + `Session.get()` for parent linkage. |
| Tool sub-agent gates | Reads `Session.get(ctx.sessionID).parentID` — Volt task-hierarchy concept. |
| `LcmContext` → `Bus.publish` | Volt-specific event bus for TUI progress indicators. |
| `config.ts` → `Global.Path.data` | Embedded Postgres path under Volt's global data directory. |

---

## 7. Framework Design: LedgerMind

### 7.1 Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  @ledgermind/adapters/*                                     │
│  vercel-ai | langchain | openai-agents | generic            │
├─────────────────────────────────────────────────────────────┤
│  @ledgermind/tools                                          │
│  memory.grep | memory.expand | memory.describe              │
├─────────────────────────────────────────────────────────────┤
│  @ledgermind/runtime                                        │
│  Compaction loop | Background jobs | Batching               │
├──────────────────────┬──────────────────────────────────────┤
│  @ledgermind/explore  │  @ledgermind/core                   │
│  ExploreDispatcher    │  Summary DAG Engine                 │
│  30+ Parsers          │  Compaction Policies                │
│  Large File Handling  │  Budget Planner                     │
│                       │  Retrieval Planner                  │
├──────────────────────┴──────────────────────────────────────┤
│  @ledgermind/db                                             │
│  PostgreSQL schema | Migrations | Queries | Integrity       │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Three Abstraction Interfaces

#### Interface 1: `LanguageModel` (replaces `Provider.Model`)

```typescript
export interface LanguageModel {
  id: string;
  contextWindow: number;
  countTokens(text: string): number | Promise<number>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream?(req: GenerateRequest): AsyncIterable<GenerateDelta>;
}

interface GenerateRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  abortSignal?: AbortSignal;
}

interface GenerateResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}
```

#### Interface 2: `ConversationAdapter` (replaces Session→Conversation mapping)

```typescript
export interface ConversationAdapter<FrameworkEvent = unknown> {
  /** Convert framework events to immutable ledger events */
  toLedgerEvents(event: FrameworkEvent): LedgerEvent[];

  /** Convert materialized context back to framework-specific messages */
  toModelMessages(ctx: MaterializedContext): ModelMessage[];

  /** Stable conversation ID mapping */
  getConversationId(event: FrameworkEvent): string;

  /** Optional: parent conversation for sub-agent hierarchy */
  getParentConversationId?(event: FrameworkEvent): string | null;
}
```

#### Interface 3: `ExploreDispatcher` (replaces Volt ExploreDispatcher)

```typescript
export interface ExploreDispatcher {
  canHandle(input: ExploreInput): boolean;
  explore(input: ExploreInput, opts: ExploreOptions): Promise<ExploreResult>;
}

interface ExploreInput {
  uri: string;
  mime?: string;
  language?: string;
  bytes?: number;
  text?: string;
  reader?: () => Promise<Buffer>;
}

interface ExploreResult {
  explorerUsed: string;
  summary: string;
  metadata: Record<string, unknown>;
  tokenCount: number;
}
```

### 7.3 SDK Entrypoints

#### Low-level Store

```typescript
const store = await PostgresStore.connect({ url: "postgres://..." });
await store.append(conversationId, events, { idempotencyKey });
const context = await store.getCurrentContext(conversationId);
```

#### Engine (Compaction + Retrieval)

```typescript
const engine = new MemoryEngine({
  store,
  model,
  exploreDispatcher,
  policy: {
    softThreshold: 0.6,     // 60% of context window
    hardThreshold: 1.0,     // full context window minus overhead
    maxCompactionRounds: 10,
    escalation: "three-level", // normal → aggressive → deterministic
  },
});

// Triggers soft compaction if needed
await engine.onEvent(conversationId, events);

// Returns model-ready context within budget
const ctx = await engine.materializeContext(conversationId, {
  budgetTokens: 128_000,
  overhead: systemPromptTokens + toolSchemaTokens,
});
```

#### Tools

```typescript
const tools = createMemoryTools(engine);
// Returns: { "memory.grep": ..., "memory.expand": ..., "memory.describe": ... }
```

---

## 8. Phased Roadmap

### Phase 1 — Extract + Stabilize Core

**Goal:** Standalone library, works locally, no Volt assumptions.

**Deliverables:**

1. **Standalone packages**: `core`, `db`, `runtime`, `explore`, `tools`
2. **Postgres schema**:
   - `ledger_events` (append-only)
   - `summary_nodes` / `summary_edges` (DAG)
   - `large_files` + derived artifacts
   - integrity tables / checks
3. **Compaction engine with convergence**:
   - Three-level escalation (normal → aggressive → deterministic)
   - Each escalation step guaranteed to reduce token count
4. **Soft/hard threshold loop**:
   - Soft: opportunistic background compaction
   - Hard: enforce budget before context materialization
5. **Type-aware large file support**: Port 30+ explorers with stable interface
6. **One reference adapter** (Vercel AI SDK) + generic adapter
7. **Golden tests**:
   - Deterministic DAG evolution on a fixed transcript
   - Integrity tests for append-only invariants
   - Budget enforcement tests

**Non-goals:** hosted service, multi-tenant auth, UI, vector DB

### Phase 2 — Ecosystem Adapters + Operational Hardening

**Goal:** Easy adoption across frameworks; production safety.

**Deliverables:**

1. **Framework adapters**: LangChain context retriever, OpenAI Agents SDK tool bundle
2. **Observation masking hybrid mode** (from JetBrains NeurIPS 2025 finding):
   - Policy: mask low-value observations before LLM summarization
   - Deterministic/rule-based first; optionally model-assisted
3. **Operator-level recursion**:
   - LLM-Map and Agentic-Map tools
   - Standardized "reduce plan" objects for auditability
4. **Better retrieval planner**:
   - Composite scoring (recency + DAG relevance as default)
   - Optional semantic scoring
5. **Operational knobs**: backpressure handling, compaction job queue

### Phase 3 — "Real Infrastructure" Mode

**Goal:** Shared memory layer for teams/products.

**Deliverables:**

1. **Server mode** (HTTP + optional WebSocket) for multi-agent deployments
2. Auth, multi-tenancy, quotas
3. **Python SDK** (thin client)
4. Optional: **MCP server wrapper** to expose memory tools universally
5. Optional: plugin marketplace for explorers/parsers

---

## 9. Key Technical Decisions & Tradeoffs

### Decision 1: Keep Postgres as Canonical Store ✅

- **Why:** Append-only ledger + DAG + strong indexing + transactions are a natural fit
- **Tradeoff:** Embedded Postgres adds packaging complexity
- **Mitigation:** Support external Postgres equally well

### Decision 2: Summary DAG over Flat Summaries ✅

- **Why:** Enables hierarchical retrieval, partial recomputation, "time slicing"
- **Tradeoff:** More schema + traversal complexity
- **Mitigation:** Keep traversal heuristics simple initially (nearest ancestors + recent leaves)

### Decision 3: Guaranteed Convergence via Bounded Active Set + Escalation ✅

- **Invariant:** Context materialization always chooses from a bounded set:
  - Pinned core nodes
  - Top-K relevant DAG nodes
  - Last-N raw messages
- **Tradeoff:** May discard raw detail earlier
- **Mitigation:** Ledger stays immutable; "expand" tool recovers specifics on demand

### Decision 4: Hybrid Masking + Summarization ✅

- **Why:** JetBrains NeurIPS 2025 research shows observation masking often outperforms pure LLM summarization while being 50%+ cheaper
- **Tradeoff:** Masking policies can be brittle
- **Mitigation:** Start with transparent heuristics; log all decisions

### Decision 5: Tools-First Memory Access ✅

- **Why:** Lets agents recover precise details without bloating the main context
- **Tradeoff:** More tool calls
- **Mitigation:** Caching + good defaults for what's pre-loaded

### Decision 6: Type-Aware Large File Handling as First-Class Feature ✅

- **Why:** Coding agents live and die by file context; generic chunking is insufficient
- **Tradeoff:** Maintaining 30+ explorers requires discipline
- **Mitigation:** Treat explorers as plugins with conformance tests

### When to Revisit with More Complex Design

- Need multi-tenant shared memory across many machines → Phase 3 server mode
- Need strong cross-conversation semantic recall → add optional vector index (keep DAG as source of truth)
- Need sub-second retrieval at massive scale → specialized indexes/materialized views; don't pre-optimize

---

## 10. Integration Patterns

### Pattern A: "Drop-in Memory Middleware" (Recommended)

Framework keeps control. LedgerMind provides hooks:

```typescript
// Vercel AI SDK integration
const ctx = await engine.materializeContext(convId, { budgetTokens: 24_000 });

const result = await streamText({
  model: vercelModel,
  messages: [
    { role: "system", content: ctx.systemPreamble },
    ...ctx.modelMessages,
    ...incomingMessages,
  ],
  tools: { ...appTools, ...createMemoryTools(engine) },
});

// After response, append to ledger
await engine.onEvent(convId, adapter.toLedgerEvents(result));
```

### Pattern B: "Memory-as-a-Tool"

Expose tools for the agent to call on demand:

```typescript
// OpenAI Agents SDK integration
const memoryTools = createMemoryTools(engine);
// Returns: memory.search, memory.expand, memory.describe
// Agent decides when to call them
```

### Pattern C: "Context Provider"

For frameworks that prefer structured context injection:

```typescript
// LangChain integration
const provider = new LedgerMindContextProvider(engine);
const context = await provider.getContext(conversationId, {
  budgetTokens: 16_000,
});
// Returns: { pinnedSummary, relevantSummaries, recentMessages, fileArtifacts }
```

### Framework-Specific Notes

| Framework | Integration Style | Notes |
|---|---|---|
| **Vercel AI SDK** | Pattern A (middleware) | Wrap `streamText()`/`generateText()` |
| **LangChain** | Pattern C (context provider) | Provide `LedgerMindContextRetriever` (not "Memory") |
| **OpenAI Agents SDK** | Pattern B (tools) | Tool set + optional pre-run hook for instructions |
| **Custom agents** | All patterns | Single contract: `append(events)` + `materializeContext(budget)` + `tools()` |

---

## 11. References

### Papers

1. Ehrlich, C. & Blackman, T. (2026). *LCM: Lossless Context Management*. Voltropy PBC. arXiv:submit/7269166
2. Packer, C., Wooders, S., Lin, K., et al. (2023). *MemGPT: Towards LLMs as Operating Systems*. arXiv:2310.08560
3. Zhang, A. L., Kraska, T., & Khattab, O. (2026). *Recursive Language Models*. (Referenced in LCM paper)
4. Lindenbauer, T. et al. (2025). *The Complexity Trap: Efficient Context Management for LLM Agents*. NeurIPS 2025 Deep Learning 4 Code Workshop. arXiv:2508.21433
5. Hong, K., Troynikov, A., & Huber, J. (2025). *Context Rot: How context degradation affects LLM performance*.
6. Liu, N. F. et al. (2023). *Lost in the Middle: How Language Models Use Long Contexts*. arXiv:2307.03172

### Frameworks Analyzed

- **LangChain / LangGraph**: https://github.com/langchain-ai/langchain
- **Letta (MemGPT)**: https://github.com/letta-ai/letta
- **Microsoft AutoGen**: https://github.com/microsoft/autogen
- **CrewAI**: https://github.com/crewAIInc/crewAI
- **Mem0**: https://github.com/mem0ai/mem0
- **Volt (LCM reference implementation)**: https://github.com/martian-engineering/volt

### Industry Analysis

- JetBrains Research Blog: *Cutting Through the Noise: Smarter Context Management for LLM-Powered Agents* (Dec 2025)
- Adaline Blog: *Top Agentic LLM Models & Frameworks for 2026* (Dec 2025)
- Kargar, I. (2026). *The Fundamentals of Context Management and Compaction in LLMs*. Medium.
