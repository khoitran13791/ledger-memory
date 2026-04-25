# LoCoMo Raw Evidence Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the default `materializeContext` retrieval path to surface exact raw event evidence under retrieval hints so the default LoCoMo LedgerMind baseline can improve without relying on benchmark-only raw-turn injection.

**Architecture:** Keep the fix inside the application layer and reuse the existing staged retrieval-hint query expansion. `MaterializeContextUseCase` should call `LedgerReadPort.searchEvents()` for the same staged queries it already uses for `SummaryDagPort.searchSummaries()`, then rank raw-event and summary candidates in one shared, budget-aware selection pass that favors exact raw evidence. Expose only the minimal new diagnostics needed to prove raw retrieval happened; do not move benchmark helper logic into the core.

**Tech Stack:** TypeScript, Vitest, Node.js 22+, pnpm workspace scripts, existing Clean Architecture ports in `packages/application`, existing `@ledgermind/benchmark-locomo` harness

---

## File Map

- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts` - extend the local fake state with raw-event search results and add the core red/green regression tests.
- Modify: `packages/application/src/ports/driving/memory-engine.port.ts` - add raw-event retrieval diagnostics to the `materializeContext` public contract.
- Modify: `packages/application/src/use-cases/materialize-context.ts` - implement mixed raw-event/summary hinted retrieval and populate the new diagnostics.
- Modify: `benchmarks/locomo/src/types.ts` - store raw-event retrieval counts and per-hint raw-event traces in benchmark diagnostics.
- Modify: `benchmarks/locomo/src/baselines.ts` - translate the new `materializeContext` diagnostics into benchmark traces without changing benchmark selection logic.
- Modify: `benchmarks/locomo/src/baselines.test.ts` - add deterministic regressions for benchmark diagnostics translation and the default static baseline surfacing raw evidence.

## Scope Guardrails

- Do not copy `injectRawTurnsIntoContext()` from `benchmarks/locomo/src/baselines.ts` into the application layer.
- Do not start with `agentic_loop` or artifact toggles; the canary runs already showed those are secondary.
- Do not change `benchmarks/locomo/src/conversation.ts` or `benchmarks/locomo/src/ledgermind-runtime.ts` unless a failing test proves raw messages do not already contain `ID: D#:N`. Today they do.

### Task 1: Add A Raw-Event Hint Path When Summary Search Misses

**Files:**
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Modify: `packages/application/src/use-cases/materialize-context.ts`
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`

- [ ] **Step 1: Write the failing core regression and extend the local test harness**

```ts
type TestState = {
  conversation: Conversation | null;
  contextItems: ContextItem[];
  contextVersion: ContextVersion;
  events: LedgerEvent[];
  summaries: Map<SummaryNode['id'], SummaryNode>;
  summarySearchResults: Map<string, readonly SummaryNode[]>;
  eventSearchResults: Map<string, readonly LedgerEvent[]>;
  searchQueries: Array<{ readonly query: string; readonly scope?: SummaryNode['id'] }>;
  eventSearchQueries: Array<{ readonly query: string; readonly scope?: SummaryNode['id'] }>;
  artifacts: Map<ArtifactId, Artifact>;
  contextTokenCount: number;
};

class TestLedgerReadPort implements LedgerReadPort {
  constructor(private readonly state: TestState) {}

  async getEvents(): Promise<readonly LedgerEvent[]> {
    return [...this.state.events];
  }

  async searchEvents(
    conversationIdInput: ConversationId,
    query: string,
    scope?: SummaryNode['id'],
  ): Promise<readonly LedgerEvent[]> {
    void conversationIdInput;
    this.state.eventSearchQueries.push({
      query,
      ...(scope === undefined ? {} : { scope }),
    });
    return this.state.eventSearchResults.get(query) ?? [];
  }

  async regexSearchEvents(
    conversationIdInput: ConversationId,
    pattern: string,
    page?: {
      readonly scope?: SummaryNode['id'];
      readonly offset: number;
      readonly limit: number;
    },
  ) {
    void conversationIdInput;
    void pattern;
    void page;
    return {
      matches: [],
      totalMatchCount: 0,
    };
  }
}

