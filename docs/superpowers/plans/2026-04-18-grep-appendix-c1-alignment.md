# Grep Appendix C.1 Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `MemoryEngine.grep()` and its tool surfaces with Appendix C.1 by returning paginated results grouped by the summary node that currently covers each match.

**Architecture:** Treat this as one contract correction that flows from `@ledgermind/application` outward: define the new paginated/grouped grep DTOs in the driving and driven ports, keep regex execution and total-count calculation inside the storage adapters, and make `GrepUseCase` responsible for scope validation, page normalization, and grouping the page into stable output buckets. Because LedgerMind is still pre-1.0 and the review comment is about the public port itself, replace the legacy flat `matches` shape instead of carrying a backward-compatibility alias.

**Tech Stack:** TypeScript strict ESM, Node.js 22, Vitest, existing in-memory and PostgreSQL persistence adapters, `@ledgermind/sdk`, canonical MCP tool catalog, Vercel AI tool adapter, and repo docs in `docs/`.

---

## Scope And Decisions

- Appendix C.1 expects `grep` results to be paginated and grouped by the summary that currently covers each match; the current HLD explicitly documents that LedgerMind does not yet do that, so code and docs must change together.
- Use `offset` + `limit` pagination for v1 of this fix. It is easy to thread through SDK/tool JSON schemas, deterministic across adapters, and sufficient for the paper-alignment gap called out in the review.
- Normalize pagination in the application layer: default `offset = 0`, default `limit = 25`, cap `limit = 100`.
- Paginate the ordered raw match stream first, then group that page into contiguous `coveringSummaryId` buckets. This keeps `totalMatchCount` honest and avoids page boundaries depending on grouping decisions.
- When `scope` is provided, all returned matches should be tagged with `coveringSummaryId = scope`.
- When `scope` is omitted, derive `coveringSummaryId` from the first summary reference currently present in context whose expanded lineage contains the matched event. If no active summary covers an event, place it into one uncovered bucket with `coveringSummaryId` omitted.
- Non-goals: changing grep from regex to full-text, extracting multiple matches per single event, changing `describe()` / `expand()` semantics, or introducing a general pagination utility for unrelated APIs.

## File Structure

### Existing Files To Modify

- `packages/application/src/ports/driving/memory-engine.port.ts` - replace the flat grep DTOs with paginated/grouped output types and add pagination inputs.
- `packages/application/src/ports/driven/persistence/ledger-read.port.ts` - make `regexSearchEvents()` accept normalized pagination inputs and return `{ matches, totalMatchCount }`.
- `packages/application/src/use-cases/grep.ts` - normalize paging, validate scope, group returned matches, and emit `page` metadata.
- `packages/application/src/use-cases/__tests__/grep.test.ts` - lock the new public behavior with focused use-case tests.
- `packages/application/src/use-cases/__tests__/retrieval-test-doubles.ts` - update `FakeLedgerReadPort` and grep test helpers to the new driven-port contract.
- `packages/application/src/index.ts` - re-export any renamed/new grep DTOs from `@ledgermind/application`.
- `packages/adapters/src/storage/in-memory/in-memory-ledger-store.ts` - compute active coverage for unscoped grep and return paged results plus total count.
- `packages/adapters/src/storage/in-memory/__tests__/in-memory-ledger-store.test.ts` - assert in-memory parity for coverage tagging and pagination.
- `packages/infrastructure/src/postgres/pg-ledger-store.ts` - push coverage resolution and pagination into SQL so Postgres behavior matches in-memory.
- `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts` - verify scoped and unscoped pagination behavior directly against PostgreSQL.
- `packages/sdk/src/index.ts` - wire the updated `GrepUseCase` signature without changing the public engine method name.
- `packages/sdk/src/index.test.ts` - keep stable surface checks aligned with the new grep DTOs if any shape assertions exist there.
- `packages/adapters/src/tools/canonical-memory-tool-catalog.ts` - accept `offset` / `limit` on `memory.recall`.
- `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts` - accept `offset` / `limit` on `memory.grep`, propagate them to `engine.grep()`, and derive references from grouped output.
- `packages/adapters/src/tools/shared/reference-derivation.ts` - flatten `groups[].matches` instead of reading `output.matches`.
- `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts` - update schemas, envelopes, and grep reference assertions.
- `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts` - update runtime-bound grep tool expectations and new envelope shape.
- `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts` - refresh minimal grep stub outputs.
- `packages/mcp-server/src/__tests__/tool-registry.test.ts` - refresh minimal grep stub outputs.
- `packages/mcp-server/src/__tests__/server.integration.test.ts` - keep MCP integration fixtures aligned with the new `GrepOutput`.
- `packages/claude-code/src/__tests__/pre-compact.test.ts` - refresh minimal grep stub outputs.
- `packages/claude-code/src/__tests__/post-tool-use.test.ts` - refresh minimal grep stub outputs.
- `packages/claude-code/src/__tests__/stop.test.ts` - refresh minimal grep stub outputs.
- `tests/regression/sdk-lifecycle.e2e.test.ts` - assert the SDK returns grouped pages instead of a flat list.
- `tests/regression/postgres-adapter.regression.test.ts` - keep the regression coverage assertion on grouped results.
- `tests/regression/operator-tool-surface.test.ts` - refresh minimal grep stub outputs if the type change breaks the test harness.
- `docs/high-level-design.md` - replace the “current contract is flat/unpaginated” note with the implemented grouped/page contract.
- `docs/testing-strategy.md` - update grep examples that still call `grepResult.matches`.

