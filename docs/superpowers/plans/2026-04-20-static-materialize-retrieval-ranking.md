# Static Materialize Retrieval Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ledgermind_static_materialize` stop losing easy LoCoMo evidence to `rag` by ranking hinted raw-event candidates more specifically and by giving retrieved evidence higher retention priority than stale base context.

**Architecture:** Keep the fix inside `MaterializeContextUseCase`. First, replace the current coarse `stageHits + overlapCount + recency` ranking with a specificity-aware scorer that rewards exact phrase and anchor coverage while penalizing broad stage matches. Second, when a raw event is selected for a retrieval hint, pack a tiny evidence window around that seed and let those retrieved messages evict low-value base messages during final budget trimming instead of forcing the retrieval path to live inside a tiny leftover reserve.

**Tech Stack:** TypeScript, Vitest, Node.js 22+, pnpm workspaces, existing Clean Architecture ports in `packages/application`, existing LoCoMo canary harness in `benchmarks/locomo`

---

## File Map

- Modify: `packages/application/src/use-cases/materialize-context.ts`
  Responsibility: rank raw-event retrieval candidates by specificity, collect small retrieval windows, and perform final budget trimming with retrieval-aware keep priorities.
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
  Responsibility: reproduce the current failures in a deterministic unit test harness and lock in the new ranking and packing behavior.
- Verification only: `benchmarks/locomo/runs/`
  Responsibility: confirm the fix helps the real `ledgermind_static_materialize` LoCoMo canary without relying on benchmark-only raw-turn injection.

## Scope Guardrails

- Do not copy `raw-turn injection` helper logic from `benchmarks/locomo/src/baselines.ts` into the application layer.
- Do not change `searchEvents()` again unless a new failing test proves the matcher is still missing obvious candidates. The current problem is ranking and packing, not raw match reachability.
- Do not add embeddings, external search libraries, or benchmark-only shortcuts.
- Keep the public `MaterializeContextOutput` shape stable unless a failing test proves the current diagnostics cannot represent the new behavior.

### Task 1: Make Retrieval Ranking Prefer Exact Evidence Over Generic Recent Chatter

**Files:**
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Modify: `packages/application/src/use-cases/materialize-context.ts`
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`

- [ ] **Step 1: Write the failing ranking regression in `packages/application/src/use-cases/__tests__/materialize-context.test.ts`**

```ts
it('prefers exact older evidence over newer generic matches when overlap ties', async () => {
  const exactOlderEvent = createTestMessage({
    id: createEventId('evt_support_group_exact_older'),
    content:
      'DATE: 1:56 pm on 8 May, 2023 | ID: D1:3 | Caroline: I went to a LGBTQ support group yesterday and it was so powerful.',
    tokenCount: 24,
    role: 'user',
    sequence: 3,
  });
  const genericRecentEvent = createTestMessage({
    id: createEventId('evt_support_group_recent_generic'),
    content:
      'DATE: 12:09 am on 13 September, 2023 | ID: D16:5 | Caroline: The LGBTQ support group inspired my artwork and reminded me to keep going.',
    tokenCount: 24,
    role: 'user',
    sequence: 65,
  });
  const genericRecentEvent2 = createTestMessage({
    id: createEventId('evt_support_group_recent_generic_2'),
    content:
      'DATE: 3:19 pm on 28 August, 2023 | ID: D15:3 | Caroline: The LGBTQ support group made me want to show more support in my community.',
    tokenCount: 24,
    role: 'user',
    sequence: 54,
  });

  const state = createState({
    events: [exactOlderEvent, genericRecentEvent, genericRecentEvent2],
    eventSearchResults: {
      'When did Caroline go to the LGBTQ support group?': [
        exactOlderEvent,
        genericRecentEvent,
        genericRecentEvent2,
      ],
      'when did caroline the lgbtq support group': [
        exactOlderEvent,
        genericRecentEvent,
        genericRecentEvent2,
      ],
      'When Caroline LGBTQ': [
        exactOlderEvent,
        genericRecentEvent,
        genericRecentEvent2,
      ],
    },
    contextTokenCount: 0,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 64,
    overheadTokens: 0,
    retrievalHints: [{ query: 'When did Caroline go to the LGBTQ support group?', limit: 1 }],
  });

  expect(output.modelMessages.map((message) => message.content)).toEqual([exactOlderEvent.content]);
  expect(output.retrievalAddedCount).toBe(1);
  expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([exactOlderEvent.id]);
  expect(output.retrievalDiagnostics?.[0]?.messageDecisions[0]).toEqual(
    expect.objectContaining({
      messageId: exactOlderEvent.id,
      selected: true,
      reason: 'selected',
    }),
  );
});
```

- [ ] **Step 2: Run the focused regression and verify it fails before the implementation**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "prefers exact older evidence over newer generic matches when overlap ties"`

