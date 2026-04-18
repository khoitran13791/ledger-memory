# Expand Parent Summary Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized child conversation expand compacted summaries owned by its stored direct parent conversation, while keeping all other cross-conversation expansions forbidden.

**Architecture:** Keep `AuthorizationPort` policy-only and keep lineage enforcement in `ExpandUseCase`. After proving the caller is a real child conversation whose stored `parentId` matches the trusted caller context, treat only two conversation IDs as valid summary owners for `expand()`: the caller conversation and its stored direct parent. Do not broaden this fix to ancestor-chain, sibling, or arbitrary cross-conversation expansion.

**Tech Stack:** TypeScript 5.x strict ESM, Vitest 3.x, pnpm workspaces, in-memory SDK regression tests

---

## File Map

- Modify `packages/application/src/use-cases/expand.ts` - keep child-lineage verification, then allow summary ownership by the caller conversation or its stored direct parent.
- Modify `packages/application/src/use-cases/__tests__/expand.test.ts` - add a unit regression for expanding a parent-owned summary from a valid child caller.
- Modify `tests/regression/sdk-lifecycle.e2e.test.ts` - add an end-to-end regression proving the public SDK allows a child to expand a compacted parent summary.
- Modify `docs/high-level-design.md` - update the documented expand contract, testing guidance, and security note to match the new direct-parent behavior.
- Modify `docs/operator-level-recursion.md` - clarify that delegated child `expand()` is lineage-bound and limited to self-or-direct-parent summaries.

### Task 1: Add The Failing Application Regression

**Files:**
- Modify: `packages/application/src/use-cases/__tests__/expand.test.ts`
- Verify: `pnpm vitest run packages/application/src/use-cases/__tests__/expand.test.ts`

- [ ] **Step 1: Add a unit test that exercises a parent-owned summary.**

```ts
  it('allows a child caller to expand a summary owned by its stored parent conversation', async () => {
    const parentOwnedSummaryId = createSummaryNodeId('sum_expand_parent_owned_uc');
    const parentSummary = createTestSummary({
      idValue: 'sum_expand_parent_owned_uc',
      conversationId: parentConversationId,
      kind: 'leaf',
      content: 'parent conversation summary',
      tokenCount: 12,
    });
    const parentEvent = createTestLedgerEvent({
      idValue: 'evt_expand_parent_owned_1',
      conversationId: parentConversationId,
      sequence: 1,
      content: 'parent source event',
    });

    const authorization = new FakeAuthorizationPort(true);
    const summaryDag = new FakeSummaryDagPort({
      summaries: [parentSummary],
      expandedMessagesBySummaryId: new Map([[parentOwnedSummaryId, [parentEvent]]]),
    });
    const conversations = new FakeConversationPort([
      createTestConversation('conv_expand_parent_uc'),
      createTestConversation('conv_expand_uc', parentConversationId),
    ]);

    const useCase = new ExpandUseCase({ authorization, conversations, summaryDag });

    const output = await useCase.execute({
      summaryId: parentOwnedSummaryId,
      callerContext: createCaller(true),
    });

    expect(output.messages).toEqual([parentEvent]);
    expect(summaryDag.expandCalls).toEqual([parentOwnedSummaryId]);
  });
```

- [ ] **Step 2: Run the application unit test to capture the current failure.**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/expand.test.ts`
Expected: FAIL in the new test because `ExpandUseCase` still throws `InvalidReferenceError` when `summaryNode.conversationId === parentConversationId`.

### Task 2: Add The Failing SDK Regression

**Files:**
- Modify: `tests/regression/sdk-lifecycle.e2e.test.ts`
- Verify: `pnpm vitest run tests/regression/sdk-lifecycle.e2e.test.ts`

- [ ] **Step 1: Add an end-to-end regression that compacts the parent conversation and expands that parent summary from the child.**

```ts
  it('lets an authorized child expand a compacted summary owned by its direct parent conversation', async () => {
    const { engine, conversationId, parentConversationId } = createHarness({
      suffix: 'expand_parent_summary',
      parentSuffix: 'expand_parent_summary_parent',
      contextWindow: 200,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    });

    expect(parentConversationId, 'Expected parent conversation.').toBeDefined();
    if (parentConversationId === undefined) {
      throw new Error('Expected parent conversation.');
    }

    await engine.append({
      conversationId: parentConversationId,
      events: [
        createEvent('user', 'parent detail alpha', 20),
        createEvent('assistant', 'parent detail beta', 20),
        createEvent('user', 'parent detail gamma', 20),
        createEvent('assistant', 'parent detail delta', 20),
        createEvent('user', 'parent detail epsilon', 20),
        createEvent('assistant', 'parent detail zeta', 20),
      ],
    });

    const compaction = await engine.runCompaction({
      conversationId: parentConversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(90),
    });

    const parentSummaryId = requireFirstId(compaction.nodesCreated, 'parent summary node id');

    const expanded = await engine.expand({
      summaryId: parentSummaryId,
      callerContext: {
        conversationId,
        isSubAgent: true,
        parentConversationId,
      },
    });

    expect(expanded.messages.length).toBeGreaterThan(0);
    expect(expanded.messages.every((message) => message.conversationId === parentConversationId)).toBe(true);
    expect(expanded.messages.some((message) => message.content.includes('parent detail alpha'))).toBe(true);
  });