### Generated / Build-Synced Files To Watch

- `packages/sdk/src/index.js`
- `packages/sdk/src/index.d.ts`
- `packages/adapters/src/index.js`
- `packages/adapters/src/index.d.ts`
- `packages/adapters/src/storage/in-memory/in-memory-ledger-store.js`
- `packages/adapters/src/storage/in-memory/in-memory-ledger-store.d.ts`

Do not hand-edit these unless the repo already expects source-mirrored JS/DTS edits. Prefer changing the TypeScript source, then run the normal build step and stage any generated deltas that the repo tracks.

---

## Chunk 1: Public Contract First

### Task 1: Replace the flat grep DTOs with grouped, paginated contracts

**Files:**
- Modify: `packages/application/src/ports/driving/memory-engine.port.ts`
- Modify: `packages/application/src/ports/driven/persistence/ledger-read.port.ts`
- Modify: `packages/application/src/use-cases/grep.ts`
- Modify: `packages/application/src/use-cases/__tests__/grep.test.ts`
- Modify: `packages/application/src/use-cases/__tests__/retrieval-test-doubles.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/use-cases/__tests__/grep.test.ts`

- [ ] **Step 1: Write the failing application tests for grouped output and page metadata**

```ts
it('returns grouped paginated matches with stable page metadata', async () => {
  const alphaCoverage = createSummaryNodeId('sum_grep_alpha');
  const betaCoverage = createSummaryNodeId('sum_grep_beta');

  const first = createTestGrepMatch({
    eventIdValue: 'evt_grep_1',
    sequence: 1,
    excerpt: 'alpha token one',
    coveringSummaryId: alphaCoverage,
  });
  const second = createTestGrepMatch({
    eventIdValue: 'evt_grep_2',
    sequence: 2,
    excerpt: 'alpha token two',
    coveringSummaryId: alphaCoverage,
  });
  const third = createTestGrepMatch({
    eventIdValue: 'evt_grep_3',
    sequence: 3,
    excerpt: 'beta token three',
    coveringSummaryId: betaCoverage,
  });

  const ledgerRead = new FakeLedgerReadPort({
    matches: [first, second, third],
    totalMatchCount: 3,
  });
  const summaryDag = new FakeSummaryDagPort();
  const useCase = new GrepUseCase({ ledgerRead, summaryDag });

  const output = await useCase.execute({ conversationId, pattern: 'token' });

  expect(output.groups).toEqual([
    {
      coveringSummaryId: alphaCoverage,
      matches: [
        { eventId: first.eventId, sequence: first.sequence, excerpt: first.excerpt },
        { eventId: second.eventId, sequence: second.sequence, excerpt: second.excerpt },
      ],
    },
    {
      coveringSummaryId: betaCoverage,
      matches: [{ eventId: third.eventId, sequence: third.sequence, excerpt: third.excerpt }],
    },
  ]);
  expect(output.page).toEqual({
    offset: 0,
    limit: 25,
    returnedMatchCount: 3,
    totalMatchCount: 3,
    hasMore: false,
  });
  expect(ledgerRead.regexCalls).toEqual([
    {
      conversationId,
      pattern: 'token',
      offset: 0,
      limit: 25,
    },
  ]);
});

it('emits nextOffset when more matches remain after the current page', async () => {
  const scopeSummary = createSummaryNodeId('sum_scope_grep_uc');
  const pagedMatch = createTestGrepMatch({
    eventIdValue: 'evt_grep_1',
    sequence: 1,
    excerpt: 'inside token one',
    coveringSummaryId: scopeSummary,
  });

  const ledgerRead = new FakeLedgerReadPort({
    matches: [pagedMatch],
    totalMatchCount: 4,
  });
  const summaryDag = new FakeSummaryDagPort({
    summaries: [
      createTestSummary({
        idValue: 'sum_scope_grep_uc',
        conversationId,
        kind: 'condensed',
        content: 'scope summary',
        tokenCount: 10,
      }),
    ],
  });
  const useCase = new GrepUseCase({ ledgerRead, summaryDag });

  const output = await useCase.execute({
    conversationId,
    pattern: 'token',
    scope: scopeSummary,
    offset: 1,
    limit: 1,
  });

  expect(output.groups).toEqual([
    {
      coveringSummaryId: scopeSummary,
      matches: [{ eventId: pagedMatch.eventId, sequence: pagedMatch.sequence, excerpt: pagedMatch.excerpt }],
    },
  ]);
  expect(output.page).toEqual({
    offset: 1,
    limit: 1,
    returnedMatchCount: 1,
    totalMatchCount: 4,
    hasMore: true,
    nextOffset: 2,
  });
});
```