Expected: FAIL because the current implementation ranks the newer generic event first when `stageHits` and `overlapCount` are tied.

- [ ] **Step 3: Replace the current coarse retrieval scorer in `packages/application/src/use-cases/materialize-context.ts`**

```ts
const RETRIEVAL_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
]);

const toRankTokens = (value: string): readonly string[] => {
  return value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !RETRIEVAL_STOP_WORDS.has(token));
};

const toQueryOverlapCount = (
  query: string,
  content: string,
  tokenize: (value: string) => readonly string[] = toSearchTokens,
): number => {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const contentTokens = new Set(tokenize(content));
  let overlapCount = 0;

  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlapCount += 1;
    }
  }

  return overlapCount;
};

type RetrievalScoreSignals = {
  readonly primaryOverlapCount: number;
  readonly keywordOverlapCount: number;
  readonly anchorOverlapCount: number;
  readonly exactPrimaryPhraseMatch: boolean;
  readonly minStageMatchCount: number;
};

const toRetrievalScore = (signals: RetrievalScoreSignals): number => {
  return (
    signals.anchorOverlapCount * 1000 +
    signals.primaryOverlapCount * 100 +
    signals.keywordOverlapCount * 25 +
    (signals.exactPrimaryPhraseMatch ? 40 : 0) -
    signals.minStageMatchCount
  );
};
```

Replace the event ranking block with this shape:

```ts
const rankedEventCandidates = Array.from(eventCandidateMap.values()).map((entry) => {
  const primaryQuery = stageQueries.find((stageQuery) => stageQuery.stage === 'primary')?.query ?? '';
  const keywordQuery = stageQueries.find((stageQuery) => stageQuery.stage === 'keywords')?.query ?? '';
  const anchorQuery = stageQueries.find((stageQuery) => stageQuery.stage === 'anchors')?.query ?? '';
  const signals = {
    primaryOverlapCount: toQueryOverlapCount(primaryQuery, entry.event.content, toRankTokens),
    keywordOverlapCount: toQueryOverlapCount(keywordQuery, entry.event.content, toRankTokens),
    anchorOverlapCount: toQueryOverlapCount(anchorQuery, entry.event.content),
    exactPrimaryPhraseMatch:
      primaryQuery.trim().length > 0 &&
      entry.event.content.toLocaleLowerCase().includes(primaryQuery.trim().toLocaleLowerCase()),
    minStageMatchCount: Math.min(...stageQueryDiagnostics.map((stageQuery) => stageQuery.matchCount)),
  } satisfies RetrievalScoreSignals;

  return {
    kind: 'message' as const,
    id: entry.event.id,
    tokenCount: entry.event.tokenCount.value,
    score: toRetrievalScore(signals),
    stageHits: entry.stageHits,
    overlapCount: signals.primaryOverlapCount,
    rankTieBreaker: entry.event.sequence,
    modelMessage: {
      role: entry.event.role,
      content: entry.event.content,
    },
  };
});
```

Keep summary ranking behavior stable for now, but change the common tie-breaker to favor the lower `rankTieBreaker` value so older raw evidence wins only after specificity and selectivity already tie:

