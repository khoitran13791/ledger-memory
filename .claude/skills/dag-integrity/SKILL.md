---
name: dag-integrity
description: The 8 DAG integrity checks, their error types, and the IntegrityReport structure. Reference when implementing or testing checkIntegrity().
---

# DAG Integrity Checks

## The 8 Checks

| # | Name | What It Verifies | Error Type |
|---|------|-----------------|------------|
| 1 | **no_orphan_edges** | Every `summary_message_edges.message_id` exists in `ledger_events`; every `summary_parent_edges.parent_summary_id` exists in `summary_nodes` | `DanglingEdgeError` |
| 2 | **no_orphan_context_refs** | Every `context_items.message_id` exists in `ledger_events`; every `context_items.summary_id` exists in `summary_nodes` | `DanglingContextRefError` |
| 3 | **acyclic_dag** | Recursive walk from any node never visits the same node twice | `CycleDetectedError` |
| 4 | **leaf_coverage** | Every summary node with `kind='leaf'` has ≥1 message edge | `EmptyLeafError` |
| 5 | **condensed_coverage** | Every summary node with `kind='condensed'` has ≥1 parent edge | `EmptyCondensedError` |
| 6 | **contiguous_positions** | Context item positions form `[0, 1, 2, ..., N-1]` with no gaps | `NonContiguousContextError` |
| 7 | **monotonic_sequence** | Ledger event sequences are strictly monotonically increasing with no gaps | `NonMonotonicSequenceError` |
| 8 | **artifact_propagation** | For every summary whose sources reference artifacts, `artifact_ids` contains the union of all source artifact IDs | `LostArtifactIdError` |

## IntegrityReport Type

```typescript
interface IntegrityReport {
  readonly passed: boolean;
  readonly checks: IntegrityCheckResult[];
}

interface IntegrityCheckResult {
  readonly name: string;         // e.g., "acyclic_dag"
  readonly passed: boolean;
  readonly details?: string;     // human-readable on failure
  readonly affectedIds?: string[]; // problematic entity IDs
}
```

## When to Run

- After every compaction round in tests
- As part of golden test assertions
- In conformance suite (run against all adapters)
- On-demand via `SummaryDagPort.checkIntegrity(conversationId)`

## Implementation Notes

- Check 3 (acyclic) uses recursive CTE in PostgreSQL; iterative walk in in-memory
- Check 8 (artifact propagation) requires walking from condensed → parents → leaf → messages
- All checks should be independent (run all, report all failures, not fail-fast)
- `passed` is `true` only if ALL 8 checks pass