- [ ] **Step 2: Run the application grep test to confirm the old contract fails**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/grep.test.ts`

Expected: FAIL because the old use case still returns `{ matches: [...] }` and the fake driven port does not yet accept pagination metadata.

- [ ] **Step 3: Replace the driving and driven grep DTOs with the new shapes**

```ts
// packages/application/src/ports/driving/memory-engine.port.ts
export interface GrepInput {
  readonly conversationId: ConversationId;
  readonly pattern: string;
  readonly scope?: SummaryNodeId;
  readonly offset?: number;
  readonly limit?: number;
}

export interface GrepMatch {
  readonly eventId: EventId;
  readonly sequence: SequenceNumber;
  readonly excerpt: string;
}

export interface GrepGroup {
  readonly coveringSummaryId?: SummaryNodeId;
  readonly matches: readonly GrepMatch[];
}

export interface GrepPageInfo {
  readonly offset: number;
  readonly limit: number;
  readonly returnedMatchCount: number;
  readonly totalMatchCount: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
}

export interface GrepOutput {
  readonly groups: readonly GrepGroup[];
  readonly page: GrepPageInfo;
}

// packages/application/src/ports/driven/persistence/ledger-read.port.ts
export interface RegexSearchPageInput {
  readonly scope?: SummaryNodeId;
  readonly offset: number;
  readonly limit: number;
}

export interface RegexSearchPageOutput {
  readonly matches: readonly GrepMatch[];
  readonly totalMatchCount: number;
}

regexSearchEvents(
  conversationId: ConversationId,
  pattern: string,
  page: RegexSearchPageInput,
): Promise<RegexSearchPageOutput>;
```

- [ ] **Step 4: Implement page normalization and grouping inside `GrepUseCase`**

```ts
const DEFAULT_GREP_LIMIT = 25;
const MAX_GREP_LIMIT = 100;

const normalizeOffset = (value: number | undefined): number => {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : 0;
};

const normalizeLimit = (value: number | undefined): number => {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return DEFAULT_GREP_LIMIT;
  }

  return Math.min(value, MAX_GREP_LIMIT);
};

const toPublicGroups = (
  matches: readonly LedgerReadGrepMatch[],
): readonly GrepGroup[] => {
  const groups: Array<{ coveringSummaryId?: SummaryNodeId; matches: GrepMatch[] }> = [];

  for (const match of matches) {
    const current = groups.at(-1);
    if (current?.coveringSummaryId === match.coveringSummaryId) {
      current.matches.push({
        eventId: match.eventId,
        sequence: match.sequence,
        excerpt: match.excerpt,
      });
      continue;
    }

    groups.push({
      ...(match.coveringSummaryId === undefined ? {} : { coveringSummaryId: match.coveringSummaryId }),
      matches: [
        {
          eventId: match.eventId,
          sequence: match.sequence,
          excerpt: match.excerpt,
        },
      ],
    });
  }

  return groups;
};

async execute(input: GrepInput): Promise<GrepOutput> {
  if (input.scope) {
    const summaryNode = await this.deps.summaryDag.getNode(input.scope);
    if (!summaryNode || summaryNode.conversationId !== input.conversationId) {
      throw new InvalidReferenceError('summary_scope', input.scope, `Unknown summary scope reference: ${input.scope}`);
    }
  }

  const offset = normalizeOffset(input.offset);
  const limit = normalizeLimit(input.limit);
  const page = await this.deps.ledgerRead.regexSearchEvents(input.conversationId, input.pattern, {
    offset,
    limit,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });

  const returnedMatchCount = page.matches.length;
  const nextOffset = offset + returnedMatchCount;

  return {
    groups: toPublicGroups(page.matches),
    page: {
      offset,
      limit,
      returnedMatchCount,
      totalMatchCount: page.totalMatchCount,
      hasMore: nextOffset < page.totalMatchCount,
      ...(nextOffset < page.totalMatchCount ? { nextOffset } : {}),
    },
  };
}
```

- [ ] **Step 5: Update the grep doubles and exports so the package compiles**

```ts
// packages/application/src/use-cases/__tests__/retrieval-test-doubles.ts
export class FakeLedgerReadPort implements LedgerReadPort {
  readonly regexCalls: Array<{
    readonly conversationId: ConversationId;
    readonly pattern: string;
    readonly scope?: SummaryNodeId;
    readonly offset: number;
    readonly limit: number;
  }> = [];