```ts
if (left.rankTieBreaker !== right.rankTieBreaker) {
  return left.rankTieBreaker - right.rankTieBreaker;
}
```

- [ ] **Step 4: Run the focused regression again and verify it passes**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "prefers exact older evidence over newer generic matches when overlap ties"`

Expected: PASS

- [ ] **Step 5: Re-run the existing retrieval unit slice to make sure we did not break the earlier raw-event fix**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "retrieval"`

Expected: PASS for the existing retrieval-focused tests plus the new ranking regression.

- [ ] **Step 6: Commit the ranking change**

```bash
git add packages/application/src/use-cases/materialize-context.ts packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "fix: rank hinted raw evidence by specificity"
```

### Task 2: Keep Retrieved Evidence Windows Even When Base Context Is Already Full

**Files:**
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Modify: `packages/application/src/use-cases/materialize-context.ts`
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`

- [ ] **Step 1: Write the failing packing regression in `packages/application/src/use-cases/__tests__/materialize-context.test.ts`**

```ts
it('keeps a retrieved evidence window by dropping stale base messages under budget pressure', async () => {
  const staleBase1 = createTestMessage({
    id: createEventId('evt_base_stale_1'),
    content: 'recent-base-message-1',
    tokenCount: 20,
    sequence: 40,
  });
  const staleBase2 = createTestMessage({
    id: createEventId('evt_base_stale_2'),
    content: 'recent-base-message-2',
    tokenCount: 20,
    sequence: 41,
  });
  const staleBase3 = createTestMessage({
    id: createEventId('evt_base_stale_3'),
    content: 'recent-base-message-3',
    tokenCount: 20,
    sequence: 42,
  });
  const staleBase4 = createTestMessage({
    id: createEventId('evt_base_stale_4'),
    content: 'recent-base-message-4',
    tokenCount: 20,
    sequence: 43,
  });
  const promptTurn = createTestMessage({
    id: createEventId('evt_focus_prompt_turn'),
    content:
      'DATE: 8:14 am on 9 January, 2023 | ID: D1:7 | Maria: Woohoo, John! That is awesome. Any specific areas you want to tackle?',
    tokenCount: 18,
    role: 'assistant',
    sequence: 7,
  });
  const answerTurn = createTestMessage({
    id: createEventId('evt_focus_answer_turn'),
    content:
      'DATE: 8:14 am on 9 January, 2023 | ID: D1:8 | John: I am passionate about improving education and infrastructure in our community. Those are my main focuses.',
    tokenCount: 20,
    role: 'user',
    sequence: 8,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(staleBase1.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(staleBase2.id) }),
      createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(staleBase3.id) }),
      createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(staleBase4.id) }),
    ],
    events: [promptTurn, answerTurn, staleBase1, staleBase2, staleBase3, staleBase4],
    eventSearchResults: {
      "What is John's main focus in local politics?": [promptTurn],
      'what john main focus local politics': [promptTurn],
      'What John': [promptTurn],
    },
    contextTokenCount: 80,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 100,
    overheadTokens: 0,
    retrievalHints: [{ query: "What is John's main focus in local politics?", limit: 1 }],
  });

  expect(output.modelMessages.map((message) => message.content)).toEqual([
    'recent-base-message-2',
    'recent-base-message-3',
    'recent-base-message-4',
    promptTurn.content,
    answerTurn.content,
  ]);
  expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([promptTurn.id, answerTurn.id]);
  expect(output.budgetUsed.value).toBe(98);
  expect(output.trimmedToFit).toBe(true);
  expect(output.droppedMessageCount).toBe(1);
});
```

- [ ] **Step 2: Run the focused packing regression and verify it fails before the implementation**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "keeps a retrieved evidence window by dropping stale base messages under budget pressure"`

Expected: FAIL because the current implementation only adds the seed retrieval message, never adds the adjacent answer turn, and never lets retrieved evidence displace stale base messages.

- [ ] **Step 3: Implement retrieval windows and retrieval-aware final trimming in `packages/application/src/use-cases/materialize-context.ts`**

Add a tiny helper near the other local helpers:

```ts
const buildRetrievedEventWindow = (input: {
  readonly seed: LedgerEvent;
  readonly eventsBySequence: ReadonlyMap<number, LedgerEvent>;
}): readonly LedgerEvent[] => {
  const previous = input.eventsBySequence.get(input.seed.sequence - 1);
  const next = input.eventsBySequence.get(input.seed.sequence + 1);

  return [previous, input.seed, next].filter((event): event is LedgerEvent => event !== undefined);
};
```

After `eventsById` is created, also build:

```ts
const eventsBySequence = new Map(allEvents.map((event) => [event.sequence, event] as const));
```

Replace the current direct `modelMessages.push()` retrieval path for raw messages with a provisional bundle collection:

```ts
const retrievedEventBundles: Array<{
  readonly seedId: LedgerEvent['id'];
  readonly events: readonly LedgerEvent[];
}> = [];

if (candidate.kind === 'message') {
  const eventId = String(candidate.id);

  if (selectedRawEventIds.has(eventId)) {
    // keep the existing already_in_context diagnostic
    continue;
  }
  if (addedForHint >= limit) {
    // keep the existing limit_reached diagnostic
    continue;
  }

  const seedEvent = eventsById.get(candidate.id);
  if (seedEvent === undefined) {
    throw new InvariantViolationError(`Retrieval selected unknown event: ${candidate.id}`);
  }

  const bundle = buildRetrievedEventWindow({
    seed: seedEvent,
    eventsBySequence,
  }).filter((event) => !selectedRawEventIds.has(String(event.id)));

  if (bundle.length === 0) {
    continue;
  }

  retrievedEventBundles.push({
    seedId: candidate.id,
    events: bundle,
  });
  selectedMessageIds.push(...bundle.map((event) => event.id));
  for (const event of bundle) {
    selectedRawEventIds.add(String(event.id));
  }
  addedForHint += 1;

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
```

Then replace the current `if (budgetUsedValue > availableBudget)` final trim with a unified keep-priority pass that can evict base messages in favor of retrieval windows:

```ts
type FinalizedMessage = {
  readonly keepPriority: number;
  readonly order: number;
  readonly tokenCount: number;
  readonly modelMessage: ModelMessage;
  readonly summaryReference?: SummaryReference;
  readonly retrievedMessageId?: LedgerEvent['id'];
};

let order = 0;
const finalizedMessages: FinalizedMessage[] = [
  ...trimmedBase.selectedItems.map((item) => ({
    keepPriority: item.kind === 'message' ? 2 : 3,
    order: order++,
    tokenCount: item.tokenCount,
    modelMessage: item.modelMessage,
    ...(item.kind === 'summary' ? { summaryReference: item.summaryReference } : {}),
  })),
  ...retrievedEventBundles.flatMap((bundle) =>
    bundle.events.map((event) => ({
      keepPriority: event.id === bundle.seedId ? 0 : 1,
      order: order++,
      tokenCount: event.tokenCount.value,
      modelMessage: {
        role: event.role,
        content: event.content,
      },
      retrievedMessageId: event.id,
    })),
  ),
];

const keptByPriority: FinalizedMessage[] = [];
let used = 0;

for (const item of [...finalizedMessages].sort((left, right) => {
  if (left.keepPriority !== right.keepPriority) {
    return left.keepPriority - right.keepPriority;
  }
  return left.order - right.order;
})) {
  if (used + item.tokenCount > availableBudget) {
    continue;
  }

  keptByPriority.push(item);
  used += item.tokenCount;
}

const kept = [...keptByPriority].sort((left, right) => left.order - right.order);
modelMessages.splice(0, modelMessages.length, ...kept.map((item) => item.modelMessage));
budgetUsedValue = used;
finalSelectedMessageIdStrings = new Set(
  kept
    .map((item) => item.retrievedMessageId)
    .filter((messageId): messageId is LedgerEvent['id'] => messageId !== undefined)
    .map((messageId) => String(messageId)),
);
```

