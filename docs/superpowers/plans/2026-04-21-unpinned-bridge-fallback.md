# Unpinned Bridge Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep strong unpinned bridge summaries eligible when they miss the soft bridge-slack budget but still fit the total available budget, so `conv-47::67`-style cases do not lose the bridge entirely.

**Architecture:** Scope the fix to summary bridge selection inside [`materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts). Keep pinned-base coexistence checks exactly as they are, but treat `bridgeSelectionBudget` as a preference, not a hard gate, for unpinned flows: prefer compact near-score bridges when they fit the soft budget, otherwise fall back to the top viable summary and let the existing final packer decide.

**Tech Stack:** TypeScript, Vitest, Node.js 22+, pnpm workspaces, existing Clean Architecture application-layer use case tests.

---

## File Map

- Modify: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
  Responsibility: bridge-summary candidate selection, soft-budget preference, pinned-base coexistence filtering.
- Modify: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
  Responsibility: regression coverage for the new unpinned fallback behavior while preserving existing pinned and compact-fit guardrails.

## Non-Goals

- Do not change `searchEvents()`.
- Do not change the retrieval packer, raw bundle coalescing, or pinned-base packing.
- Do not change benchmark-only helpers or deterministic summary rendering in `benchmarks/locomo`.
- Do not change the public `MaterializeContextOutput` contract.

### Task 1: Add a Failing Regression for the Unpinned Soft-Slack Miss

**Files:**
- Modify: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)
- Test: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Write the failing regression**

```ts
  it('falls back to the top viable unpinned bridge when no summary fits the soft bridge budget', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_unpinned_fallback_base_1'),
      content: 'base-unpinned-context-1',
      tokenCount: 16,
      sequence: 801,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_unpinned_fallback_base_2'),
      content: 'base-unpinned-context-2',
      tokenCount: 16,
      sequence: 802,
    });
    const baseThree = createTestMessage({
      id: createEventId('evt_bridge_unpinned_fallback_base_3'),
      content: 'base-unpinned-context-3',
      tokenCount: 16,
      sequence: 803,
    });

    const strongBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_unpinned_fallback_top'),
      content:
        "[Summary] DATE: 3:47 pm | ID:D1:8 | James | I've worked with Python and C++. I've built a website and some game mods.",
      tokenCount: 64,
    });
    const weakCompactSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_unpinned_fallback_compact'),
      content: '[Summary] James enjoys programming projects with John.',
      tokenCount: 24,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
      ],
      events: [baseOne, baseTwo, baseThree],
      summaries: [strongBridgeSummary, weakCompactSummary],
      summarySearchResults: {
        'What programming languages has James worked with?': [strongBridgeSummary],
        'what programming languages has james worked with': [strongBridgeSummary],
        'What James': [strongBridgeSummary, weakCompactSummary],
      },
      contextTokenCount: 48,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 80,
      overheadTokens: 0,
      retrievalHints: [{ query: 'What programming languages has James worked with?', limit: 1 }],
    });

    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([strongBridgeSummary.id]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([strongBridgeSummary.id]);
    expect(output.modelMessages.some((message) => message.content.includes('Python and C++'))).toBe(true);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: strongBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
        expect.objectContaining({
          summaryId: weakCompactSummary.id,
          selected: false,
        }),
      ]),
    );
  });
```

- [ ] **Step 2: Run the focused regression to verify it fails on the current branch**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "falls back to the top viable unpinned bridge when no summary fits the soft bridge budget"
```

Expected: FAIL because `selectedSummaryIds` and `summaryReferences` are currently empty in the unpinned over-soft-budget path.

- [ ] **Step 3: Run the nearby bridge guardrails before touching production code**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "selects a bridge summary that fits after borrowing one base message worth of slack|selects a compact bridge summary when two base messages make it fit|keeps the top bridge summary when it already fits inside the reserve|selects the next viable bridge when the top fallback cannot coexist with pinned base|keeps pinned base context in final output when a bridge summary is selected"
```

Expected: PASS. These are the guardrails the implementation must keep green.

- [ ] **Step 4: Commit the failing regression**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "test: lock unpinned bridge fallback regression"
```

### Task 2: Make Soft Slack a Preference for Unpinned Bridge Selection

**Files:**
- Modify: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
- Test: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Replace the unpinned hard-stop in `chooseBridgeSummaryCandidate()`**

Replace the existing helper with:

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

  const fitAwareCandidate = viableCandidates
    .filter(
      (candidate) =>
        candidate.tokenCount <= input.bridgeSelectionBudget && candidate.score >= topCandidate.score - 10,
    )
    .sort(compareFitAwareSummaryCandidates)[0];

  if (fitAwareCandidate !== undefined) {
    return fitAwareCandidate;
  }

  return topCandidate;
};
```

Why this exact change:
- it preserves the existing soft-budget preference for compact near-score bridges,
- it preserves the hard pinned-base coexistence filter,
- it restores the preselection path for unpinned strong bridges that only fail the soft slack target.

- [ ] **Step 2: Remove the now-unused `hasPinnedBaseItems` plumbing**

Update the bridge selection setup from:

```ts
    const pinnedBaseItems = trimmedBase.selectedItems.filter((item) => isItemPinned(item.contextItem, pinRules));
    const hasPinnedBaseItems = pinnedBaseItems.length > 0;
    const pinnedBaseTokenCount = pinnedBaseItems.reduce((total, item) => total + item.tokenCount, 0);