```

- [ ] **Step 2: Run the regression suite file to confirm the public SDK still blocks the intended drill-down flow.**

Run: `pnpm vitest run tests/regression/sdk-lifecycle.e2e.test.ts`
Expected: FAIL in the new test because the application-layer ownership check still rejects the direct-parent summary.

### Task 3: Implement The Minimal Application-Layer Fix

**Files:**
- Modify: `packages/application/src/use-cases/expand.ts`
- Re-run: `pnpm vitest run packages/application/src/use-cases/__tests__/expand.test.ts tests/regression/sdk-lifecycle.e2e.test.ts`

- [ ] **Step 1: Keep lineage validation intact, but authorize summary ownership by the caller or its stored direct parent.**

Replace the summary ownership block in `packages/application/src/use-cases/expand.ts` with:

```ts
    const callerConversation = await this.deps.conversations.get(input.callerContext.conversationId);
    if (
      callerConversation === null ||
      callerConversation.parentId === null ||
      callerConversation.parentId !== input.callerContext.parentConversationId
    ) {
      throw new UnauthorizedExpandError(input.callerContext.conversationId, input.summaryId);
    }

    const allowedParentConversationId = callerConversation.parentId;
    const summaryNode = await this.deps.summaryDag.getNode(input.summaryId);
    if (
      summaryNode === null ||
      (summaryNode.conversationId !== callerConversation.id &&
        summaryNode.conversationId !== allowedParentConversationId)
    ) {
      throw new InvalidReferenceError('summary', input.summaryId);
    }
```

Add this code comment immediately above the `summaryNode` ownership check only if you think the block is not obvious enough without it:

```ts
    // A delegated child may drill into its own summaries or the compacted summaries owned by its direct parent.
```

- [ ] **Step 2: Re-run the focused tests and make sure both regressions now pass.**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/expand.test.ts tests/regression/sdk-lifecycle.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit the code and test fix.**

```bash
git add packages/application/src/use-cases/expand.ts packages/application/src/use-cases/__tests__/expand.test.ts tests/regression/sdk-lifecycle.e2e.test.ts
git commit -m "fix: allow delegated children to expand direct parent summaries"
```

### Task 4: Align The Canonical Docs And Run Final Verification

**Files:**
- Modify: `docs/high-level-design.md`
- Modify: `docs/operator-level-recursion.md`

- [ ] **Step 1: Update the high-level design so it no longer documents the old restriction.**

Change the `ExpandUseCase (Guarded)` section in `docs/high-level-design.md` to:

```md
**Current implementation contract:** `expand()` is restricted to callers that
pass `AuthorizationPort.canExpand(callerContext)`. The use case then verifies
that the caller conversation exists, that it is itself a child conversation, and
that the stored `parentId` matches `callerContext.parentConversationId`.

The expanded summary must belong either to the caller conversation or to that
caller conversation's stored direct parent. Expansion does not cross beyond the
direct parent lineage.
```

Change the testing bullet in `docs/high-level-design.md` to:

```md
- **Expand delegated parent history:** Valid child lineage allows expansion of summaries owned by the caller conversation or its stored direct parent, but not unrelated conversations
```

Change the security note in `docs/high-level-design.md` to:

```md
application layer validates child lineage before expansion and only allows
summaries owned by the bound child conversation or its stored direct parent
conversation.
```

- [ ] **Step 2: Update the operator recursion doc to match the new direct-parent rule.**

In `docs/operator-level-recursion.md`, replace the current bootstrap bullet with:

```md
- parent-side `expand()` checks actual conversation lineage rather than trusting model-controlled payloads, and only permits summaries owned by the child conversation or its direct parent
```

- [ ] **Step 3: Run final verification for code and type safety.**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/expand.test.ts tests/regression/sdk-lifecycle.e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit the doc alignment.**

```bash
git add docs/high-level-design.md docs/operator-level-recursion.md
git commit -m "docs: align expand behavior with delegated parent drill-down"
```

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-expand-parent-summary-drilldown.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, and keep the implementation moving in small verified slices.
2. **Inline Execution** - Execute the tasks in this session using executing-plans, with checkpoints for review.