Keep the existing filtered `retrievalDiagnostics` finalization block so `selectedMessageIds` reflects only the retrieved messages that survived the final keep-priority trim.

- [ ] **Step 4: Run the focused packing regression and verify it passes**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "keeps a retrieved evidence window by dropping stale base messages under budget pressure"`

Expected: PASS

- [ ] **Step 5: Run the full `MaterializeContextUseCase` test file to make sure the refactor did not break compaction, pinning, or summary formatting**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the packing change**

```bash
git add packages/application/src/use-cases/materialize-context.ts packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "fix: prioritize retrieved evidence windows in materialization"
```

### Task 3: Verify The Real LoCoMo Failure Cases Improved

**Files:**
- Verify: `benchmarks/locomo/runs/`

- [ ] **Step 1: Run the focused unit and benchmark safety checks**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts benchmarks/locomo/src/baselines.test.ts`

Expected: PASS

- [ ] **Step 2: Build the workspace so the live benchmark runtime picks up the new `materialize-context` implementation cleanly**

Run: `pnpm build`

Expected: PASS across the workspace with no `materialize-context.ts` type or build errors.

- [ ] **Step 3: Re-run the same LoCoMo LLM canary command used for the latest comparison**

Run: `pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode llm --model gpt-5.4-mini --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --llm-timeout-ms 120000 --baselines ledgermind_static_materialize,ledgermind_static_materialize_raw_turn_injection,rag --include-ledgermind-diagnostics --seeds 0`

Expected: command exits `0` and produces a new run directory under `benchmarks/locomo/runs/`.

- [ ] **Step 4: Inspect the new run summary and verify the static baseline moved up from the current anchor**

Run: `RUN_DIR=$(ls -1dt benchmarks/locomo/runs/locomo-* | head -n 1); sed -n '1,120p' "$RUN_DIR/summary.md"`

Expected:
- `ledgermind_static_materialize` official score is above `0.198`
- `ledgermind_static_materialize` evidence recall is above `0.071`
- the gap to `rag` is smaller than in `locomo-2026-04-20T15-21-12-291Z`

- [ ] **Step 5: Inspect the previously bad examples directly to confirm the fix helped the right failure mode**

Run: `RUN_DIR=$(ls -1dt benchmarks/locomo/runs/locomo-* | head -n 1); jq -r 'select(.baseline=="ledgermind_static_materialize" and (.exampleId=="conv-26::0" or .exampleId=="conv-26::82" or .exampleId=="conv-41::65" or .exampleId=="conv-49::5")) | [.exampleId, .officialScore, (.evidenceInContext.recall // 0), .prediction] | @tsv' "$RUN_DIR/per_example.jsonl"`

Expected:
- `conv-26::0` recall becomes `1`
- `conv-26::82` recall becomes `1`
- `conv-41::65` recall improves from `0`
- `conv-49::5` is either corrected outright or becomes the remaining top follow-up case

- [ ] **Step 6: If the canary still trails badly, capture the remaining misses before changing the design again**

Run: `RUN_DIR=$(ls -1dt benchmarks/locomo/runs/locomo-* | head -n 1); jq -r 'select(.baseline=="ledgermind_static_materialize" and .officialScore==0) | [.exampleId, .question, (.evidenceInContext.recall // 0), .prediction] | @tsv' "$RUN_DIR/per_example.jsonl" | sed -n '1,20p'`

Expected: a short residual-miss list that is much smaller than the current run and is dominated by genuinely harder inferential cases rather than obvious missed raw evidence.

## Self-Review

- Spec coverage: the plan covers the two root causes from the canary analysis: weak raw-event ranking and weak context packing after retrieval. It also includes the canary verification loop that proves we fixed the product path rather than the benchmark helper.
- Placeholder scan: removed all `TODO`-style language and replaced it with exact files, test code, implementation snippets, and concrete commands.
- Type consistency: the plan keeps `MaterializeContextOutput` stable, continues to use `selectedMessageIds`, and does not require a new diagnostics contract unless implementation proves the existing shape is insufficient.