const createState = (input?: {
  readonly conversation?: Conversation | null;
  readonly contextItems?: readonly ContextItem[];
  readonly events?: readonly LedgerEvent[];
  readonly summaries?: readonly SummaryNode[];
  readonly summarySearchResults?: Readonly<Record<string, readonly SummaryNode[]>>;
  readonly eventSearchResults?: Readonly<Record<string, readonly LedgerEvent[]>>;
  readonly artifacts?: readonly Artifact[];
  readonly contextTokenCount?: number;
}): TestState => {
  return {
    conversation: input?.conversation ?? createTestConversation(),
    contextItems: [...(input?.contextItems ?? [])],
    contextVersion: createContextVersion(0),
    events: [...(input?.events ?? [])],
    summaries: new Map((input?.summaries ?? []).map((summary) => [summary.id, summary] as const)),
    summarySearchResults: new Map(
      Object.entries(input?.summarySearchResults ?? {}).map(([query, summaries]) => [query, [...summaries]] as const),
    ),
    eventSearchResults: new Map(
      Object.entries(input?.eventSearchResults ?? {}).map(([query, events]) => [query, [...events]] as const),
    ),
    artifacts: new Map((input?.artifacts ?? []).map((artifact) => [artifact.id, artifact] as const)),
    searchQueries: [],
    eventSearchQueries: [],
    contextTokenCount: input?.contextTokenCount ?? 0,
  };
};

it('adds raw retrieval messages when summary retrieval has no match', async () => {
  const exactEvent = createTestMessage({
    id: createEventId('evt_retrieval_raw_only'),
    content: 'DATE: 1 Jan 2026 | ID: D1:7 | Alice: auth token rotation #ZX-41 happens tonight.',
    tokenCount: 18,
    role: 'assistant',
    sequence: 7,
  });

  const state = createState({
    events: [exactEvent],
    eventSearchResults: {
      'auth token rotation #ZX-41': [exactEvent],
      'auth token rotation': [exactEvent],
      'ZX-41': [exactEvent],
    },
    contextTokenCount: 0,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 48,
    overheadTokens: 0,
    retrievalHints: [{ query: 'auth token rotation #ZX-41', limit: 1 }],
  });

  expect(state.eventSearchQueries).toEqual([
    { query: 'auth token rotation #ZX-41' },
    { query: 'auth token rotation' },
    { query: 'ZX-41' },
  ]);
  expect(output.modelMessages.map((message) => message.content)).toEqual([
    'DATE: 1 Jan 2026 | ID: D1:7 | Alice: auth token rotation #ZX-41 happens tonight.',
  ]);
  expect(output.summaryReferences).toEqual([]);
  expect(output.retrievalAddedCount).toBe(1);
  expect(output.budgetUsed.value).toBe(18);
});
```

- [ ] **Step 2: Run the focused core test and verify it fails for the right reason**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "adds raw retrieval messages when summary retrieval has no match"`

Expected: FAIL because `output.modelMessages` is still empty and `state.eventSearchQueries` is still `[]`.

- [ ] **Step 3: Write the minimal application code to search raw events when summary retrieval finds nothing**

```ts
const eventCandidateMap = new Map<string, {
  readonly event: LedgerEvent;
  stageHits: number;
  overlapCount: number;
  maxStageMatchCount: number;
}>();

for (const stageQuery of stageQueries) {
  const matchedEvents = await this.deps.ledgerRead.searchEvents(
    input.conversationId,
    stageQuery.query,
    hint.scope,
  );

  for (const event of matchedEvents) {
    const key = String(event.id);
    const overlapCount = toQueryOverlapCount(stageQuery.query, event.content);
    const existing = eventCandidateMap.get(key);

    if (existing === undefined) {
      eventCandidateMap.set(key, {
        event,
        stageHits: 1,
        overlapCount,
        maxStageMatchCount: matchedEvents.length,
      });
      continue;
    }

    existing.stageHits += 1;
    if (overlapCount > existing.overlapCount) {
      existing.overlapCount = overlapCount;
    }
    if (matchedEvents.length > existing.maxStageMatchCount) {
      existing.maxStageMatchCount = matchedEvents.length;
    }
  }
}

if (candidateMap.size === 0) {
  const rankedEvents = [...eventCandidateMap.values()]
    .map((entry) => ({
      ...entry,
      score: entry.stageHits * 100 + entry.overlapCount * 10 + entry.maxStageMatchCount,
    }))
    .sort((left, right) => right.score - left.score);

  for (const candidate of rankedEvents) {
    if (addedForHint >= limit) {
      break;
    }

    const tokenCount = candidate.event.tokenCount.value;
    if (budgetUsedValue + tokenCount > availableBudget) {
      continue;
    }

    modelMessages.push({
      role: candidate.event.role,
      content: candidate.event.content,
    });
    budgetUsedValue += tokenCount;
    addedForHint += 1;
    retrievalAddedCount += 1;
  }
}
```