  constructor(
    private readonly page: {
      readonly matches: readonly LedgerReadGrepMatch[];
      readonly totalMatchCount: number;
    } = { matches: [], totalMatchCount: 0 },
  ) {}

  async regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    input: RegexSearchPageInput,
  ): Promise<RegexSearchPageOutput> {
    this.regexCalls.push({
      conversationId,
      pattern,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      offset: input.offset,
      limit: input.limit,
    });

    return this.page;
  }
}

// packages/application/src/index.ts
export type {
  GrepGroup,
  GrepInput,
  GrepMatch,
  GrepOutput,
  GrepPageInfo,
} from './ports/driving/memory-engine.port';
```

- [ ] **Step 6: Run the updated application grep tests**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/grep.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the application contract change**

```bash
git add \
  packages/application/src/ports/driving/memory-engine.port.ts \
  packages/application/src/ports/driven/persistence/ledger-read.port.ts \
  packages/application/src/use-cases/grep.ts \
  packages/application/src/use-cases/__tests__/grep.test.ts \
  packages/application/src/use-cases/__tests__/retrieval-test-doubles.ts \
  packages/application/src/index.ts
git commit -m "feat(application): paginate grouped grep results"
```

---

## Chunk 2: Adapter Parity

### Task 2: Add pagination and current-summary coverage to the in-memory adapter

**Files:**
- Modify: `packages/adapters/src/storage/in-memory/in-memory-ledger-store.ts`
- Modify: `packages/adapters/src/storage/in-memory/__tests__/in-memory-ledger-store.test.ts`
- Test: `packages/adapters/src/storage/in-memory/__tests__/in-memory-ledger-store.test.ts`

- [ ] **Step 1: Write the failing in-memory tests for unscoped coverage and paging**

```ts
it('returns paged regex matches with active covering summaries for unscoped grep', async () => {
  const state = createInMemoryPersistenceState();
  const store = new InMemoryLedgerStore(state);
  const conversationId = createConversationId('conv_ledger_paged');

  const evt1 = createEvent(conversationId, 1, 'alpha one');
  const evt2 = createEvent(conversationId, 2, 'alpha two');
  const evt3 = createEvent(conversationId, 3, 'alpha three');

  await store.appendEvents(conversationId, [evt1, evt2, evt3]);

  const summaryId = createSummaryNodeId('sum_active_alpha');
  state.summaryNodesById.set(summaryId, {
    id: summaryId,
    conversationId,
    kind: 'leaf',
    content: 'active alpha summary',
    tokenCount: createTokenCount(5),
    artifactIds: [],
    createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
  });
  state.summaryNodeIdsByConversation.set(conversationId, [summaryId]);
  state.leafMessageEdgesBySummary.set(summaryId, [evt1.id, evt2.id]);
  state.contextItemsByConversation.set(conversationId, [
    createContextItem({
      conversationId,
      position: 0,
      ref: { type: 'summary', summaryId },
    }),
  ]);

  const page = await store.regexSearchEvents(conversationId, 'alpha', {
    offset: 0,
    limit: 2,
  });

  expect(page.totalMatchCount).toBe(3);
  expect(page.matches.map((match) => match.eventId)).toEqual([evt1.id, evt2.id]);
  expect(page.matches.every((match) => match.coveringSummaryId === summaryId)).toBe(true);
});
```

- [ ] **Step 2: Run the in-memory ledger-store test to confirm the current adapter fails**

Run: `pnpm vitest run packages/adapters/src/storage/in-memory/__tests__/in-memory-ledger-store.test.ts`

Expected: FAIL because `regexSearchEvents()` still accepts `scope?: SummaryNodeId` and returns the full flat array without `totalMatchCount`.

- [ ] **Step 3: Implement active-coverage lookup and page slicing in the in-memory store**

```ts
const buildActiveCoverageByEventId = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): ReadonlyMap<EventId, SummaryNodeId> => {
  const coverage = new Map<EventId, SummaryNodeId>();
  const items = [...(state.contextItemsByConversation.get(conversationId) ?? [])].sort(
    (left, right) => left.position - right.position,
  );

  for (const item of items) {
    if (item.ref.type !== 'summary') {
      continue;
    }

    for (const messageId of expandSummaryToMessageIds(state, item.ref.summaryId)) {
      if (!coverage.has(messageId)) {
        coverage.set(messageId, item.ref.summaryId);
      }
    }
  }

  return coverage;
};

