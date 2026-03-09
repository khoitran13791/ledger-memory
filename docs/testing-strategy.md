# LedgerMind: Testing & Validation Strategy

> **How We Know The Code Works — and Produces Good Results**
> Version: 1.0 | Date: February 26, 2026 | Status: Accepted
>
> Informed by analysis of Letta/MemGPT, LangChain/LangGraph, Factory.ai,
> CMU SEI summarization evaluation research, and DeepEval/G-Eval frameworks.

---

## Table of Contents

1. [Testing Philosophy](#1-testing-philosophy)
2. [Testing Pyramid by Layer](#2-testing-pyramid-by-layer)
3. [Golden Test Suite](#3-golden-test-suite)
4. [Property-Based Testing](#4-property-based-testing)
5. [Contract & Conformance Testing](#5-contract--conformance-testing)
6. [Compaction Quality Validation](#6-compaction-quality-validation)
7. [Probe-Based Evaluation](#7-probe-based-evaluation)
8. [Regression Test Catalog](#8-regression-test-catalog)
9. [CI/CD Pipeline](#9-cicd-pipeline)
10. [Test Infrastructure & Tooling](#10-test-infrastructure--tooling)

---

## 1. Testing Philosophy

### Core Principle

**Two independent validation axes:**

```
Axis 1: Algorithmic Correctness (deterministic, every PR)
  "Does the compaction loop converge? Are invariants preserved?"

Axis 2: Semantic Quality (LLM-evaluated, nightly)
  "Can an agent still continue working after compaction?"
```

Neither axis alone is sufficient. Correct algorithms can produce useless
summaries. Good summaries can mask structural bugs.

### Lessons from Industry

| Source | Key Lesson Applied |
|--------|-------------------|
| **Letta/MemGPT** | Test boundary inputs explicitly (empty buffers, system-only). Mock token counters to force escalation paths. Document acceptable error states by string. |
| **LangGraph** | Conformance suites ensure adapter substitutability. `MemorySaverAssertImmutable` catches mutation bugs. Hardcoded legacy blobs prevent migration regressions. |
| **Factory.ai** | Probe-based evaluation measures *functional* quality (can the agent continue?), not just lexical similarity. Structure in summaries forces preservation. |
| **CMU SEI / OpenAI** | ROUGE/BERTScore alone correlate poorly with actual quality. LLM-as-judge (G-Eval) with rubrics is more reliable. QA-based recall measures information preservation. |

### Test Double Strategy

| Double | Use For | Avoid |
|--------|---------|-------|
| **Fakes** (in-memory adapters with real logic) | Persistence ports — full behavior without DB | — |
| **Stubs** (deterministic summarizer/tokenizer) | Golden tests, property tests | Production code |
| **Mocks** (verify call patterns) | LLM provider routing, job queue dispatch | Domain logic (test directly) |
| **Recorded responses** | LLM integration tests (replay mode) | Golden tests (use deterministic stub) |

---

## 2. Testing Pyramid by Layer

```
                        ┌─────────┐
                        │  Probe  │  Can the agent still work after compaction?
                       ┌┴─────────┴┐
                       │   E2E     │  SDK → DB → Compaction → Tools (5-10 tests)
                      ┌┴───────────┴┐
                      │ Conformance │  Same suite runs against PG + SQLite + InMemory
                     ┌┴─────────────┴┐
                     │  Application   │  Use cases with in-memory fake ports
                    ┌┴───────────────┴┐
                    │     Domain       │  Pure unit tests, zero I/O
                    └─────────────────┘
```

### 2.1 Domain Layer Tests (~60-70% of test count)

**Goal:** Prove invariants of entities, value objects, and pure domain services.

| Test Category | What to Assert | Example |
|---------------|---------------|---------|
| **ID canonicalization** | Same content → same ID; different conversation → different ID | `generateEventId("hello", conv1, ...) !== generateEventId("hello", conv2, ...)` |
| **Branded type factories** | `TokenCount` rejects negative values | `expect(() => createTokenCount(-1)).toThrow()` |
| **CompactionPolicy** | Candidate selection respects pin rules, min block size, token target | Given 10 items with tail=3 pinned → candidates = items 1-7 |
| **Deterministic fallback** | Always produces ≤ 512 tokens | Property: `∀ input. deterministicFallback(input).tokenCount ≤ 512` |
| **TokenBudget computation** | `available = contextWindow - overhead - reserve` | `computeBudget({contextWindow: 128000, ...}).available === expected` |
| **Domain events** | Correct event types emitted by domain services | — |
| **Domain errors** | Invariant violations produce typed errors | `NonMonotonicSequenceError` when seq decreases |

**How:** Vitest unit tests. Table-driven (`it.each`). No mocking needed.

### 2.2 Application Layer Tests (~20-30%)

**Goal:** Prove use case orchestration correctness with fake ports.

**Test Harness:**
- `DeterministicSummarizer` + `SimpleTokenizer` (from addendum)
- In-memory port implementations (full behavior, no DB)

| Use Case | Key Assertions |
|----------|---------------|
| **append()** | Monotonic seq assigned; idempotency key dedup; events persisted verbatim; `LedgerEventAppended` emitted; soft threshold check triggers compaction scheduling |
| **materializeContext()** | Output ≤ budget; pinned items always included; hard threshold triggers blocking compaction; `ContextMaterialized` emitted with correct counts |
| **runCompaction()** | Escalation L1→L2→L3 on non-shrinking output; DAG edges created correctly; artifact IDs propagated; convergence within maxRounds; `SummaryNodeCreated` emitted per round |
| **grep()** | Regex matches across ledger; scoped to DAG subtree when `scope` provided |
| **describe()** | Returns correct metadata for summary nodes and artifacts |
| **expand()** | Returns original messages from DAG walk; respects authorization gate |
| **storeArtifact()** | Content-addressed ID; stores inline/path variants |
| **exploreArtifact()** | Dispatches to correct explorer; respects maxTokens |

### 2.3 Adapter Layer Tests (~10-15%)

**Goal:** Verify SQL correctness, mapping fidelity, and backend-specific behavior.

| Test Category | What to Assert |
|---------------|---------------|
| **Schema constraints** | `UNIQUE(conversation_id, seq)` rejects duplicates; `CHECK(token_count >= 0)` enforced |
| **Round-trip fidelity** | Insert event → read back → content identical; summary node → edges → `expandToMessages` returns correct recursive expansion |
| **Full-text search** | PG tsvector / SQLite FTS5 return expected matches |
| **Regex search** | `regexSearchEvents` returns correct matches with grouping |
| **Context versioning** | Stale version on `replaceContextItems` throws `StaleContextError` |
| **Migration idempotency** | Running migrations twice doesn't error |
| **Explorer conformance** | Same input → same structural summary; `maxTokens` respected |

**How:** Ephemeral databases per test suite (PG via service container, SQLite in-process).

### 2.4 E2E Tests (5-10 tests, high value)

**Goal:** Validate SDK wiring and realistic flows.

```typescript
// Example E2E test
it("full lifecycle: append → compact → materialize → grep → expand", async () => {
  const engine = await createMemoryEngine({ storage: "postgres", ... });

  // Append a conversation
  await engine.append({ conversationId, events: transcript });

  // Store and explore an artifact
  const { artifactId } = await engine.storeArtifact({ conversationId, source: { kind: "text", content: largeJson } });
  const exploration = await engine.exploreArtifact({ artifactId });

  // Materialize under tight budget (forces compaction)
  const ctx = await engine.materializeContext({ conversationId, budgetTokens: 2000, overheadTokens: 200 });
  expect(ctx.budgetUsed.value).toBeLessThanOrEqual(1800);

  // Grep finds content from compacted history
  const grepResult = await engine.grep({ conversationId, pattern: "specific-term" });
  expect(grepResult.matches.length).toBeGreaterThan(0);

  // Expand recovers original messages
  const summaryRef = ctx.summaryReferences[0];
  const expanded = await engine.expand({ summaryId: summaryRef.id, callerContext: subAgentCaller });
  expect(expanded.messages.length).toBeGreaterThan(0);

  // Integrity holds
  const integrity = await engine.checkIntegrity({ conversationId });
  expect(integrity.report.passed).toBe(true);
});
```

---

## 3. Golden Test Suite

### Purpose

Deterministic, snapshot-stable tests that verify the exact DAG evolution for
a fixed input transcript. Same input always produces same IDs, same DAG
structure, same materialized output.

### Golden Test Vector Format

```typescript
// tests/golden/fixtures/basic-compaction.fixture.ts
export const basicCompactionFixture = {
  name: "basic-compaction",
  conversation: {
    modelName: "test-model",
    contextWindow: 4000,
    thresholds: { soft: 0.6, hard: 1.0 },
  },
  // Events to append (in order)
  events: [
    { role: "user", content: "Help me build an auth system" },
    { role: "assistant", content: "I'll design a JWT-based auth system..." },
    { role: "user", content: "What about refresh tokens?" },
    { role: "assistant", content: "Good question. Refresh tokens should..." },
    // ... enough to exceed soft threshold
  ],
  // Actions to perform after append
  actions: [
    { type: "materialize", budgetTokens: 1000, overheadTokens: 200 },
  ],
  // Expected outcomes
  expected: {
    dagNodeCount: 1,           // one summary node created
    dagNodeKinds: ["leaf"],
    contextItemCount: 4,       // summary + 3 tail items
    budgetUsedLessThan: 800,
    integrityPassed: true,
    // Stable IDs (content-addressed)
    summaryIdPrefix: "sum_",
    expandRecoveryCount: 4,    // expand returns original 4 messages
  },
};
```

### Cross-Adapter Execution

The **same golden vectors** run against all adapter implementations:

```typescript
describe.each([
  ["in-memory", () => createInMemoryAdapter()],
  ["postgres", () => createPostgresAdapter(testDbUrl)],
  ["sqlite", () => createSqliteAdapter(":memory:")],
])("golden tests (%s)", (name, createAdapter) => {
  it.each(goldenFixtures)("$name", async (fixture) => {
    const adapter = await createAdapter();
    const engine = createEngine(adapter);
    // ... run fixture, assert expected outcomes
  });
});
```

### Non-Deterministic Field Handling

Inspired by LangGraph's `AnyStr()` pattern:

```typescript
// test-helpers/matchers.ts
class AnyTimestamp {
  equals(other: unknown) { return other instanceof Date; }
}

class AnyId {
  constructor(private prefix: string) {}
  equals(other: unknown) {
    return typeof other === "string" && other.startsWith(this.prefix);
  }
}

// Usage in assertions
expect(node.id).toEqual(new AnyId("sum_"));
expect(node.createdAt).toEqual(new AnyTimestamp());
```

### Phase 1 Golden Suite Implementation Plan (Core Engine)

#### Goal

Ship a deterministic, replay-stable golden suite that runs real Phase 1 use cases end-to-end:
`append` → `runCompaction` → `materializeContext` → `checkIntegrity`.

#### Scope for Phase 1

- **Required PR gate:** in-memory golden scenarios
- **Parity subset:** same fixtures against PostgreSQL
- **Out of scope for now:** SQLite parity, LLM-judge scoring, probe evaluation

#### Harness Design

Create a shared scenario runner (`tests/golden/shared/run-golden-scenario.ts`) that:

1. Builds deterministic dependencies (`FixedClock`, `SimpleTokenizer`, deterministic `HashPort`, deterministic/scripted summarizer)
2. Replays fixture steps in order using real use cases
3. Captures canonical outputs per step
4. Captures final canonical state signature
5. Re-runs fixture in a fresh harness and asserts exact equality (replay stability)

#### Fixture Format (v2)

Use step-based fixtures (not pre-constructed DAG state):

- `conversation`: fixed IDs + config
- `deps`: deterministic mode options
- `steps`: `append`, `runCompaction`, `materialize`, `checkIntegrity`
- `expected`:
  - per-step canonical outputs
  - final canonical signature (ledger, summaries, edges, context refs, integrity)

#### Phase 1 Scenario Matrix

**P0 (must-have):**
1. append-materialize-baseline
2. hard-compaction-leaf
3. deterministic-fallback-escalation
4. artifact-propagation-through-compaction
5. idempotent-replay-conflict

**P1 (next):**
6. multi-round-condensation-lineage
7. postgres-restart-rehydration-parity

#### Canonical Assertions

For each fixture, assert:

- Stable IDs and deterministic ordering
- Contiguous ledger sequence + contiguous context positions
- Expected summary kinds and DAG lineage edges
- `integrity.report.passed === true` (except explicit failure fixtures)
- Materialized budget usage never exceeds `budgetTokens - overheadTokens`
- Expand recovery returns original message sequence for covered summaries
- Artifact IDs survive compaction/condensation lineage

#### Determinism Controls

- No wall clock, random UUID, or non-deterministic tokenizer in golden tests
- Default deterministic summarizer for snapshot stability
- Scripted summarizer allowed for escalation-path fixtures (force L1/L2 non-shrinking)
- Canonicalization must sort all order-sensitive collections before snapshot/assert

#### CI Rollout

Add scripts:

- `pnpm test:golden:verify` (required on PR)
- `pnpm test:golden:postgres` (required when PG service available)
- `pnpm test:golden:update` (manual, review required)

Golden snapshot diffs are treated as behavior/API diffs and require explicit reviewer approval.

#### Why This Improves LLM Agent Quality

This prevents silent memory regressions by enforcing:

- **Replay stability:** same transcript always yields same memory state
- **Recall fidelity:** summary lineage and expand recovery remain correct
- **Budget safety:** materialized context remains bounded and predictable
- **Backend consistency:** in-memory vs Postgres behavior stays aligned

Result: agents receive stable, trustworthy context across compaction rounds, reducing drift, hallucinated continuity, and retrieval failures in long-running sessions.

---

## 4. Property-Based Testing

Use `fast-check` to generate random operation sequences and verify
invariants hold universally.

### 4.1 DAG Acyclicity

```typescript
import fc from "fast-check";

it("DAG remains acyclic after arbitrary compaction sequences", () => {
  fc.assert(
    fc.asyncProperty(
      arbitraryConversationConfig(),
      arbitraryEventSequence({ minLength: 5, maxLength: 50 }),
      arbitraryCompactionCount({ min: 1, max: 10 }),
      async (config, events, compactionCount) => {
        const engine = createTestEngine();
        const convId = await engine.createConversation(config);
        await engine.append({ conversationId: convId, events });

        for (let i = 0; i < compactionCount; i++) {
          await engine.runCompaction({ conversationId: convId, trigger: "hard" });
        }

        const integrity = await engine.checkIntegrity({ conversationId: convId });
        expect(integrity.report.checks.find(c => c.name === "acyclic_dag")!.passed).toBe(true);
      },
    ),
    { numRuns: 200 },
  );
});
```

### 4.2 Append-Only Guarantee

```typescript
it("previously appended events are never modified", () => {
  fc.assert(
    fc.asyncProperty(
      arbitraryEventSequence({ minLength: 2, maxLength: 20 }),
      async (events) => {
        const engine = createTestEngine();
        const convId = await engine.createConversation(defaultConfig);

        // Append first half
        const firstHalf = events.slice(0, Math.ceil(events.length / 2));
        await engine.append({ conversationId: convId, events: firstHalf });
        const snapshot1 = await engine.getEvents(convId);

        // Append second half + run compaction
        const secondHalf = events.slice(Math.ceil(events.length / 2));
        await engine.append({ conversationId: convId, events: secondHalf });
        await engine.runCompaction({ conversationId: convId, trigger: "hard" });

        // First half events unchanged
        const snapshot2 = await engine.getEvents(convId, { start: 0, end: firstHalf.length });
        for (let i = 0; i < firstHalf.length; i++) {
          expect(snapshot2[i].content).toBe(snapshot1[i].content);
          expect(snapshot2[i].id).toBe(snapshot1[i].id);
        }
      },
    ),
    { numRuns: 200 },
  );
});
```

### 4.3 Compaction Convergence

```typescript
it("compaction always converges within maxRounds", () => {
  fc.assert(
    fc.asyncProperty(
      arbitraryConversationConfig(),
      arbitraryEventSequence({ minLength: 10, maxLength: 100 }),
      async (config, events) => {
        const engine = createTestEngine();
        const convId = await engine.createConversation(config);
        await engine.append({ conversationId: convId, events });

        const result = await engine.runCompaction({
          conversationId: convId,
          trigger: "hard",
        });

        // Must complete within configured maxRounds
        expect(result.rounds).toBeLessThanOrEqual(config.compaction.maxRounds);

        // Post-compaction: context is within budget
        const budget = computeBudget(config, { value: 0 });
        const tokenCount = await engine.getContextTokenCount(convId);
        expect(tokenCount.value).toBeLessThanOrEqual(budget.available.value);
      },
    ),
    { numRuns: 100 },
  );
});
```

### 4.4 Token Budget Enforcement

```typescript
it("materialized context never exceeds budget", () => {
  fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 500, max: 50000 }),  // budget
      fc.integer({ min: 0, max: 500 }),       // overhead
      arbitraryEventSequence({ minLength: 5, maxLength: 50 }),
      async (budgetTokens, overheadTokens, events) => {
        const engine = createTestEngine();
        const convId = await engine.createConversation(defaultConfig);
        await engine.append({ conversationId: convId, events });

        const ctx = await engine.materializeContext({
          conversationId: convId,
          budgetTokens,
          overheadTokens,
        });

        expect(ctx.budgetUsed.value).toBeLessThanOrEqual(budgetTokens - overheadTokens);
      },
    ),
    { numRuns: 200 },
  );
});
```

### 4.5 Mutation Detection (LangGraph-Inspired)

```typescript
it("returned objects are not internal references (no mutation leaks)", () => {
  fc.assert(
    fc.asyncProperty(
      arbitraryEventSequence({ minLength: 3, maxLength: 10 }),
      async (events) => {
        const engine = createTestEngine(); // in-memory adapter
        const convId = await engine.createConversation(defaultConfig);
        await engine.append({ conversationId: convId, events });

        // Get context, mutate the returned array
        const ctx1 = await engine.getCurrentContext(convId);
        ctx1.items.push({ position: 999, ref: { type: "message", messageId: "fake" } } as any);

        // Fetch again — mutation must not be visible
        const ctx2 = await engine.getCurrentContext(convId);
        expect(ctx2.items.length).toBe(events.length); // not 999
      },
    ),
  );
});
```

---

## 5. Contract & Conformance Testing

### Purpose

Ensure PostgreSQL and SQLite (and in-memory) adapters are interchangeable,
following the Liskov Substitution Principle.

### Conformance Suite Structure

```
tests/conformance/
├── persistence/
│   ├── ledger-append.conformance.ts
│   ├── ledger-read.conformance.ts
│   ├── context-projection.conformance.ts
│   ├── summary-dag.conformance.ts
│   ├── artifact-store.conformance.ts
│   ├── conversation.conformance.ts
│   └── unit-of-work.conformance.ts
└── run-conformance.ts              # Entry point: accepts adapter factory
```

### Capability Detection (LangGraph-Inspired)

```typescript
interface AdapterCapabilities {
  fullTextSearch: boolean;           // PG: yes, SQLite FTS5: yes, InMemory: basic
  regexSearch: boolean;              // PG: yes (~ operator), SQLite: limited
  recursiveCTE: boolean;             // PG: yes, SQLite: yes (slower at scale)
  concurrentWrites: boolean;         // PG: yes, SQLite: WAL mode
}

function runConformance(factory: AdapterFactory, capabilities: AdapterCapabilities) {
  // Core tests always run
  describe("ledger append", () => { /* ... */ });
  describe("context projection", () => { /* ... */ });

  // Capability-gated tests
  if (capabilities.regexSearch) {
    describe("regex search", () => { /* ... */ });
  }
  if (capabilities.concurrentWrites) {
    describe("concurrent append safety", () => { /* ... */ });
  }
}
```

### Key Conformance Assertions

| Port | Assertion | Why |
|------|-----------|-----|
| `LedgerAppendPort` | Duplicate seq rejected | Monotonic invariant |
| `LedgerAppendPort` | Duplicate idempotency key is no-op | Idempotency contract |
| `LedgerReadPort` | Events returned sorted by seq ascending | Ordering contract |
| `ContextProjectionPort` | Stale version throws `StaleContextError` | Concurrency contract |
| `ContextProjectionPort` | Positions contiguous after replace | Contiguity invariant |
| `SummaryDagPort` | `expandToMessages` returns correct transitive closure | DAG walk correctness |
| `SummaryDagPort` | `checkIntegrity` detects injected orphan edges | Integrity enforcement |
| `ArtifactStorePort` | Store + getContent round-trips for all storage kinds | Fidelity |
| `UnitOfWorkPort` | Rollback on error undoes all mutations | Atomicity |

---

## 6. Compaction Quality Validation

### 6.1 Deterministic Quality (Every PR — No LLM)

These tests verify *structural* correctness, not semantic quality:

| Metric | How Measured | Threshold |
|--------|-------------|-----------|
| **Budget compliance** | `ctx.budgetUsed ≤ budget` | Always pass |
| **Compression monotonicity** | `summary.tokenCount < input.tokenCount` at L1/L2 | Always (or escalate) |
| **Escalation correctness** | L3 invoked only after L1+L2 fail to shrink | Assert escalation path |
| **DAG integrity** | All 8 checks pass | Always pass |
| **ID stability** | Same input → same IDs across runs | Snapshot comparison |
| **Expand recovery** | `expand(summary)` returns original messages | Content equality |

### 6.2 LLM-as-Judge Quality Evaluation (Nightly)

Run real LLM summarization on fixed transcripts, then score with a judge model.

**Rubric Dimensions** (inspired by Factory.ai + G-Eval):

| Dimension | Score 1-5 | What It Measures |
|-----------|-----------|-----------------|
| **Faithfulness** | No hallucinated facts | Every claim in summary is supported by source |
| **Coverage** | Key decisions/constraints included | Important entities, constraints, and decisions preserved |
| **Specificity** | Concrete details retained | File paths, variable names, numbers, IDs not generalized away |
| **Actionability** | Supports next-step continuation | Reader can determine "what to do next" from summary alone |
| **Coherence** | Readable, non-contradictory | Summary is well-structured and internally consistent |
| **Provenance** | References tools/artifacts | Summary mentions artifact handles, suggests expand() when appropriate |

**Acceptance gates:**
- Faithfulness ≥ 4.0 (strictest — no hallucination tolerance)
- Average across all dimensions ≥ 3.5
- No individual dimension below 2.5

**Judge prompt structure:**

```
You are evaluating a summary produced by a context compaction system.

SOURCE CONTENT (original messages):
{source_messages}

SUMMARY PRODUCED:
{summary_content}

Rate the summary on each dimension (1-5) with reasoning:
1. Faithfulness: ...
2. Coverage: ...
3. Specificity: ...
4. Actionability: ...
5. Coherence: ...
6. Provenance: ...

Output JSON: { "scores": { ... }, "reasoning": { ... } }
```

### 6.3 QA-Based Information Preservation (Nightly)

Measures whether specific facts survive compaction:

```typescript
interface QAProbe {
  question: string;          // "What database did we choose?"
  groundTruth: string;       // "PostgreSQL"
  category: "entity" | "decision" | "constraint" | "artifact" | "number";
}

// Test flow:
// 1. Append transcript with known facts
// 2. Run compaction (real LLM)
// 3. Materialize context
// 4. For each probe: ask question using ONLY materialized context
// 5. Score: exact match or LLM-judge correctness

const probes: QAProbe[] = [
  { question: "What auth mechanism was chosen?", groundTruth: "JWT", category: "decision" },
  { question: "What is the token limit?", groundTruth: "128000", category: "number" },
  { question: "Which file was modified?", groundTruth: "src/auth.ts", category: "artifact" },
];

// Metric: QA Recall = correct answers / total probes
// Target: QA Recall ≥ 0.8 (80% of facts survive compaction)
```

### 6.4 Supplemental Metrics (Track, Don't Gate)

| Metric | What | Use |
|--------|------|-----|
| **Compression ratio** | `input_tokens / summary_tokens` | Track trend; don't optimize blindly |
| **ROUGE-L** | Lexical overlap between summary and source | Baseline; penalizes good paraphrase |
| **BERTScore F1** | Semantic similarity via embeddings | Better than ROUGE; still imperfect |
| **Compaction cost** | Total LLM tokens spent on summarization | Track for cost optimization |

---

## 7. Probe-Based Evaluation

### Purpose

Black-box tests that give an agent **only the materialized context** (post-compaction)
and measure whether it can still perform real tasks. Inspired by Factory.ai's
evaluation framework.

### Probe Types

#### 7.1 Recall Probes

Test: Can specific facts be retrieved from compressed context?

```typescript
{
  type: "recall",
  setup: [
    { role: "user", content: "Set the Redis connection timeout to 30 seconds" },
    { role: "assistant", content: "Done. Updated redis.config.ts with timeout: 30000ms" },
  ],
  // After compaction:
  question: "What is the Redis connection timeout?",
  expectedAnswer: "30 seconds (30000ms)",
  gradingCriteria: "exact_value",
}
```

#### 7.2 Artifact Probes

Test: Are artifact references and exploration summaries preserved?

```typescript
{
  type: "artifact",
  setup: {
    events: [...],
    artifacts: [{ path: "config/database.json", content: '{"host":"db.prod","port":5432}' }],
  },
  question: "What database host is configured?",
  expectedAnswer: "db.prod",
  requiresArtifactReference: true,  // Must mention artifact ID or suggest expand()
}
```

#### 7.3 Continuation Probes

Test: Can the agent continue a multi-step task?

```typescript
{
  type: "continuation",
  setup: [
    // Steps 1-5 of a task, where step 3 is "completed"
    { role: "user", content: "Plan: 1) Add schema 2) Write migration 3) Add API endpoint 4) Write tests 5) Update docs" },
    { role: "assistant", content: "Step 1: Added User schema. Step 2: Created migration 001. Step 3: Added /users endpoint." },
  ],
  question: "What should we do next?",
  expectedAnswer: "Step 4: Write tests (for the /users endpoint)",
  gradingCriteria: "correct_next_step",
}
```

#### 7.4 Decision Probes

Test: Are past constraints and decisions preserved?

```typescript
{
  type: "decision",
  setup: [
    { role: "user", content: "We must not add any new npm dependencies" },
    { role: "assistant", content: "Understood. I'll use only built-in Node.js modules." },
    // ... many more messages ...
  ],
  question: "Can we use lodash for this utility function?",
  expectedAnswer: "No — we decided not to add new npm dependencies",
  gradingCriteria: "constraint_adherence",
}
```

#### 7.5 Tool-Usage Probes

Test: Does the summary correctly guide tool usage (grep/expand/describe)?

```typescript
{
  type: "tool_usage",
  setup: [
    // Conversation about auth implementation, compacted to summary with artifact refs
  ],
  question: "What was the exact JWT secret rotation logic?",
  expectedBehavior: "Should recognize that the summary is insufficient and suggest using memory.expand(sum_xxx) to retrieve full details",
  gradingCriteria: "appropriate_tool_suggestion",
}
```

### Evaluation Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Test Fixture  │────▶│  Compaction  │────▶│ Materialized │
│ (transcript)  │     │  Pipeline    │     │   Context    │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                          ┌───────▼───────┐
                                          │  Probe Agent  │
                                          │ (answers Q's  │
                                          │  from context) │
                                          └───────┬───────┘
                                                  │
                                          ┌───────▼───────┐
                                          │  LLM Judge    │
                                          │ (scores 1-5   │
                                          │  per rubric)  │
                                          └───────────────┘
```

---

## 8. Regression Test Catalog

Specific bug patterns to lock down, informed by real bugs in Letta and
similar systems.

### 8.1 Indexing & Ordering Bugs

| Bug Pattern | Test Name | What to Assert |
|-------------|-----------|---------------|
| **Off-by-one in context positions** | `context-positions-contiguous-after-replace` | Positions form `[0, 1, ..., N-1]` with no gaps after every `replaceContextItems` call |
| **Tail window pin misapplied** | `tail-window-respects-size-config` | With `tailWindowSize: 3` and 10 items, items 7-9 are always pinned (Letta had a bug where percentage was treated as integer) |
| **Sequence gap after concurrent append** | `monotonic-seq-under-concurrent-append` | Two concurrent `append()` calls produce contiguous sequences, no gaps |

### 8.2 Compaction Loop Pathologies

| Bug Pattern | Test Name | What to Assert |
|-------------|-----------|---------------|
| **Summary not shrinking → infinite loop** | `escalation-triggered-when-summary-not-smaller` | If L1 output ≥ input tokens → L2 invoked (not retry of L1) |
| **Deterministic fallback exceeds 512** | `fallback-marker-included-in-token-count` | Truncation marker tokens counted in budget; output always ≤ 512 |
| **maxRounds exhausted without fallback** | `deterministic-fallback-always-reachable` | Given maxRounds=10 and any input, L3 is always reachable and terminates the loop |
| **Compaction on empty context** | `compaction-noop-on-empty-context` | `runCompaction` with 0 events returns `{ rounds: 0, converged: true }` without error |
| **Compaction on system-only context** | `compaction-skips-pinned-system-message` | System message is never selected as compaction candidate |

### 8.3 Concurrency Bugs

| Bug Pattern | Test Name | What to Assert |
|-------------|-----------|---------------|
| **Stale context version** | `stale-version-causes-retry-not-corruption` | Two concurrent `replaceContextItems` with same version → one succeeds, other throws `StaleContextError` |
| **Parallel compaction produces cycles** | `parallel-compaction-maintains-dag-integrity` | Two compactions running simultaneously produce no cycles or orphan edges |

### 8.4 DAG Integrity Bugs

| Bug Pattern | Test Name | What to Assert |
|-------------|-----------|---------------|
| **Orphan edges after partial failure** | `failed-compaction-leaves-no-orphan-edges` | If compaction fails mid-way (e.g., summarizer error), no partial DAG edges remain |
| **Condensed node without parents** | `condensed-node-requires-parent-edges` | `checkIntegrity` catches condensed node with 0 parent edges |
| **Artifact ID propagation loss** | `artifact-ids-survive-condensation` | After condensing two leaf summaries (each with artifact IDs), the condensed node has the union of all artifact IDs |

### 8.5 Search & Retrieval Bugs

| Bug Pattern | Test Name | What to Assert |
|-------------|-----------|---------------|
| **Regex scope leak** | `grep-respects-scope-parameter` | When `scope: summaryId` is provided, results only include events covered by that summary subtree |
| **Unicode in IDs** | `content-hash-stable-for-unicode` | Events with Unicode content produce stable, correct SHA-256 IDs |
| **FTS false negatives** | `fulltext-search-finds-partial-words` | Search for "authen" finds events containing "authentication" |

### 8.6 Idempotency Bugs

| Bug Pattern | Test Name | What to Assert |
|-------------|-----------|---------------|
| **Same content, different idempotency keys** | `different-keys-same-content-both-appended` | Two events with identical content but different keys are both stored |
| **Same key, different content** | `same-key-different-content-rejected` | Second append with same idempotency key but different content throws `IdempotencyConflictError` |
| **Same key, same content** | `duplicate-key-same-content-is-noop` | Second append returns success without creating duplicate |

---

## 9. CI/CD Pipeline

### 9.1 On Every PR (< 3 minutes, deterministic)

```yaml
# .github/workflows/pr.yml
jobs:
  quality:
    steps:
      - pnpm install
      - pnpm typecheck              # tsc --noEmit across all packages
      - pnpm lint                    # ESLint + boundary rules
      - pnpm test:domain             # Pure unit tests (~60% of tests)
      - pnpm test:application        # Use case tests with in-memory fakes
      - pnpm test:golden             # Golden vector suite (deterministic)
      - pnpm test:property --runs=50 # fast-check with reduced iterations
      - pnpm test:conformance:memory # Conformance against in-memory adapter
      - pnpm test:conformance:sqlite # Conformance against SQLite

  postgres:
    services:
      postgres: { image: postgres:16 }
    steps:
      - pnpm test:conformance:pg     # Conformance against PostgreSQL
```

### 9.2 Nightly (< 30 minutes, some non-determinism)

```yaml
# .github/workflows/nightly.yml
jobs:
  extended:
    steps:
      - pnpm test:property --runs=5000   # Extended property tests
      - pnpm test:e2e                     # Full SDK E2E tests
      - pnpm test:regression              # Full regression catalog

  llm-eval:
    steps:
      - pnpm test:quality:judge           # LLM-as-judge rubric evaluation
      - pnpm test:quality:qa-recall       # QA-based information preservation
      - pnpm test:probes                  # Probe-based continuation evaluation
      # Results posted to dashboard / PR comment for tracking
```

### 9.3 Manual / Release-Gated

| Test | When | Duration |
|------|------|----------|
| **Model matrix** | Before release | ~1h (2-3 summarizer models × test suite) |
| **Concurrent soak** | Before release | ~15min (100+ concurrent appends/compactions) |
| **Migration compatibility** | Before release | ~5min (apply migrations to snapshot DBs) |
| **Large artifact corpus** | Before release | ~10min (binary files, huge JSONs, weird encodings) |
| **Probe evaluation (full set)** | Monthly | ~30min (all probe types × multiple compaction rounds) |

---

## 10. Test Infrastructure & Tooling

### 10.1 Package Dependencies

```json
{
  "devDependencies": {
    "vitest": "^3.x",
    "fast-check": "^3.x",
    "@vitest/coverage-v8": "^3.x",
    "testcontainers": "^10.x"
  }
}
```

### 10.2 Test Helper Utilities

| Utility | Purpose |
|---------|---------|
| `createTestEngine(overrides?)` | Wires in-memory adapters + deterministic stubs |
| `arbitraryEventSequence(opts)` | fast-check arbitrary for random event sequences |
| `arbitraryConversationConfig()` | fast-check arbitrary for valid configs |
| `goldenRunner(fixture, adapter)` | Runs a golden fixture against any adapter |
| `AnyStr(prefix?)` | Matches any string with optional prefix |
| `AnyTimestamp()` | Matches any Date instance |
| `assertIntegrity(engine, convId)` | Runs all 8 integrity checks, asserts all pass |

### 10.3 Test Organization

```
packages/
├── domain/
│   └── src/__tests__/             # Pure unit tests
├── application/
│   └── src/__tests__/             # Use case tests (with in-memory fakes)
├── adapters/
│   └── src/__tests__/             # Explorer conformance, adapter-specific
├── infrastructure/
│   └── src/__tests__/             # Migration tests, SQL constraint tests
└── sdk/
    └── src/__tests__/             # E2E, golden, SDK wiring

tests/
├── conformance/                   # Cross-adapter conformance suite
├── golden/
│   └── fixtures/                  # Golden test vectors (JSON/TS)
├── property/                      # fast-check property tests
├── regression/                    # Specific bug pattern tests
├── probes/                        # Probe-based evaluation
│   ├── fixtures/                  # Probe transcripts + expected answers
│   └── judge/                     # LLM judge prompts + rubrics
└── quality/                       # LLM-as-judge + QA recall tests
    ├── rubrics/                   # Scoring rubrics (JSON)
    └── results/                   # Historical scores (tracked in git)
```

---

## Summary

| Validation Axis | Runs When | What It Proves | Key Tool |
|-----------------|-----------|---------------|----------|
| **Domain unit tests** | Every PR | Invariants hold, types enforce constraints | Vitest |
| **Golden tests** | Every PR | Deterministic DAG evolution, ID stability | Vitest + fixtures |
| **Property tests** | PR (small) / Nightly (full) | Universal invariants (acyclicity, convergence, budget) | fast-check |
| **Conformance suite** | Every PR | Adapters are interchangeable (LSP) | Vitest + adapter factory |
| **Regression catalog** | Every PR | Known bug patterns locked down | Vitest |
| **LLM-as-judge** | Nightly | Summaries are faithful, complete, actionable | LLM + rubric prompts |
| **QA recall** | Nightly | Specific facts survive compaction | LLM + ground truth |
| **Probe evaluation** | Nightly | Agent can continue working after compaction | LLM agent + judge |
| **Model matrix** | Release | Quality consistent across summarizer models | Multi-model runner |