- [ ] **Step 4: Run the same focused core test and verify it passes**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "adds raw retrieval messages when summary retrieval has no match"`

Expected: PASS

- [ ] **Step 5: Commit the first raw-event retrieval slice**

```bash
git add packages/application/src/use-cases/__tests__/materialize-context.test.ts packages/application/src/use-cases/materialize-context.ts
git commit -m "feat: add raw event fallback for materialize retrieval hints"
```

### Task 2: Rank Raw Events And Summaries In One Shared Hint Pass

**Files:**
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Modify: `packages/application/src/use-cases/materialize-context.ts`
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`

- [ ] **Step 1: Write the failing priority test that forces raw evidence to beat a generic summary**

```ts
it('prefers exact raw retrieval messages over generic summaries when hint limit is one', async () => {
  const exactEvent = createTestMessage({
    id: createEventId('evt_retrieval_exact_first'),
    content: 'DATE: 1 Jan 2026 | ID: D1:8 | Alice: auth token rotation #ZX-41 happens tonight.',
    tokenCount: 18,
    role: 'assistant',
    sequence: 8,
  });
  const genericSummary = createTestSummary({
    id: createSummaryNodeId('sum_retrieval_generic'),
    content: '[Summary] Alice discussed auth token rotation details.',
    tokenCount: 10,
  });

  const state = createState({
    summaries: [genericSummary],
    events: [exactEvent],
    summarySearchResults: {
      'auth token rotation #ZX-41': [genericSummary],
      'auth token rotation': [genericSummary],
      'ZX-41': [genericSummary],
    },
    eventSearchResults: {
      'auth token rotation #ZX-41': [exactEvent],
      'auth token rotation': [exactEvent],
      'ZX-41': [exactEvent],
    },
    contextTokenCount: 0,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 48,
    overheadTokens: 0,
    retrievalHints: [{ query: 'auth token rotation #ZX-41', limit: 1 }],
  });

  expect(output.modelMessages.map((message) => message.content)).toEqual([
    'DATE: 1 Jan 2026 | ID: D1:8 | Alice: auth token rotation #ZX-41 happens tonight.',
  ]);
  expect(output.summaryReferences).toEqual([]);
  expect(output.retrievalAddedCount).toBe(1);
});
```

- [ ] **Step 2: Run the focused core priority test and confirm it fails**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "prefers exact raw retrieval messages over generic summaries when hint limit is one"`

Expected: FAIL because the summary path still claims the single hint slot first.

- [ ] **Step 3: Replace the split retrieval logic with one shared candidate-ranking pass**

```ts
type RankedRetrievalCandidate =
  | {
      readonly kind: 'message';
      readonly id: LedgerEvent['id'];
      readonly tokenCount: number;
      readonly score: number;
      readonly stageHits: number;
      readonly overlapCount: number;
      readonly rankTieBreaker: number;
      readonly modelMessage: ModelMessage;
    }
  | {
      readonly kind: 'summary';
      readonly id: SummaryReference['id'];
      readonly tokenCount: number;
      readonly score: number;
      readonly stageHits: number;
      readonly overlapCount: number;
      readonly rankTieBreaker: number;
      readonly summary: SummaryReference & {
        readonly content: string;
        readonly artifactIds: readonly ArtifactId[];
        readonly createdAt: Date;
      };
    };

const rankedCandidates: readonly RankedRetrievalCandidate[] = [
  ...[...eventCandidateMap.values()].map((entry) => ({
    kind: 'message' as const,
    id: entry.event.id,
    tokenCount: entry.event.tokenCount.value,
    score: entry.stageHits * 100 + entry.overlapCount * 10 + entry.maxStageMatchCount,
    stageHits: entry.stageHits,
    overlapCount: entry.overlapCount,
    rankTieBreaker: entry.event.sequence,
    modelMessage: {
      role: entry.event.role,
      content: entry.event.content,
    },
  })),
  ...[...candidateMap.values()].map((entry) => ({
    kind: 'summary' as const,
    id: entry.summary.id,
    tokenCount: entry.summary.tokenCount.value,
    score: entry.stageHits * 100 + entry.overlapCount * 10 + entry.maxStageMatchCount,
    stageHits: entry.stageHits,
    overlapCount: entry.overlapCount,
    rankTieBreaker: entry.summary.createdAt.getTime(),
    summary: entry.summary,
  })),
].sort((left, right) => {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (left.kind !== right.kind) {
    return left.kind === 'message' ? -1 : 1;
  }
  if (right.rankTieBreaker !== left.rankTieBreaker) {
    return right.rankTieBreaker - left.rankTieBreaker;
  }
  return String(left.id).localeCompare(String(right.id));
});

