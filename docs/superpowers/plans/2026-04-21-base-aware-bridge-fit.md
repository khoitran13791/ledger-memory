# Base-Aware Bridge Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `MaterializeContextUseCase` keep one evidence-bearing bridge summary when the retrieval reserve is slightly too small by counting a small, capped amount of low-priority base context as fit slack during summary selection.

**Architecture:** Keep this fix entirely inside [`packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts). Do not synthesize compressed summary text and do not touch benchmark helpers. The existing final packer already ranks retrieval units ahead of base units, so once a bridge summary is provisionally selected it can already displace some base context naturally; the missing piece is a selector that understands a small amount of evictable base context instead of treating the retrieval reserve as the only legal bridge slack.

**Tech Stack:** TypeScript, Vitest, Node.js 22+, pnpm workspaces, existing Clean Architecture ports in `packages/application`

---

## Research Conclusion

- The current canary evidence says the next move should be a stronger fit strategy, not more lexical ranking.
- True summary compression is the riskier branch for this repo right now because it would require synthetic summary text plus trustworthy token accounting for text that does not already exist in storage.
- The current final packer already puts retrieval units ahead of base units, so a bridge summary that gets selected can already push out some base context without a new packing architecture.
- The actual bottleneck is the provisional bridge selector using `summarySelectionBudget` that is effectively capped by `retrievalReserve` when base trim fills `baseBudget`.
- The safest next move is a base-aware selector that can borrow a small, bounded amount of unpinned base context slack while keeping raw retrieval ranking, raw bundle packing, diagnostics shape, and benchmark runtime untouched.

## Scope Guardrails

- No public API changes.
- Do not modify [`packages/application/src/ports/driving/memory-engine.port.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/ports/driving/memory-engine.port.ts).
- Do not modify [`benchmarks/locomo/src/ledgermind-runtime.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/benchmarks/locomo/src/ledgermind-runtime.ts) or any benchmark helper in this pass.
- Do not change `searchEvents()`, raw bundle coalescing, raw bundle swap logic, retrieval reserve formula, or deterministic summary rendering.
- Keep the base-context trade small and explicit with a cap:
  - `MAX_BRIDGE_BASE_SLACK_TOKENS = 128`
  - `MAX_BRIDGE_BASE_SLACK_UNITS = 2`
- Only unpinned base items may contribute bridge-fit slack.

## File Map

- Modify: [`packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
  Responsibility: compute capped evictable-base slack, replace reserve-only bridge selection budget, and keep diagnostics stable.
- Modify: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
  Responsibility: regressions for bridge selection with evictable base slack plus safety guardrails for reserve-fit and cap behavior.

### Task 1: Add Failing Regressions For Base-Aware Bridge Fit

**Files:**
- Modify: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
- Test: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Replace the current reserve-only bridge-fit tests with base-aware regressions**

```ts
it('selects a bridge summary that fits after borrowing one base message worth of slack', async () => {
  const baseOne = createTestMessage({
    id: createEventId('evt_bridge_base_slack_1'),
    content: 'base-slack-context-1',
    tokenCount: 16,
    sequence: 101,
  });
  const baseTwo = createTestMessage({
    id: createEventId('evt_bridge_base_slack_2'),
    content: 'base-slack-context-2',
    tokenCount: 16,
    sequence: 102,
  });
  const baseThree = createTestMessage({
    id: createEventId('evt_bridge_base_slack_3'),
    content: 'base-slack-context-3',
    tokenCount: 16,
    sequence: 103,
  });

  const oversizedTopBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_base_slack_top'),
    content:
      '[Summary] Andrew talked broadly about animals, birds, and outdoor interests without naming the bird.',
    tokenCount: 72,
  });
  const fitCapableBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_base_slack_compact'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are so strong and graceful.',
    tokenCount: 40,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
    ],
    events: [baseOne, baseTwo, baseThree],
    summaries: [oversizedTopBridgeSummary, fitCapableBridgeSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [oversizedTopBridgeSummary, fitCapableBridgeSummary],
      'which specific type bird mesmerizes andrew': [oversizedTopBridgeSummary, fitCapableBridgeSummary],
      'Which Andrew': [oversizedTopBridgeSummary, fitCapableBridgeSummary],
    },
    contextTokenCount: 48,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 64,
    overheadTokens: 0,
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.summaryReferences.map((reference) => reference.id)).toEqual([fitCapableBridgeSummary.id]);
  expect(output.modelMessages.map((message) => message.content)).toEqual([
    baseThree.content,
    `[Summary ID: ${fitCapableBridgeSummary.id}]\n${fitCapableBridgeSummary.content}`,
  ]);
  expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([fitCapableBridgeSummary.id]);
  expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        summaryId: oversizedTopBridgeSummary.id,
        selected: false,
      }),
      expect.objectContaining({
        summaryId: fitCapableBridgeSummary.id,
        selected: true,
        reason: 'selected',
      }),
    ]),
  );
});

it('selects a compact bridge summary when two base messages make it fit', async () => {
  const baseOne = createTestMessage({
    id: createEventId('evt_bridge_base_two_unit_1'),
    content: 'base-two-unit-context-1',
    tokenCount: 16,
    sequence: 201,
  });
  const baseTwo = createTestMessage({
    id: createEventId('evt_bridge_base_two_unit_2'),
    content: 'base-two-unit-context-2',
    tokenCount: 16,
    sequence: 202,
  });
  const baseThree = createTestMessage({
    id: createEventId('evt_bridge_base_two_unit_3'),
    content: 'base-two-unit-context-3',
    tokenCount: 16,
    sequence: 203,
  });

  const oversizedTopBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_base_two_unit_top'),
    content:
      '[Summary] Andrew talked about birds repeatedly, but this top summary is too large to fit the allowed bridge slack.',
    tokenCount: 80,
  });
  const twoUnitBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_base_two_unit_compact'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me. DATE: 8:11 am | ID:D1:17 | Andrew | Birds of prey feel powerful and graceful to me.',
    tokenCount: 44,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
    ],
    events: [baseOne, baseTwo, baseThree],
    summaries: [oversizedTopBridgeSummary, twoUnitBridgeSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [oversizedTopBridgeSummary, twoUnitBridgeSummary],
      'which specific type bird mesmerizes andrew': [oversizedTopBridgeSummary, twoUnitBridgeSummary],
      'Which Andrew': [oversizedTopBridgeSummary, twoUnitBridgeSummary],
    },
    contextTokenCount: 48,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 68,
    overheadTokens: 0,
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.summaryReferences.map((reference) => reference.id)).toEqual([twoUnitBridgeSummary.id]);
  expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([twoUnitBridgeSummary.id]);
  expect(output.modelMessages.some((message) => message.content.includes('Eagles have always mesmerized me'))).toBe(
    true,
  );
});

it('keeps the top bridge summary when it already fits inside the reserve', async () => {
  const baseOne = createTestMessage({
    id: createEventId('evt_bridge_reserve_fit_1'),
    content: 'base-reserve-fit-1',
    tokenCount: 16,
    sequence: 301,
  });
  const baseTwo = createTestMessage({
    id: createEventId('evt_bridge_reserve_fit_2'),
    content: 'base-reserve-fit-2',
    tokenCount: 16,
    sequence: 302,
  });

  const topBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_reserve_fit_top'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are strong and graceful.',
    tokenCount: 12,
  });
  const smallerBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_reserve_fit_smaller'),
    content: '[Summary] Andrew likes birds.',
    tokenCount: 8,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
    ],
    events: [baseOne, baseTwo],
    summaries: [topBridgeSummary, smallerBridgeSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [topBridgeSummary, smallerBridgeSummary],
      'which specific type bird mesmerizes andrew': [topBridgeSummary, smallerBridgeSummary],
      'Which Andrew': [topBridgeSummary, smallerBridgeSummary],
    },
    contextTokenCount: 32,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 64,
    overheadTokens: 0,
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([topBridgeSummary.id]);
  expect(output.summaryReferences.map((reference) => reference.id)).toEqual([topBridgeSummary.id]);
});
```

- [ ] **Step 2: Run the focused bridge-fit slice before production changes**

Run: `pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "bridge summary that fits after borrowing|two base messages make it fit|fits inside the reserve"`

Expected: FAIL
- first test fails because `selectedSummaryIds` is `[]`
- second test fails because the compact bridge summary is not selected
- third test may already pass

- [ ] **Step 3: Commit the red tests**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "test: add base-aware bridge fit regressions"
```

### Task 2: Add A Capped Evictable-Base Slack Budget Helper

**Files:**
- Modify: [`packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
- Test: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Add bridge-fit slack constants and a helper that only counts unpinned low-priority base items**

Insert near the other retrieval scoring helpers:

```ts
const MAX_BRIDGE_BASE_SLACK_TOKENS = 128;
const MAX_BRIDGE_BASE_SLACK_UNITS = 2;

type BridgeBaseSlackCandidate = {
  readonly kind: ResolvedContextItem['kind'];
  readonly tokenCount: number;
  readonly recencyScore: number;
};

const compareBridgeBaseSlackCandidates = (
  left: BridgeBaseSlackCandidate,
  right: BridgeBaseSlackCandidate,
): number => {
  if (left.kind !== right.kind) {
    return left.kind === 'message' ? -1 : 1;
  }

  if (right.recencyScore !== left.recencyScore) {
    return right.recencyScore - left.recencyScore;
  }

  if (right.tokenCount !== left.tokenCount) {
    return right.tokenCount - left.tokenCount;
  }

  return 0;
};

const getBridgeSelectionBudget = (input: {
  readonly retrievalReserve: number;
  readonly selectedBaseItems: readonly ResolvedContextItem[];
  readonly pinRules: readonly PinRule[];
}): number => {
  let extraSlack = 0;
  let usedUnits = 0;

  const candidates = input.selectedBaseItems
    .filter((item) => !isItemPinned(item.contextItem, input.pinRules))
    .map((item) => ({
      kind: item.kind,
      tokenCount: item.tokenCount,
      recencyScore: item.recencyScore,
    }))
    .sort(compareBridgeBaseSlackCandidates);

  for (const candidate of candidates) {
    if (usedUnits >= MAX_BRIDGE_BASE_SLACK_UNITS) {
      break;
    }

    if (extraSlack + candidate.tokenCount > MAX_BRIDGE_BASE_SLACK_TOKENS) {
      continue;
    }

    extraSlack += candidate.tokenCount;
    usedUnits += 1;
  }

  return input.retrievalReserve + extraSlack;
};
```

- [ ] **Step 2: Run the focused bridge-fit slice**

Run: `pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "bridge summary that fits after borrowing|two base messages make it fit|fits inside the reserve"`

Expected: FAIL
- the new helper compiles, but the selector still uses the old reserve-only budget

- [ ] **Step 3: Commit the helper scaffold**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts
git commit -m "refactor: add capped bridge slack budget helper"
```

### Task 3: Replace Reserve-Only Summary Selection With Base-Aware Fit

**Files:**
- Modify: [`packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
- Modify: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
- Test: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Rename the selector budget input and stop reading fit only from remaining reserve slack**

Update the selector signature and fit-aware branch:

```ts
const chooseBridgeSummaryCandidate = (input: {
  readonly rankedSummaryCandidates: readonly RankedSummaryRetrievalCandidate[];
  readonly selectedSummaryIdStrings: ReadonlySet<string>;
  readonly availableBudget: number;
  readonly bridgeSelectionBudget: number;
}): RankedSummaryRetrievalCandidate | undefined => {
  const viableCandidates = input.rankedSummaryCandidates.filter(
    (candidate) =>
      !input.selectedSummaryIdStrings.has(String(candidate.id)) && candidate.tokenCount <= input.availableBudget,
  );

  const topCandidate = viableCandidates[0];
  if (topCandidate === undefined) {
    return undefined;
  }

  if (topCandidate.tokenCount <= input.bridgeSelectionBudget) {
    return topCandidate;
  }

  const fitAwareCandidates = viableCandidates
    .filter(
      (candidate) =>
        candidate.tokenCount <= input.bridgeSelectionBudget && candidate.score >= topCandidate.score - 10,
    )
    .sort(compareFitAwareSummaryCandidates);

  return fitAwareCandidates[0] ?? topCandidate;
};
```

- [ ] **Step 2: Compute `bridgeSelectionBudget` once from trimmed base items and reuse it for every hint**

Replace the old reserve-only line inside `execute()`:

```ts
const bridgeSelectionBudget = getBridgeSelectionBudget({
  retrievalReserve,
  selectedBaseItems: trimmedBase.selectedItems,
  pinRules,
});
```

Then replace:

```ts
const summarySelectionBudget = Math.max(retrievalReserve, availableBudget - budgetUsedValue);
const selectedBridgeSummaryCandidate = chooseBridgeSummaryCandidate({
  rankedSummaryCandidates,
  selectedSummaryIdStrings,
  availableBudget,
  summarySelectionBudget,
});
```

with:

```ts
const selectedBridgeSummaryCandidate = chooseBridgeSummaryCandidate({
  rankedSummaryCandidates,
  selectedSummaryIdStrings,
  availableBudget,
  bridgeSelectionBudget,
});
```

- [ ] **Step 3: Add safety guardrails for cap and pinned-base behavior**

Append these two tests after the new bridge-fit regressions:

```ts
it('does not count pinned base context as bridge-fit slack', async () => {
  const pinnedBase = createTestMessage({
    id: createEventId('evt_bridge_pinned_slack'),
    content: 'base-pinned-context',
    tokenCount: 16,
    sequence: 401,
  });
  const bridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_pinned_slack'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are so strong and graceful.',
    tokenCount: 24,
  });

  const state = createState({
    contextItems: [createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(pinnedBase.id) })],
    events: [pinnedBase],
    summaries: [bridgeSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [bridgeSummary],
      'which specific type bird mesmerizes andrew': [bridgeSummary],
      'Which Andrew': [bridgeSummary],
    },
    contextTokenCount: 16,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 32,
    overheadTokens: 0,
    pinRules: [{ type: 'position', position: 0 }],
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.summaryReferences).toEqual([]);
  expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([]);
});

it('does not choose a compact bridge when it would need more than the capped base slack', async () => {
  const baseOne = createTestMessage({
    id: createEventId('evt_bridge_slack_cap_1'),
    content: 'base-slack-cap-1',
    tokenCount: 16,
    sequence: 501,
  });
  const baseTwo = createTestMessage({
    id: createEventId('evt_bridge_slack_cap_2'),
    content: 'base-slack-cap-2',
    tokenCount: 16,
    sequence: 502,
  });
  const baseThree = createTestMessage({
    id: createEventId('evt_bridge_slack_cap_3'),
    content: 'base-slack-cap-3',
    tokenCount: 16,
    sequence: 503,
  });

  const oversizedTopBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_slack_cap_top'),
    content: '[Summary] Andrew talked about birds in detail, but this summary is much too large.',
    tokenCount: 96,
  });
  const stillTooLargeCompactBridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_slack_cap_compact'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me. DATE: 8:11 am | ID:D1:17 | Andrew | Birds of prey feel powerful and graceful to me.',
    tokenCount: 52,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
    ],
    events: [baseOne, baseTwo, baseThree],
    summaries: [oversizedTopBridgeSummary, stillTooLargeCompactBridgeSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [oversizedTopBridgeSummary, stillTooLargeCompactBridgeSummary],
      'which specific type bird mesmerizes andrew': [oversizedTopBridgeSummary, stillTooLargeCompactBridgeSummary],
      'Which Andrew': [oversizedTopBridgeSummary, stillTooLargeCompactBridgeSummary],
    },
    contextTokenCount: 48,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 64,
    overheadTokens: 0,
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.summaryReferences).toEqual([]);
  expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([]);
});
```

- [ ] **Step 4: Run the focused bridge-fit and existing retrieval guardrails**

Run: `pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "borrowing one base message|two base messages make it fit|fits inside the reserve|pinned base context|capped base slack|exact raw evidence|coalesces touching raw bundles|stronger bridge summary"`

Expected: PASS

- [ ] **Step 5: Commit the selector change**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "fix: make bridge summary fit selection base-aware"
```

### Task 4: Verify The New Fit Strategy Against The Live Residual Shape

**Files:**
- Modify: none
- Verify: [`packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
- Verify: [`benchmarks/locomo/runs/locomo-2026-04-21T07-31-19-931Z/trace_per_example.jsonl`](/Users/khoitran/Documents/Projects/oss/ledger-memory/benchmarks/locomo/runs/locomo-2026-04-21T07-31-19-931Z/trace_per_example.jsonl)

- [ ] **Step 1: Run the full `materialize-context` test file**

Run: `pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts`

Expected: PASS

- [ ] **Step 2: Run the application package typecheck**

Run: `pnpm --filter @ledgermind/application typecheck`

Expected: PASS

- [ ] **Step 3: Run the application package build**

Run: `pnpm --filter @ledgermind/application build`

Expected: PASS

- [ ] **Step 4: Re-run the same LoCoMo canary shape**

Run:

```bash
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode llm --model gpt-5.4-mini --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --llm-timeout-ms 120000 --baselines ledgermind_static_materialize,rag --include-ledgermind-diagnostics --seeds 0
```

Expected:
- `conv-44::61` should stop dropping the compact bird bridge purely because the reserve is `256` and the bridge is slightly larger.
- `conv-47::67` should stay green.
- `conv-49::5` should not regress further; inspect whether the selected context stays answer-bearing and whether the final answer remains a synthesis problem rather than a reachability regression.

- [ ] **Step 5: Inspect the new trace specifically for the bird and Canada examples**

Run:

```bash
jq -rc 'select(.baseline=="ledgermind_static_materialize" and (.exampleId=="conv-44::61" or .exampleId=="conv-49::5")) | {exampleId, finalAnswer, contextSelection, retrievalHint: .retrievalDiagnostics.hints[0]}' /Users/khoitran/Documents/Projects/oss/ledger-memory/benchmarks/locomo/runs/locomo-*/trace_per_example.jsonl
```

Expected:
- `conv-44::61` shows the chosen compact bridge summary in `selectedSummaryIds`
- `conv-49::5` still keeps gold evidence reachable

- [ ] **Step 6: Commit the verification checkpoint**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "test: verify base-aware bridge fit behavior"
```

## Test Plan

- Focused regressions:
  - one-unit base slack selects a compact bridge summary
  - two-unit base slack selects a compact bridge summary
  - top bridge still wins when it already fits the reserve
  - pinned base items do not contribute bridge-fit slack
  - compact bridge does not win when it requires more than the capped slack
- Existing retrieval guardrails that must remain green:
  - exact raw evidence beats a weaker bridge summary
  - touching raw bundles still coalesce
  - same-hint raw swap behavior stays intact
  - scoped retrieval windows stay inside scope
  - oversized raw bundles are still skipped
- End-to-end verification:
  - full `materialize-context.test.ts`
  - `pnpm --filter @ledgermind/application typecheck`
  - `pnpm --filter @ledgermind/application build`
  - same LoCoMo canary command as the latest investigation

## Assumptions

- The existing retrieval packer already gives retrieval units first right of refusal over base context, so this plan intentionally targets selector fit, not a new packer architecture.
- This plan intentionally does not introduce synthetic summary compression.
- This plan intentionally does not change raw retrieval ranking or benchmark-only code.
- If `conv-44::61` still fails after this pass, the next plan should target true summary compression or explicit answer-bearing summary slicing, not more lexical ranking.