async regexSearchEvents(
  conversationId: ConversationId,
  pattern: string,
  page: RegexSearchPageInput,
): Promise<RegexSearchPageOutput> {
  const regex = new RegExp(pattern);
  const events = sortEventsBySequence(this.state.ledgerEventsByConversation.get(conversationId) ?? []);
  const scopedMessageIds = page.scope ? collectScopedMessageIds(this.state, page.scope) : null;
  const activeCoverage = page.scope ? null : buildActiveCoverageByEventId(this.state, conversationId);

  const matches: LedgerReadGrepMatch[] = [];

  for (const event of events) {
    if (scopedMessageIds !== null && !scopedMessageIds.has(event.id)) {
      continue;
    }

    const match = regex.exec(event.content);
    if (!match || match.index === undefined) {
      continue;
    }

    matches.push({
      eventId: event.id,
      sequence: event.sequence,
      excerpt: createExcerpt(event.content, match.index, match[0]?.length ?? 0),
      ...(page.scope !== undefined
        ? { coveringSummaryId: page.scope }
        : activeCoverage?.get(event.id) === undefined
          ? {}
          : { coveringSummaryId: activeCoverage.get(event.id)! }),
    });
  }

  return {
    matches: matches.slice(page.offset, page.offset + page.limit),
    totalMatchCount: matches.length,
  };
}
```

- [ ] **Step 4: Run the in-memory adapter test again**

Run: `pnpm vitest run packages/adapters/src/storage/in-memory/__tests__/in-memory-ledger-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the in-memory adapter parity work**

```bash
git add \
  packages/adapters/src/storage/in-memory/in-memory-ledger-store.ts \
  packages/adapters/src/storage/in-memory/__tests__/in-memory-ledger-store.test.ts
git commit -m "feat(adapters): add paged grouped in-memory grep"
```

### Task 3: Push the same semantics into PostgreSQL

**Files:**
- Modify: `packages/infrastructure/src/postgres/pg-ledger-store.ts`
- Modify: `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`
- Test: `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

- [ ] **Step 1: Add a failing PostgreSQL test for current-summary coverage and total counts**

```ts
it('returns paged unscoped regex matches tagged with the active covering summary', async () => {
  const harness = await createPostgresTestHarness();

  try {
    const fixture = await setupScopedSearchFixture(harness);

    await harness.context.appendContextItems(fixture.conversationId, [
      createContextItem({
        conversationId: fixture.conversationId,
        position: 0,
        ref: { type: 'summary', summaryId: fixture.scopedSummaryId },
      }),
    ]);

    const page = await harness.ledger.regexSearchEvents(fixture.conversationId, 'alpha', {
      offset: 0,
      limit: 1,
    });

    expect(page.totalMatchCount).toBe(4);
    expect(page.matches).toHaveLength(1);
    expect(page.matches[0]?.coveringSummaryId).toBe(fixture.scopedSummaryId);
  } finally {
    await harness.destroy();
  }
});
```

- [ ] **Step 2: Run the PostgreSQL ledger-store test to confirm failure**

Run: `pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

Expected: FAIL because the SQL path still returns every match and only tags coverage when `scope` is explicitly supplied.

- [ ] **Step 3: Implement a SQL query that resolves active coverage and applies `OFFSET` / `LIMIT`**