```

to:

```ts
    const pinnedBaseItems = trimmedBase.selectedItems.filter((item) => isItemPinned(item.contextItem, pinRules));
    const pinnedBaseTokenCount = pinnedBaseItems.reduce((total, item) => total + item.tokenCount, 0);
```

and update the call site from:

```ts
        const chosenBridgeSummary = chooseBridgeSummaryCandidate({
          rankedSummaryCandidates,
          selectedSummaryIdStrings,
          availableBudget,
          bridgeSelectionBudget,
          hasPinnedBaseItems,
          pinnedBaseTokenCount,
        });
```

to:

```ts
        const chosenBridgeSummary = chooseBridgeSummaryCandidate({
          rankedSummaryCandidates,
          selectedSummaryIdStrings,
          availableBudget,
          bridgeSelectionBudget,
          pinnedBaseTokenCount,
        });
```

- [ ] **Step 3: Run the focused bridge slice**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts -t "falls back to the top viable unpinned bridge when no summary fits the soft bridge budget|selects a bridge summary that fits after borrowing one base message worth of slack|selects a compact bridge summary when two base messages make it fit|keeps the top bridge summary when it already fits inside the reserve|selects the next viable bridge when the top fallback cannot coexist with pinned base|keeps pinned base context in final output when a bridge summary is selected"
```

Expected: PASS. The new unpinned regression should turn green without breaking the compact-fit and pinned-base paths.

- [ ] **Step 4: Commit the selector change**

```bash
git add /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
git commit -m "fix: keep strong unpinned bridge summaries eligible"
```

### Task 3: Verify the Core Fix Against the Known Benchmark Shape

**Files:**
- Verify: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/materialize-context.ts)
- Verify: [`/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts`](/Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts)

- [ ] **Step 1: Run the full materialize-context use-case file**

Run:

```bash
pnpm vitest run /Users/khoitran/Documents/Projects/oss/ledger-memory/packages/application/src/use-cases/__tests__/materialize-context.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run application typecheck**

Run:

```bash
pnpm --filter @ledgermind/application typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the monorepo build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Rerun the same LoCoMo LLM canary**

Run:

```bash
pnpm --filter @ledgermind/benchmark-locomo benchmark --canary --prediction-mode llm --model gpt-5.4-mini --llm-base-url http://localhost:8317/v1 --llm-api-key proxypal-local --llm-timeout-ms 120000 --baselines ledgermind_static_materialize,rag --include-ledgermind-diagnostics --seeds 0
```

Expected:
- `conv-47::67` regains a selected bridge summary and reachable `D1:8`,
- `conv-44::61` stays green with `Eagles`,
- `ledgermind_static_materialize` remains ahead of `rag` and should recover the regression introduced by the unpinned hard-stop.

- [ ] **Step 5: Inspect the benchmark traces directly**

Run:

```bash
latest_run="$(ls -1dt /Users/khoitran/Documents/Projects/oss/ledger-memory/benchmarks/locomo/runs/locomo-* | head -1)"
echo "$latest_run"
sed -n '1,120p' "$latest_run/summary.md"
rg -n '"baseline":"ledgermind_static_materialize".*"exampleId":"conv-44::61"|"baseline":"ledgermind_static_materialize".*"exampleId":"conv-47::67"' "$latest_run/trace_per_example.jsonl"
```

Expected:
- the `summary.md` aggregate should not show the `0.421` / `conv-47::67` regression shape from the previous run,
- `conv-47::67` should show non-empty `summaryReferenceIds` or `selectedSummaryIds`,
- `conv-44::61` should still show `matchedEvidenceIds:["D1:16"]`.

## Test Plan

- Unit regression:
  - unpinned strong bridge survives when it exceeds the soft bridge budget but still fits total budget,
  - compact near-score bridge still wins when it fits the soft budget,
  - pinned fallback still picks the next viable bridge when the top candidate cannot coexist with pinned base,
  - pinned base still remains in final output after bridge selection.
- Verification:
  - full `materialize-context.test.ts`,
  - `pnpm --filter @ledgermind/application typecheck`,
  - `pnpm build`,
  - LoCoMo canary rerun with direct trace inspection for `conv-44::61` and `conv-47::67`.

## Assumptions

- The current regression is caused by selector behavior in `chooseBridgeSummaryCandidate()`, not by raw retrieval or benchmark helper drift.
- Existing packer behavior is good enough for this pass; we are restoring a bridge candidate to the packer, not changing packer policy.
- The fix should stay entirely inside core application code and tests.