const selectedMessageContents = new Set(modelMessages.map((message) => message.content));

for (const candidate of rankedCandidates) {
  if (addedForHint >= limit) {
    break;
  }

  if (budgetUsedValue + candidate.tokenCount > availableBudget) {
    continue;
  }

  if (candidate.kind === 'message') {
    if (selectedMessageContents.has(candidate.modelMessage.content)) {
      continue;
    }

    modelMessages.push(candidate.modelMessage);
    selectedMessageContents.add(candidate.modelMessage.content);
    budgetUsedValue += candidate.tokenCount;
    addedForHint += 1;
    retrievalAddedCount += 1;
    continue;
  }

  const alreadyInContext = summaryReferences.some((reference) => reference.id === candidate.summary.id);
  if (alreadyInContext) {
    continue;
  }

  modelMessages.push({
    role: 'assistant',
    content: `[Summary ID: ${candidate.summary.id}]\n${candidate.summary.content}`,
  });
  summaryReferences.push({
    id: candidate.summary.id,
    kind: candidate.summary.kind,
    tokenCount: candidate.summary.tokenCount,
  });
  summaryArtifactIdsById.set(String(candidate.summary.id), candidate.summary.artifactIds);
  budgetUsedValue += candidate.tokenCount;
  addedForHint += 1;
  retrievalAddedCount += 1;
}
```

- [ ] **Step 4: Run the focused raw-priority test and verify it passes**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "prefers exact raw retrieval messages over generic summaries when hint limit is one"`

Expected: PASS

- [ ] **Step 5: Commit the shared raw-event/summary ranking change**

```bash
git add packages/application/src/use-cases/__tests__/materialize-context.test.ts packages/application/src/use-cases/materialize-context.ts
git commit -m "feat: rank raw events ahead of summaries for retrieval hints"
```

### Task 3: Expose Raw-Retrieval Diagnostics Through The Core Contract And Benchmark Adapter

**Files:**
- Modify: `packages/application/src/ports/driving/memory-engine.port.ts`
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Modify: `packages/application/src/use-cases/materialize-context.ts`
- Modify: `benchmarks/locomo/src/types.ts`
- Modify: `benchmarks/locomo/src/baselines.ts`
- Modify: `benchmarks/locomo/src/baselines.test.ts`
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Test: `benchmarks/locomo/src/baselines.test.ts`

- [ ] **Step 1: Write the failing core and benchmark diagnostics tests**

```ts
it('reports raw retrieval diagnostics separately from summary diagnostics', async () => {
  const exactEvent = createTestMessage({
    id: createEventId('evt_retrieval_diag_message'),
    content: 'DATE: 1 Jan 2026 | ID: D1:9 | Alice: auth token rotation #ZX-41 happens tonight.',
    tokenCount: 18,
    role: 'assistant',
    sequence: 9,
  });

  const state = createState({
    events: [exactEvent],
    eventSearchResults: {
      'auth token rotation #ZX-41': [exactEvent],
      'auth token rotation': [exactEvent],
      'ZX-41': [exactEvent],
    },
    contextTokenCount: 0,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 48,
    overheadTokens: 0,
    retrievalHints: [{ query: 'auth token rotation #ZX-41', limit: 1 }],
  });

  expect(output.retrievalAddedCount).toBe(1);
  expect(output.retrievalAddedMessageCount).toBe(1);
  expect(output.retrievalAddedSummaryCount).toBe(0);
  expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([exactEvent.id]);
  expect(output.retrievalDiagnostics?.[0]?.messageDecisions?.[0]).toMatchObject({
    messageId: exactEvent.id,
    stageHits: 3,
    tokenCount: 18,
    selected: true,
    reason: 'selected',
  });
});
```

```ts
it('copies raw retrieval counts and selected message ids into benchmark diagnostics', async () => {
  const turns = Array.from({ length: 12 }, (_, index) => {
    const diaId = `D1:${index + 1}`;
    const filler = `filler-${index + 1} `.repeat(18).trim();
    const text =
      diaId === 'D1:3'
        ? `Alice said auth token rotation #ZX-41 happens tonight. ${filler}`
        : `Turn ${index + 1} discussed unrelated planning details. ${filler}`;

    return {
      speaker: index % 2 === 0 ? 'Alice' : 'Bob',
      dia_id: diaId,
      text,
    };
  });

  const sample: LocomoConversationSample = {
    sample_id: 'sample-static-raw-evidence',
    conversation: {
      session_1_date_time: '1:00 pm on 1 Jan, 2026',
      session_1: turns,
    },
    qa: [
      {
        question: 'auth token rotation #ZX-41',
        answer: 'ZX-41',
        evidence: ['D1:3'],
        category: 3,
      },
    ],
  };

  const example: LocomoExample = {
    sampleId: sample.sample_id,
    qaIndex: 0,
    category: 3,
    question: 'auth token rotation #ZX-41',
    answer: 'ZX-41',
    evidence: ['D1:3'],
  };

  const fairness = {
    ...makeConfig('heuristic').fairness,
    tokenBudget: 220,
    overheadTokens: 16,
  };

  const execution = await createBaselineStrategies({
    ...makeConfig('heuristic'),
    baselines: ['ledgermind_static_materialize'],
    fairness,
  }).ledgermind_static_materialize.run({
    sample,
    example,
    fairness,
    seed: 0,
  });

  expect(execution.contextResult.context).toContain('ID: D1:3');
  expect(execution.diagnostics?.retrievalAddedMessageCount ?? 0).toBeGreaterThan(0);
  expect(execution.diagnostics?.retrievalHints?.[0]?.selectedMessageIds).toContain('D1:3');
});
```

- [ ] **Step 2: Run the targeted diagnostics tests and confirm they fail**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "reports raw retrieval diagnostics separately from summary diagnostics" benchmarks/locomo/src/baselines.test.ts -t "copies raw retrieval counts and selected message ids into benchmark diagnostics"`

Expected: FAIL because the public contract and benchmark diagnostics do not yet expose raw message counts or selected raw message IDs.

- [ ] **Step 3: Add the smallest contract and translation changes needed to report raw retrieval**

```ts
export interface RetrievalMessageDecisionDiagnostics {
  readonly messageId: EventId;
  readonly score: number;
  readonly stageHits: number;
  readonly overlapCount: number;
  readonly tokenCount: number;
  readonly selected: boolean;
  readonly reason: RetrievalCandidateDecisionReason;
}

export interface RetrievalHintDiagnostics {
  readonly hintQuery: string;
  readonly scopeSummaryId?: SummaryNodeId;
  readonly limit: number;
  readonly stageQueries: readonly RetrievalStageQueryDiagnostics[];
  readonly candidateDecisions: readonly RetrievalCandidateDecisionDiagnostics[];
  readonly selectedSummaryIds: readonly SummaryNodeId[];
  readonly messageDecisions?: readonly RetrievalMessageDecisionDiagnostics[];
  readonly selectedMessageIds?: readonly EventId[];
}

export interface MaterializeContextOutput {
  readonly systemPreamble: string;
  readonly modelMessages: readonly ModelMessage[];
  readonly summaryReferences: readonly SummaryReference[];
  readonly artifactReferences: readonly ArtifactReference[];
  readonly budgetUsed: TokenCount;
  readonly retrievalMatchCount?: number;
  readonly retrievalAddedCount?: number;
  readonly retrievalAddedMessageCount?: number;
  readonly retrievalAddedSummaryCount?: number;
  readonly retrievalDiagnostics?: readonly RetrievalHintDiagnostics[];
  readonly compactionTriggered?: boolean;
  readonly trimmedToFit?: boolean;
  readonly droppedMessageCount?: number;
  readonly droppedSummaryCount?: number;
}
```