```sql
WITH RECURSIVE active_summary_refs AS (
  SELECT ci.summary_id, ci.position
  FROM context_items ci
  WHERE ci.conversation_id = $1
    AND ci.summary_id IS NOT NULL
),
active_summary_scope AS (
  SELECT
    asr.summary_id AS covering_summary_id,
    asr.summary_id AS source_summary_id,
    asr.position,
    ARRAY[asr.summary_id]::text[] AS path
  FROM active_summary_refs asr

  UNION ALL

  SELECT
    ass.covering_summary_id,
    spe.parent_summary_id AS source_summary_id,
    ass.position,
    ass.path || spe.parent_summary_id
  FROM active_summary_scope ass
  JOIN summary_parent_edges spe ON spe.summary_id = ass.source_summary_id
  WHERE NOT spe.parent_summary_id = ANY(ass.path)
),
active_message_coverage AS (
  SELECT DISTINCT ON (sme.message_id)
    sme.message_id,
    ass.covering_summary_id
  FROM active_summary_scope ass
  JOIN summary_message_edges sme ON sme.summary_id = ass.source_summary_id
  ORDER BY sme.message_id, ass.position ASC, ass.covering_summary_id ASC
),
scoped_summaries AS (
  SELECT $3::text AS summary_id
  WHERE $3::text IS NOT NULL

  UNION ALL

  SELECT spe.parent_summary_id AS summary_id
  FROM summary_parent_edges spe
  JOIN scoped_summaries ss ON spe.summary_id = ss.summary_id
),
scoped_messages AS (
  SELECT sme.message_id
  FROM summary_message_edges sme
  JOIN scoped_summaries ss ON ss.summary_id = sme.summary_id
),
matched AS (
  SELECT
    le.id,
    le.seq,
    le.content,
    regexp_instr(
      CASE
        WHEN le.role = 'system' AND le.content LIKE '__SYSTEM_PROMPT__%' THEN substring(le.content FROM 16)
        ELSE le.content
      END,
      $2,
      1,
      1,
      0,
      'n'
    ) AS match_start,
    COALESCE(length(substring(le.content FROM $2)), 0) AS match_length,
    CASE
      WHEN $3::text IS NOT NULL THEN $3::text
      ELSE amc.covering_summary_id
    END AS covering_summary_id
  FROM ledger_events le
  LEFT JOIN active_message_coverage amc ON amc.message_id = le.id
  WHERE le.conversation_id = $1
    AND (
      $3::text IS NULL
      OR le.id IN (SELECT message_id FROM scoped_messages)
    )
    AND regexp_instr(
      CASE
        WHEN le.role = 'system' AND le.content LIKE '__SYSTEM_PROMPT__%' THEN substring(le.content FROM 16)
        ELSE le.content
      END,
      $2,
      1,
      1,
      0,
      'n'
    ) > 0
),
paged AS (
  SELECT *,
         COUNT(*) OVER() AS total_match_count
  FROM matched
  ORDER BY seq ASC
  OFFSET $4
  LIMIT $5
)
SELECT * FROM paged;
```

```ts
async regexSearchEvents(
  conversationId: ConversationId,
  pattern: string,
  page: RegexSearchPageInput,
): Promise<RegexSearchPageOutput> {
  const result = await this.executor.query<RegexMatchRow>(sql, [
    conversationId,
    pattern,
    toScopedSummary(page.scope),
    page.offset,
    page.limit,
  ]);

  const totalMatchCount =
    result.rows.length === 0 ? 0 : Number(result.rows[0]?.total_match_count ?? 0);

  return {
    matches: result.rows.map((row) => ({
      eventId: createEventId(row.id),
      sequence: toEventSequenceNumber(row.seq),
      excerpt: createExcerpt(row.content, Math.max(0, row.match_start - 1), row.match_length),
      ...(row.covering_summary_id === null ? {} : { coveringSummaryId: createSummaryNodeId(row.covering_summary_id) }),
    })),
    totalMatchCount,
  };
}
```

- [ ] **Step 4: Run the PostgreSQL adapter test after the SQL change**

Run: `pnpm vitest run packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the PostgreSQL parity change**

```bash
git add \
  packages/infrastructure/src/postgres/pg-ledger-store.ts \
  packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts
git commit -m "feat(infrastructure): paginate postgres grep results"
```

---

## Chunk 3: Tooling, SDK, And Regression Surface

### Task 4: Thread the new grep contract through SDK, tools, and regressions

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/adapters/src/tools/canonical-memory-tool-catalog.ts`
- Modify: `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts`
- Modify: `packages/adapters/src/tools/shared/reference-derivation.ts`
- Modify: `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts`
- Modify: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts`
- Modify: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts`
- Modify: `packages/mcp-server/src/__tests__/tool-registry.test.ts`
- Modify: `packages/mcp-server/src/__tests__/server.integration.test.ts`
- Modify: `packages/claude-code/src/__tests__/pre-compact.test.ts`
- Modify: `packages/claude-code/src/__tests__/post-tool-use.test.ts`
- Modify: `packages/claude-code/src/__tests__/stop.test.ts`
- Modify: `tests/regression/sdk-lifecycle.e2e.test.ts`
- Modify: `tests/regression/postgres-adapter.regression.test.ts`
- Modify: `tests/regression/operator-tool-surface.test.ts`
- Test: `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts`
- Test: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts`
- Test: `packages/mcp-server/src/__tests__/server.integration.test.ts`
- Test: `tests/regression/sdk-lifecycle.e2e.test.ts`
- Test: `tests/regression/postgres-adapter.regression.test.ts`

- [ ] **Step 1: Write failing tool and regression assertions for the new grep envelope**

```ts
// packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts
it('returns grouped page data and derives summary + event references', async () => {
  const { engine, grep } = createMinimalEngine();
  const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

  grep.mockResolvedValueOnce({
    groups: [
      {
        coveringSummaryId: createSummaryNodeId('sum_scope_1'),
        matches: [
          {
            eventId: createEventId('evt_100'),
            sequence: createSequenceNumber(1),
            excerpt: 'alpha',
          },
        ],
      },
    ],
    page: {
      offset: 0,
      limit: 25,
      returnedMatchCount: 1,
      totalMatchCount: 1,
      hasMore: false,
    },
  });

  const result = await getToolSetTool(tools, 'memory.grep').execute({
    query: 'alpha',
    scope: 'sum_scope_1',
    offset: 0,
    limit: 25,
  });

  const envelope = assertSuccessEnvelope(result, {
    groups: [
      {
        coveringSummaryId: createSummaryNodeId('sum_scope_1'),
        matches: [
          {
            eventId: createEventId('evt_100'),
            sequence: createSequenceNumber(1),
            excerpt: 'alpha',
          },
        ],
      },
    ],
    page: {
      offset: 0,
      limit: 25,
      returnedMatchCount: 1,
      totalMatchCount: 1,
      hasMore: false,
    },
  });

  expect(envelope.references).toEqual({
    summaryIds: ['sum_scope_1'],
    eventIds: ['evt_100'],
    conversationIds: ['conv_runtime'],
  });
});

// tests/regression/sdk-lifecycle.e2e.test.ts
const grep = await engine.grep({ conversationId, pattern: 'PostgreSQL', limit: 10 });
const flatMatches = grep.groups.flatMap((group) => group.matches);
expect(flatMatches.length).toBeGreaterThan(0);
expect(grep.page.limit).toBe(10);
```

- [ ] **Step 2: Run the focused tool/regression tests to confirm type and shape failures**

Run: `pnpm vitest run packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts packages/mcp-server/src/__tests__/server.integration.test.ts tests/regression/sdk-lifecycle.e2e.test.ts tests/regression/postgres-adapter.regression.test.ts`

Expected: FAIL because the test fixtures, reference derivation, and tool schemas still assume `output.matches`.

- [ ] **Step 3: Add pagination fields to tool schemas and propagate them into `engine.grep()`**

```ts
const grepParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: 'Query string used to recall relevant memory events.',
    },
    scope: {
      type: 'string',
      description: 'Optional summary ID scope for narrowing recall results.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Zero-based match offset for pagination.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum number of matches to return in one page.',
    },
  },
  required: ['query'],
};

const grepInput: GrepInput = {
  conversationId: callerContext.conversationId,
  pattern: query,
  ...(scope === undefined ? {} : { scope: createSummaryNodeId(scope) }),
  ...(offset === undefined ? {} : { offset }),
  ...(limit === undefined ? {} : { limit }),
};
```

- [ ] **Step 4: Flatten grouped output when deriving references**

```ts
const flattenGrepMatches = (output: GrepOutput): readonly GrepMatch[] => {
  return output.groups.flatMap((group) => group.matches);
};

const collectGrepSummaryIds = (output: GrepOutput): readonly string[] | undefined => {
  const summaryIds = output.groups
    .map((group) => group.coveringSummaryId)
    .filter((summaryId): summaryId is SummaryNodeId => summaryId !== undefined)
    .map((summaryId) => String(summaryId));

  return mergeReferenceArrays([summaryIds]);
};

export const deriveRecallReferences = (
  scope: string | undefined,
  output: GrepOutput,
): ToolReferences | undefined => {
  const eventIds = mergeReferenceArrays([
    flattenGrepMatches(output).map((match) => String(match.eventId)),
  ]);
  const groupedSummaryIds = collectGrepSummaryIds(output);
  const summaryIds = mergeReferenceArrays([
    scope === undefined ? undefined : [scope],
    groupedSummaryIds,
  ]);

  if (summaryIds === undefined && eventIds === undefined) {
    return undefined;
  }

  return {
    ...(summaryIds === undefined ? {} : { summaryIds }),
    ...(eventIds === undefined ? {} : { eventIds }),
  };
};
```

- [ ] **Step 5: Update the remaining minimal grep stubs and regressions to the new type**

```ts
const emptyGrepOutput: GrepOutput = {
  groups: [],
  page: {
    offset: 0,
    limit: 25,
    returnedMatchCount: 0,
    totalMatchCount: 0,
    hasMore: false,
  },
};

