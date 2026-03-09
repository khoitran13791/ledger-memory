# Task: Fix 5 PostgreSQL Adapter Issues in LedgerMind

You are working on the LedgerMind project — a clean architecture memory engine for LLM agents. A verification of the PostgreSQL adapter (`packages/infrastructure/src/postgres/`) against the HLD (`docs/high-level-design.md`) and addendum (`docs/design-decisions-addendum.md`) found 5 issues. Fix all of them.

**IMPORTANT:** Read each file mentioned before modifying. Follow existing code conventions (pure functions for helpers, `mapPgError` for error mapping, `PgExecutor` injection, row type interfaces). Run `npx turbo run test --filter=@ledgermind/infrastructure` and `npx turbo run build --filter=@ledgermind/infrastructure` after all changes to ensure all existing 93+ tests still pass. Add new tests for new/changed behavior.

---

## Issue 1 (HIGH): Sequence allocation race condition in PgLedgerStore

File: `packages/infrastructure/src/postgres/pg-ledger-store.ts`

### Problem

In both `getNextSequence()` (line ~280) and `appendEvents()` (line ~153), the query `SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence` runs without row-level locking. Two concurrent transactions can compute the same next sequence number, causing one to fail with `NonMonotonicSequenceError`.

### Fix

Add a `SELECT id FROM conversations WHERE id = $1 FOR UPDATE` query **before** the `MAX(seq)` query in both methods. This acquires a row-level lock on the conversation row, serializing concurrent writers per conversation within the transaction boundary. No schema changes needed.

Apply the lock in:
- `getNextSequence()` — add the FOR UPDATE query before the MAX(seq) query
- `appendEvents()` — add the FOR UPDATE query at the start of the method, before the sequence computation

---

## Issue 2 (HIGH): Scoped search CTE walks ancestors instead of descendants

File: `packages/infrastructure/src/postgres/pg-ledger-store.ts`

### Problem

In `searchEvents()` (line ~330) and `regexSearchEvents()` (line ~369), the recursive CTE `scoped_summaries` walks from a summary **upward to its parents** via:

```sql
SELECT spe.parent_summary_id
FROM summary_parent_edges spe
JOIN scoped_summaries ss ON spe.summary_id = ss.summary_id
```

But scoping should collect **descendant** summaries (walk downward to children) to find leaf messages covered by the subtree. The current direction means scoped queries on condensed summaries return wrong/empty results.

### Fix

Reverse the CTE direction in both `searchEvents` and `regexSearchEvents`. Change the recursive step to walk **children** — find summaries whose `parent_summary_id` matches the current scope:

```sql
WITH RECURSIVE scoped_summaries AS (
  SELECT $3::text AS summary_id
  WHERE $3::text IS NOT NULL

  UNION ALL

  SELECT spe.summary_id
  FROM summary_parent_edges spe
  JOIN scoped_summaries ss ON spe.parent_summary_id = ss.summary_id
)
```

This walks from the given summary **downward** through the DAG to find all descendant summaries, then their leaf edges link to the actual messages. The rest of the query (joining `scoped_messages` via `summary_message_edges`) remains the same.

Apply this fix to both:
1. `searchEvents()` — the `scoped_summaries` CTE
2. `regexSearchEvents()` — the `scoped_summaries` CTE

---

## Issue 3 (MEDIUM): Ledger appendEvents should use INSERT ON CONFLICT for event ID idempotency

File: `packages/infrastructure/src/postgres/pg-ledger-store.ts`

### Problem

Lines ~168-177 in `appendEvents()` do a `SELECT id FROM ledger_events WHERE id = $1` existence check before each insert. This is not atomic and adds an extra round-trip per event. The HLD §9.1 specifies "INSERT with ON CONFLICT DO NOTHING for idempotency."

### Fix

1. Remove the pre-check `SELECT id FROM ledger_events WHERE id = $1` query
2. Change the INSERT statement to use `ON CONFLICT (id) DO NOTHING`
3. Check the result's `rowCount` — if `rowCount === 0`, the event already exists (duplicate), skip it and do NOT increment `expectedSequence`
4. Keep the `idempotency_key` pre-check logic as-is (it needs digest comparison which can't be done with simple ON CONFLICT)

---

## Issue 4 (MEDIUM): Add tests for concurrent sequence allocation

File: `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

### Implementation

Check the existing test harness in `packages/infrastructure/src/postgres/__tests__/postgres-test-harness.ts` for setup patterns and pool access.

Add at least one test that verifies the `FOR UPDATE` lock prevents duplicate sequences when two transactions attempt concurrent appends:

1. Create a conversation
2. Start two concurrent append operations (use `Promise.all`) with different events targeting the same conversation
3. Verify both succeed without throwing `NonMonotonicSequenceError`
4. Read all events back and verify sequences are contiguous (1, 2, 3, ...) with no gaps or duplicates

If direct pool/client access is needed for manual transaction control, check how existing tests access the PG pool from the test harness.

---

## Issue 5 (MEDIUM): Add tests for scoped search correctness

File: `packages/infrastructure/src/postgres/__tests__/pg-ledger-store.test.ts`

### Implementation

Add tests for both `searchEvents` and `regexSearchEvents` with scope parameter:

1. Create a conversation with 4+ events (ensure content has searchable terms)
2. Create a leaf summary node covering events 1-2 (via `summary_message_edges`)
3. Create a condensed summary node covering the leaf summary (via `summary_parent_edges`)
4. Create another leaf summary covering events 3-4 (not under the condensed summary)
5. Call `searchEvents(conversationId, query, condensedSummaryId)` — verify only events 1-2 are returned
6. Call `regexSearchEvents(conversationId, pattern, condensedSummaryId)` — verify only events 1-2 match
7. Call without scope — verify all matching events are returned

Use the `PgSummaryDag` adapter (already available in test harness) to create the summary nodes and edges.

---

## Verification checklist

After implementing all 5 fixes:

- [ ] `npx turbo run build --filter=@ledgermind/infrastructure` — no type errors
- [ ] `npx turbo run test --filter=@ledgermind/infrastructure` — all tests pass (existing + new)
- [ ] Concurrent append test passes without `NonMonotonicSequenceError`
- [ ] Scoped search test returns only messages within the summary subtree
- [ ] No regressions in existing 93 tests