```ts
let retrievalAddedMessageCount = 0;
let retrievalAddedSummaryCount = 0;

const messageDecisions: RetrievalMessageDecisionDiagnostics[] = [];
const selectedMessageIds: LedgerEvent['id'][] = [];

if (candidate.kind === 'message') {
  if (selectedMessageContents.has(candidate.modelMessage.content)) {
    messageDecisions.push({
      messageId: candidate.id,
      score: candidate.score,
      stageHits: candidate.stageHits,
      overlapCount: candidate.overlapCount,
      tokenCount: candidate.tokenCount,
      selected: false,
      reason: 'already_in_context',
    });
    continue;
  }

  modelMessages.push(candidate.modelMessage);
  selectedMessageContents.add(candidate.modelMessage.content);
  budgetUsedValue += candidate.tokenCount;
  addedForHint += 1;
  retrievalAddedCount += 1;
  retrievalAddedMessageCount += 1;
  selectedMessageIds.push(candidate.id);
  messageDecisions.push({
    messageId: candidate.id,
    score: candidate.score,
    stageHits: candidate.stageHits,
    overlapCount: candidate.overlapCount,
    tokenCount: candidate.tokenCount,
    selected: true,
    reason: 'selected',
  });
  continue;
}

retrievalAddedSummaryCount += 1;

retrievalDiagnostics.push({
  hintQuery: retrievalQuery,
  ...(hint.scope === undefined ? {} : { scopeSummaryId: hint.scope }),
  limit,
  stageQueries: stageQueryDiagnostics,
  candidateDecisions,
  selectedSummaryIds,
  ...(messageDecisions.length === 0 ? {} : { messageDecisions }),
  ...(selectedMessageIds.length === 0 ? {} : { selectedMessageIds }),
});
```

```ts
export interface LedgermindRetrievalMessageDecisionTrace {
  readonly messageId: string;
  readonly score: number;
  readonly stageHits: number;
  readonly overlapCount: number;
  readonly tokenCount: number;
  readonly selected: boolean;
  readonly reason: 'selected' | 'already_in_context' | 'over_budget' | 'limit_reached';
}

export interface LedgermindRetrievalHintTrace {
  readonly hintQuery: string;
  readonly scopeSummaryId?: string;
  readonly limit: number;
  readonly stageQueries: readonly LedgermindRetrievalStageTrace[];
  readonly candidateDecisions: readonly LedgermindRetrievalCandidateDecisionTrace[];
  readonly selectedSummaryIds: readonly string[];
  readonly messageDecisions?: readonly LedgermindRetrievalMessageDecisionTrace[];
  readonly selectedMessageIds?: readonly string[];
}

export interface LedgermindDiagnostics {
  readonly contextSource: 'materialized' | 'fallback_truncation';
  readonly materializationAttempted: boolean;
  readonly materializationErrorCode?: string;
  readonly materializationErrorStage?: 'with_hints' | 'without_hints';
  readonly variant?: LedgermindVariant;
  readonly preCompactionEnabled?: boolean;
  readonly rawTurnInjectionEnabled?: boolean;
  readonly rawTurnInjectionCandidateCount?: number;
  readonly rawTurnInjectionAddedCount?: number;
  readonly rawTurnInjectionBudgetTokens?: number;
  readonly availableBudgetTokens?: number;
  readonly reservedForToolLoopTokens?: number;
  readonly reservedForRetrievalTokens?: number;
  readonly budgetUsedTokens?: number;
  readonly summaryReferenceCount?: number;
  readonly summaryReferenceIds?: readonly string[];
  readonly artifactReferenceCount?: number;
  readonly artifactReferenceIds?: readonly string[];
  readonly artifactBearingExample?: boolean;
  readonly modelMessageCount?: number;
  readonly retrievalHintCount?: number;
  readonly retrievalMatchCount?: number;
  readonly retrievalAddedCount?: number;
  readonly retrievalAddedMessageCount?: number;
  readonly retrievalAddedSummaryCount?: number;
  readonly retrievalHints?: readonly LedgermindRetrievalHintTrace[];
  readonly compactionTriggered?: boolean;
  readonly trimmedToFit?: boolean;
  readonly droppedMessageCount?: number;
  readonly droppedSummaryCount?: number;
  readonly toolLoop?: LedgermindToolLoopDiagnostics;
  readonly summarizationTrace?: readonly LedgermindSummarizationTraceEntry[];
}
```

```ts
...(input.materialized.retrievalAddedMessageCount === undefined
  ? {}
  : { retrievalAddedMessageCount: input.materialized.retrievalAddedMessageCount }),
...(input.materialized.retrievalAddedSummaryCount === undefined
  ? {}
  : { retrievalAddedSummaryCount: input.materialized.retrievalAddedSummaryCount }),
...
messageDecisions:
  hint.messageDecisions?.map((candidate) => ({
    messageId: String(candidate.messageId),
    score: candidate.score,
    stageHits: candidate.stageHits,
    overlapCount: candidate.overlapCount,
    tokenCount: candidate.tokenCount,
    selected: candidate.selected,
    reason: candidate.reason,
  })) ?? [],
selectedMessageIds: hint.selectedMessageIds?.map((messageId) => String(messageId)) ?? [],
```