const grep = vi.fn(async (_input: GrepInput): Promise<GrepOutput> => {
  void _input;
  return emptyGrepOutput;
});
```

Use this exact shape everywhere a minimal engine stub currently returns `{ matches: [] }`.

- [ ] **Step 6: Run the focused tool and regression suite again**

Run: `pnpm vitest run packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts packages/mcp-server/src/__tests__/tool-registry.test.ts packages/mcp-server/src/__tests__/server.integration.test.ts packages/claude-code/src/__tests__/pre-compact.test.ts packages/claude-code/src/__tests__/post-tool-use.test.ts packages/claude-code/src/__tests__/stop.test.ts tests/regression/sdk-lifecycle.e2e.test.ts tests/regression/postgres-adapter.regression.test.ts tests/regression/operator-tool-surface.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the outward-facing grep contract migration**

```bash
git add \
  packages/sdk/src/index.ts \
  packages/adapters/src/tools/canonical-memory-tool-catalog.ts \
  packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts \
  packages/adapters/src/tools/shared/reference-derivation.ts \
  packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts \
  packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts \
  packages/adapters/src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts \
  packages/mcp-server/src/__tests__/tool-registry.test.ts \
  packages/mcp-server/src/__tests__/server.integration.test.ts \
  packages/claude-code/src/__tests__/pre-compact.test.ts \
  packages/claude-code/src/__tests__/post-tool-use.test.ts \
  packages/claude-code/src/__tests__/stop.test.ts \
  tests/regression/sdk-lifecycle.e2e.test.ts \
  tests/regression/postgres-adapter.regression.test.ts \
  tests/regression/operator-tool-surface.test.ts
git commit -m "feat(tools): expose paged grouped grep contract"
```

---

## Chunk 4: Docs, Build Sync, And Verification

### Task 5: Update the HLD/testing docs and run final verification

**Files:**
- Modify: `docs/high-level-design.md`
- Modify: `docs/testing-strategy.md`
- Possibly update generated build-synced files listed above if `pnpm build` regenerates them
- Test: repo verification commands

- [ ] **Step 1: Update the HLD grep contract to the implemented shape**

````md
#### GrepUseCase

```typescript
interface GrepInput {
  conversationId: ConversationId;
  pattern: string;
  scope?: SummaryNodeId;
  offset?: number;
  limit?: number;
}
interface GrepOutput {
  groups: GrepGroup[];
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

**Implementation contract:** the engine returns matches ordered by ascending event sequence, paginated via `offset` / `limit`, and grouped by the summary node that currently covers each returned match. When a `scope` is provided, returned matches are grouped under that scope.
````

Also update the direct API example near the Appendix A SDK sample so it no longer implies `grepResult.matches`.

- [ ] **Step 2: Update the testing-strategy example that still flattens grep output directly**

```ts
const grepResult = await engine.grep({ conversationId, pattern: 'specific-term', limit: 10 });
const matches = grepResult.groups.flatMap((group) => group.matches);

expect(matches.length).toBeGreaterThan(0);
expect(grepResult.page.limit).toBe(10);
```

- [ ] **Step 3: Run the build so tracked JS/DTS mirrors stay in sync**

Run: `pnpm build`

Expected: PASS. If tracked JS/DTS companions changed, include them in the commit instead of hand-editing them separately.

- [ ] **Step 4: Run the final quality gates**

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm lint`

Expected: PASS.

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 5: Commit docs and verification fallout**

```bash
git add \
  docs/high-level-design.md \
  docs/testing-strategy.md \
  packages/sdk/src/index.js \
  packages/sdk/src/index.d.ts \
  packages/adapters/src/index.js \
  packages/adapters/src/index.d.ts \
  packages/adapters/src/storage/in-memory/in-memory-ledger-store.js \
  packages/adapters/src/storage/in-memory/in-memory-ledger-store.d.ts
git commit -m "docs: sync grep contract with appendix c1"
```

Only stage the generated files above if `pnpm build` actually modified them.

---

## Self-Review

- **Spec coverage:** Task 1 changes the public grep contract, Task 2 and Task 3 provide adapter parity, Task 4 updates every outward-facing tool/SDK/regression surface, and Task 5 removes the documented mismatch from the HLD/testing docs.
- **Placeholder scan:** No `TODO`, `TBD`, “handle edge cases,” or “similar to Task N” placeholders remain; every task includes concrete files, commands, and code snippets.
- **Type consistency:** The plan uses the same field names everywhere: `offset`, `limit`, `groups`, `page`, `returnedMatchCount`, `totalMatchCount`, `hasMore`, `nextOffset`, and `coveringSummaryId`.

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-grep-appendix-c1-alignment.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
