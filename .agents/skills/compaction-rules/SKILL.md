---
name: compaction-rules
description: Compaction loop algorithm, escalation chain (L1/L2/L3), candidate selection, pin rules, deterministic fallback, and convergence guarantees.
---

# Compaction & Escalation Rules

## Compaction Loop

```
1. Compute currentTokens from context projection
2. target = available_budget × (1 - targetFreePercentage)
3. round = 0
4. WHILE currentTokens > target AND round < maxRounds:
     a. candidates = selectCandidates(contextItems, pinRules)
     b. IF candidates empty → break (nothing compactable)
     c. level = 1
     d. WHILE level <= 3:
          summarize at current level
          IF shouldEscalate(inputTokens, outputTokens): level++
          ELSE: break
     e. Create SummaryNode + DAG edges
     f. Replace context items with summary pointer
     g. round++
5. IF hard trigger AND still over budget → CompactionFailedToConverge
```

## Candidate Selection

```
selectCandidates(contextItems, pinRules):
  unpinned = filter out pinned items
  sort by position (ascending = oldest first)
  build contiguous block from front until BLOCK_TOKEN_TARGET reached
  return block if length >= minBlockSize, else []
```

### Pin Rules — Item is pinned if ANY of:
1. Role is `system`
2. Within **tail window** (last N items, default N=3)
3. Explicitly pinned by caller via `PinRule`

## Escalation Contract

| Level | Mode | Condition to Accept | On Failure |
|-------|------|-------------------|------------|
| 1 | Normal | `outputTokens < inputTokens` | → Level 2 |
| 2 | Aggressive | `outputTokens < inputTokens` | → Level 3 |
| 3 | Deterministic | Always succeeds (≤512 tokens) | N/A |

**shouldEscalate()**: `outputTokens >= inputTokens` → escalate (NOT retry)

## Deterministic Fallback (Level 3)

- Head-only truncation to ≤512 tokens
- No LLM call — pure string manipulation + tokenizer
- Includes truncation marker in token budget
- Marker: `"\n\n[... truncated — use memory.expand(summary_id) for full content ...]"`
- Guaranteed to terminate

## Configuration Defaults

```typescript
{
  maxRounds: 10,
  blockTokenTargetFraction: 0.25,
  minBlockSize: 2,
  tailWindowSize: 3,
  targetFreePercentage: 0.15
}
```

## Artifact ID Propagation

When creating any summary node:
- **Leaf**: artifactIds = union of artifact refs in covered messages
- **Condensed**: artifactIds = union of all parent summaries' artifactIds
- NEVER lose an artifact ID through compaction

## Context Versioning

- `replaceContextItems` requires `expectedVersion`
- Version mismatch → `StaleContextError`
- Application retries compaction round from top on StaleContextError