- [ ] **Step 4: Run the targeted diagnostics tests and verify they pass**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "reports raw retrieval diagnostics separately from summary diagnostics" benchmarks/locomo/src/baselines.test.ts -t "copies raw retrieval counts and selected message ids into benchmark diagnostics"`

Expected: PASS

- [ ] **Step 5: Commit the diagnostics contract and benchmark adapter changes**

```bash
git add packages/application/src/ports/driving/memory-engine.port.ts packages/application/src/use-cases/__tests__/materialize-context.test.ts packages/application/src/use-cases/materialize-context.ts benchmarks/locomo/src/types.ts benchmarks/locomo/src/baselines.ts benchmarks/locomo/src/baselines.test.ts
git commit -m "feat: expose raw retrieval diagnostics for materialized context"
```

### Task 4: Prove The Change With Focused Tests And The Existing LoCoMo Canary

**Files:**
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Test: `benchmarks/locomo/src/baselines.test.ts`
- Test: `tests/quality/__tests__/locomo-smoke.test.ts`

- [ ] **Step 1: Run the full focused regression suite for the touched areas**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts benchmarks/locomo/src/baselines.test.ts tests/quality/__tests__/locomo-smoke.test.ts`

Expected: PASS with no new warnings or snapshot churn.

- [ ] **Step 2: Run the canary comparison that previously showed the strongest raw-evidence signal**

Run:

```bash
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode llm --model gpt-5.4-mini --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --llm-timeout-ms 120000 --baselines ledgermind_static_materialize,ledgermind_static_materialize_raw_turn_injection,rag --include-ledgermind-diagnostics --seeds 0
```

Expected: benchmark completes and writes a new run folder under `benchmarks/locomo/runs/`.

- [ ] **Step 3: Compare the new default static baseline against the pre-change canary**

Run:

```bash
LATEST_RUN=$(ls -td benchmarks/locomo/runs/locomo-* | head -n 1)
sed -n '1,120p' "$LATEST_RUN/summary.md"
```

Expected:
- `ledgermind_static_materialize` official score is higher than the pre-change canary score `0.179` from `benchmarks/locomo/runs/locomo-2026-04-20T08-54-07-562Z/summary.md`
- `ledgermind_static_materialize` evidence recall is higher than the pre-change canary recall `0.058`
- the gap between `ledgermind_static_materialize` and `ledgermind_static_materialize_raw_turn_injection` is smaller than before

- [ ] **Step 4: If the canary does not improve, inspect the trace before touching benchmark-only helpers**

Run:

```bash
LATEST_RUN=$(ls -td benchmarks/locomo/runs/locomo-* | head -n 1)
jq -r 'select(.baseline=="ledgermind_static_materialize") | [.exampleId, .failureClassification.category, .diagnostics.retrievalAddedMessageCount, .diagnostics.retrievalAddedSummaryCount] | @tsv' "$LATEST_RUN/trace_per_example.jsonl" | head -n 20
```

Expected: non-zero `retrievalAddedMessageCount` rows appear in the default static baseline trace. If they do not, stop and debug the core selection logic before adjusting any benchmark-only path.

- [ ] **Step 5: Commit after the suite and canary both prove the default baseline improved**

```bash
git add packages/application/src/ports/driving/memory-engine.port.ts packages/application/src/use-cases/__tests__/materialize-context.test.ts packages/application/src/use-cases/materialize-context.ts benchmarks/locomo/src/types.ts benchmarks/locomo/src/baselines.ts benchmarks/locomo/src/baselines.test.ts
git commit -m "feat: retrieve raw event evidence during materialization"
```

## Self-Review

- Spec coverage: the plan covers the core retrieval change, the public diagnostics contract, the benchmark diagnostics bridge, and the canary verification that motivated the work.
- Placeholder scan: no `TODO`, `TBD`, or “similar to Task N” shortcuts remain.
- Type consistency: the plan uses `retrievalAddedMessageCount`, `retrievalAddedSummaryCount`, `messageDecisions`, and `selectedMessageIds` consistently across the application port, use case, and benchmark adapter.
