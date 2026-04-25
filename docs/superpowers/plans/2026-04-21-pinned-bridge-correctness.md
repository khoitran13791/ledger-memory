# Pinned Bridge Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `MaterializeContextUseCase` choose a truly viable bridge summary under pinned budgets and guarantee pinned base context survives final packing.

**Architecture:** Keep this fix entirely inside [`materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts) and its existing unit tests in [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts). First lock the pinned-budget failures with red tests, then make bridge-summary viability include pinned-base coexistence, and finally make the final packer pre-keep pinned base units so selection and packing enforce the same constraint.

**Tech Stack:** TypeScript, Vitest, Node.js 22+, pnpm workspaces, existing Clean Architecture ports in `packages/application`

---

## Scope Guardrails

- No public API changes.
- Do not modify [`memory-engine.port.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/ports/driving/memory-engine.port.ts).
- Do not modify benchmark helpers or [`ledgermind-runtime.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/benchmarks/locomo/src/ledgermind-runtime.ts) in this pass.
- Keep the current retrieval reserve formula, raw bundle coalescing, raw bundle swap logic, and summary scoring formula.
- Reuse the existing diagnostics shape and existing reason enums. When a summary fails pinned-base coexistence, report it with the existing `over_budget` reason instead of adding a new enum.

## File Map

- Modify: [`materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
  Responsibility: pinned-aware bridge-summary viability, pinned-aware diagnostics, and pin-safe final packing.
- Modify: [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
  Responsibility: regressions for lower-ranked pinned fallback selection and pinned-base preservation during final packing.

### Task 1: Add Failing Regressions For Pinned Bridge Selection And Packing

**Files:**
- Modify: [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
- Test: [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Add a regression where the top fallback summary fails pinned coexistence but the next one fits**

```ts
it('selects the next viable bridge when the top fallback cannot coexist with pinned base', async () => {
  const pinnedBase = createTestMessage({
    id: createEventId('evt_bridge_pinned_fallback_base_1'),
    content: 'pinned-base-context',
    tokenCount: 16,
    sequence: 601,
  });
  const newerBaseOne = createTestMessage({
    id: createEventId('evt_bridge_pinned_fallback_base_2'),
    content: 'newer-base-context-1',
    tokenCount: 16,
    sequence: 602,
  });
  const newerBaseTwo = createTestMessage({
    id: createEventId('evt_bridge_pinned_fallback_base_3'),
    content: 'newer-base-context-2',
    tokenCount: 16,
    sequence: 603,
  });

  const topFallbackSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_pinned_fallback_top'),
    content:
      '[Summary] Andrew described the specific type of bird that mesmerizes him in vivid detail, naming the eagle and why it feels powerful and graceful.',
    tokenCount: 52,
  });
  const smallerViableSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_pinned_fallback_viable'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they feel strong and graceful.',
    tokenCount: 48,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(pinnedBase.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(newerBaseOne.id) }),
      createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(newerBaseTwo.id) }),
    ],
    events: [pinnedBase, newerBaseOne, newerBaseTwo],
    summaries: [topFallbackSummary, smallerViableSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [topFallbackSummary, smallerViableSummary],
      'which specific type bird mesmerizes andrew': [topFallbackSummary, smallerViableSummary],
      'Which Andrew': [topFallbackSummary, smallerViableSummary],
    },
    contextTokenCount: 48,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 64,
    overheadTokens: 0,
    pinRules: [{ type: 'position', position: 0 }],
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([smallerViableSummary.id]);
  expect(output.summaryReferences.map((reference) => reference.id)).toEqual([smallerViableSummary.id]);
  expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        summaryId: topFallbackSummary.id,
        selected: false,
        reason: 'over_budget',
      }),
      expect.objectContaining({
        summaryId: smallerViableSummary.id,
        selected: true,
        reason: 'selected',
      }),
    ]),
  );
});
```

- [ ] **Step 2: Add a regression where final packing must keep pinned base context and drop newer unpinned base instead**

```ts
it('keeps pinned base context in final output when a bridge summary is selected', async () => {
  const pinnedBase = createTestMessage({
    id: createEventId('evt_bridge_pinned_keep_base'),
    content: 'pinned-base-context',
    tokenCount: 16,
    sequence: 701,
  });
  const newerUnpinnedBase = createTestMessage({
    id: createEventId('evt_bridge_pinned_keep_unpinned'),
    content: 'newer-unpinned-base-context',
    tokenCount: 16,
    sequence: 702,
  });

  const bridgeSummary = createTestSummary({
    id: createSummaryNodeId('sum_bridge_pinned_keep'),
    content:
      '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are so strong and graceful.',
    tokenCount: 24,
  });

  const state = createState({
    contextItems: [
      createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(pinnedBase.id) }),
      createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(newerUnpinnedBase.id) }),
    ],
    events: [pinnedBase, newerUnpinnedBase],
    summaries: [bridgeSummary],
    summarySearchResults: {
      'Which specific type of bird mesmerizes Andrew?': [bridgeSummary],
      'which specific type bird mesmerizes andrew': [bridgeSummary],
      'Which Andrew': [bridgeSummary],
    },
    contextTokenCount: 32,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 40,
    overheadTokens: 0,
    pinRules: [{ type: 'position', position: 0 }],
    retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
  });

  expect(output.summaryReferences.map((reference) => reference.id)).toEqual([bridgeSummary.id]);
  expect(output.modelMessages.map((message) => message.content)).toEqual([
    pinnedBase.content,
    `[Summary ID: ${bridgeSummary.id}]\n${bridgeSummary.content}`,
  ]);
  expect(output.modelMessages.some((message) => message.content === newerUnpinnedBase.content)).toBe(false);
});
```

- [ ] **Step 3: Run the focused red tests**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "next viable bridge|keeps pinned base context"
```

Expected: FAIL

Expected failure shape:
- the first test fails because `chooseBridgeSummaryCandidate()` returns `undefined` after the top fallback fails the pinned-base check,
- the second test fails because the final packer keeps the newer unpinned base message and drops the pinned one.

- [ ] **Step 4: Commit the failing regressions**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "test: lock pinned bridge selection regressions"
```

### Task 2: Make Bridge Summary Viability Respect Pinned Base Context

**Files:**
- Modify: [`materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
- Test: [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Add a helper that defines total-budget viability with pinned base included**

Insert near `chooseBridgeSummaryCandidate()`:

```ts
const canBridgeSummaryCoexistWithPinnedBase = (input: {
  readonly candidateTokenCount: number;
  readonly pinnedBaseTokenCount: number;
  readonly availableBudget: number;
}): boolean => input.candidateTokenCount + input.pinnedBaseTokenCount <= input.availableBudget;
```

- [ ] **Step 2: Filter bridge candidates by pinned-base coexistence before ranking the fallback path**

Replace the selector with:

```ts
const chooseBridgeSummaryCandidate = (input: {
  readonly rankedSummaryCandidates: readonly RankedSummaryRetrievalCandidate[];
  readonly selectedSummaryIdStrings: ReadonlySet<string>;
  readonly availableBudget: number;
  readonly bridgeSelectionBudget: number;
  readonly pinnedBaseTokenCount: number;
}): RankedSummaryRetrievalCandidate | undefined => {
  const viableCandidates = input.rankedSummaryCandidates.filter(
    (candidate) =>
      !input.selectedSummaryIdStrings.has(String(candidate.id)) &&
      canBridgeSummaryCoexistWithPinnedBase({
        candidateTokenCount: candidate.tokenCount,
        pinnedBaseTokenCount: input.pinnedBaseTokenCount,
        availableBudget: input.availableBudget,
      }),
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

  if (fitAwareCandidates[0] !== undefined) {
    return fitAwareCandidates[0];
  }

  return topCandidate;
};
```

- [ ] **Step 3: Mark pinned-infeasible summaries as `over_budget` in retrieval diagnostics**

Inside the summary-candidate loop, update the non-selected reason branch to use the same helper:

```ts
const exceedsPinnedCoexistenceBudget = !canBridgeSummaryCoexistWithPinnedBase({
  candidateTokenCount: candidate.tokenCount,
  pinnedBaseTokenCount,
  availableBudget,
});

if (!isSelectedBridgeSummary) {
  candidateDecisions.push({
    summaryId: summary.id,
    score: candidate.score,
    stageHits: candidate.stageHits,
    overlapCount: candidate.overlapCount,
    tokenCount: candidate.tokenCount,
    selected: false,
    reason: candidate.tokenCount > availableBudget || exceedsPinnedCoexistenceBudget ? 'over_budget' : 'limit_reached',
  });
  continue;
}
```

- [ ] **Step 4: Run the focused slice again**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "next viable bridge|keeps pinned base context"
```

Expected:
- `selects the next viable bridge when the top fallback cannot coexist with pinned base` PASS
- `keeps pinned base context in final output when a bridge summary is selected` still FAIL until final packing is fixed

- [ ] **Step 5: Commit the selector fix**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts
git commit -m "fix: make bridge fallback respect pinned base"
```

### Task 3: Make Final Packing Preserve Pinned Base Units

**Files:**
- Modify: [`materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
- Test: [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Mark base packable units as pinned or unpinned**

Update the base unit variants:

```ts
type PackableUnit =
  | {
      readonly kind: 'base_message';
      readonly tokenCount: number;
      readonly order: number;
      readonly pinned: boolean;
      readonly modelMessages: readonly ModelMessage[];
    }
  | {
      readonly kind: 'base_summary';
      readonly tokenCount: number;
      readonly order: number;
      readonly pinned: boolean;
      readonly modelMessages: readonly ModelMessage[];
      readonly summaryReferences: readonly SummaryReference[];
    }
  | {
      readonly kind: 'retrieval_bridge_summary';
      readonly hintIndex: number;
      readonly limit: number;
      readonly score: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly tokenCount: number;
      readonly order: number;
      readonly selectionOrder: number;
      readonly modelMessages: readonly ModelMessage[];
      readonly summaryReferences: readonly SummaryReference[];
      readonly artifactIds: readonly ArtifactId[];
    }
  | {
      readonly kind: 'retrieval_raw_bundle';
      readonly hintIndex: number;
      readonly limit: number;
      readonly score: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly tokenCount: number;
      readonly order: number;
      readonly selectionOrder: number;
      readonly seedId: LedgerEvent['id'];
      readonly windowStartSequence: number;
      readonly windowEndSequence: number;
      readonly messageIds: readonly LedgerEvent['id'][];
      readonly modelMessages: readonly ModelMessage[];
    };
```

- [ ] **Step 2: Build `baseUnits` with explicit pin metadata and pre-seed kept units with the pinned base**

Replace the current `baseUnits` / `rankedUnits` / `keptUnits` initialization with:

```ts
const baseUnits: PackableUnit[] = trimmedBase.selectedItems.map((item) => {
  const pinned = isItemPinned(item.contextItem, pinRules);

  return item.kind === 'summary'
    ? {
        kind: 'base_summary',
        tokenCount: item.tokenCount,
        order: order++,
        pinned,
        modelMessages: [item.modelMessage],
        summaryReferences: [item.summaryReference],
      }
    : {
        kind: 'base_message',
        tokenCount: item.tokenCount,
        order: order++,
        pinned,
        modelMessages: [item.modelMessage],
      };
});

const pinnedBaseUnits = baseUnits
  .filter(
    (unit): unit is Extract<PackableUnit, { kind: 'base_message' }> | Extract<PackableUnit, { kind: 'base_summary' }> =>
      (unit.kind === 'base_message' || unit.kind === 'base_summary') && unit.pinned,
  )
  .sort((left, right) => left.order - right.order);

const rankedUnits: PackableUnit[] = [
  ...[...retrievalUnits].sort(compareRetrievalUnits),
  ...[...baseUnits]
    .filter((unit): unit is Extract<PackableUnit, { kind: 'base_message' }> => unit.kind === 'base_message' && !unit.pinned)
    .sort((left, right) => right.order - left.order),
  ...[...baseUnits]
    .filter((unit): unit is Extract<PackableUnit, { kind: 'base_summary' }> => unit.kind === 'base_summary' && !unit.pinned)
    .sort((left, right) => right.order - left.order),
];

const keptUnits: PackableUnit[] = [...pinnedBaseUnits];
let used = pinnedBaseUnits.reduce((total, unit) => total + unit.tokenCount, 0);

if (used > availableBudget) {
  throw new MaterializeContextBudgetExceededError(
    availableBudget,
    used,
    'Pinned context items exceed available budget during final packing.',
  );
}
```

- [ ] **Step 3: Leave the rest of the retrieval packing logic intact, but let it pack only on top of the pinned pre-seed**

Keep the current retrieval-limit and bridge-rescue logic, but make sure the loop starts from the pre-seeded `used` value:

```ts
for (const unit of rankedUnits) {
  if (unit.kind === 'retrieval_bridge_summary' || unit.kind === 'retrieval_raw_bundle') {
    const usedForHint = keptHintCounts.get(unit.hintIndex) ?? 0;
    if (usedForHint >= unit.limit) {
      continue;
    }
  }

  if (used + unit.tokenCount > availableBudget) {
    continue;
  }

  keptUnits.push(unit);
  used += unit.tokenCount;

  if (unit.kind === 'retrieval_bridge_summary' || unit.kind === 'retrieval_raw_bundle') {
    keptHintCounts.set(unit.hintIndex, (keptHintCounts.get(unit.hintIndex) ?? 0) + 1);
  }
}
```

Important:
- Do not add pinned base units into `rankedUnits`; they are already guaranteed in `keptUnits`.
- Keep the final `kept` ordering as `order` ascending so pinned base still appears in chronological order relative to summaries and retrieval output.

- [ ] **Step 4: Run the focused pinned bridge slice**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "next viable bridge|keeps pinned base context"
```

Expected: PASS

- [ ] **Step 5: Commit the pin-safe packer change**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "fix: preserve pinned base during bridge packing"
```

### Task 4: Verify The Whole Materialization Slice

**Files:**
- Verify: [`materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
- Verify: [`materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)

- [ ] **Step 1: Run the full use-case test file**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
```

Expected: PASS

- [ ] **Step 2: Run application typecheck**

Run:

```bash
pnpm --filter @ledgermind/application typecheck
```

Expected: PASS

- [ ] **Step 3: Run the monorepo build**

Run:

```bash
pnpm build
```

Expected: PASS

- [ ] **Step 4: Re-run the LoCoMo canary shape that exercises `static_materialize`**

Run:

```bash
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode llm --model gpt-5.4-mini --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --llm-timeout-ms 120000 --baselines ledgermind_static_materialize,rag --include-ledgermind-diagnostics --seeds 0
```

Expected:
- no regression in pinned-base behavior inside `ledgermind_static_materialize` traces,
- no bridge-summary disappearance caused by pinned fallback selection,
- no final-output traces where a pinned base message is replaced by a newer unpinned base message.

## Self-Review

### Spec Coverage

- Finding 1 is addressed by Task 1 Step 1 and Task 2 Steps 1-4.
- Finding 2 is addressed by Task 1 Step 2 and Task 3 Steps 1-4.
- Finding 3 is addressed by Task 1 Step 1 and Task 4 Step 1.

### Placeholder Scan

- No `TODO`, `TBD`, or “similar to above” placeholders remain.
- Every code-changing step includes concrete code blocks or exact replacement snippets.
- Every verification step includes an exact command and expected outcome.

### Type Consistency

- `PackableUnit` remains the only packing union; the plan only adds `pinned` to base variants and does not change retrieval unit names.
- `chooseBridgeSummaryCandidate()` keeps the same selector role while adding `pinnedBaseTokenCount` to viability checks.
- Existing diagnostics continue using `selectedSummaryIds`, `candidateDecisions`, and existing reason enums.

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-04-21-pinned-bridge-correctness.md`](/Users/khoitran/Documents/Projects/oss/ledger-memory/docs/superpowers/plans/2026-04-21-pinned-bridge-correctness.md).

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints
