---
name: ids-and-hashing
description: Content-addressed ID canonicalization rules — SHA-256 hashing, sorted-key JSON, prefix conventions, excluded fields, and duplicate handling semantics.
---

# ID Canonicalization & Hashing Rules

## ID Format

```
id = prefix + "_" + hex(SHA-256(canonicalBytes))
```

Where `canonicalBytes` = UTF-8 encoding of stable JSON string.

## Canonical JSON Rules

1. Keys sorted lexicographically (ASCII order)
2. No whitespace between tokens (`JSON.stringify` with no spacer)
3. Unicode escaping follows `JSON.stringify` defaults
4. `undefined` values omitted (standard JSON behavior)
5. Numbers serialized as JSON numbers (no trailing zeros)

## Per-Entity Hashing

| Entity | Prefix | Hashed Fields | EXCLUDED from hash |
|--------|--------|---------------|-------------------|
| **LedgerEvent** | `evt` | `{ content, conversationId, role }` | `sequence`, `occurredAt`, `metadata` |
| **SummaryNode** | `sum` | `{ content, conversationId, kind }` | `createdAt`, `tokenCount`, `artifactIds` |
| **Artifact** | `file` | `{ contentHash }` where contentHash = hex(SHA-256(rawBytes)) | `originalPath`, `mimeType`, `tokenCount` |

## Why These Fields?

- Including `conversationId` prevents cross-conversation ID collisions
- Including `role` prevents same-content different-role collisions
- Excluding timestamps ensures "same content → same ID across runs"
- Excluding sequence numbers allows recomputation

## HashPort Interface

```typescript
interface HashPort {
  sha256(input: Uint8Array): string;  // returns hex string
}
```

Domain's `IdService` uses `HashPort` — NEVER imports `crypto` directly.

## Duplicate/Collision Handling

| Entity | Behavior |
|--------|----------|
| **LedgerEvent** | Duplicate IDs within same conversation rejected (`ON CONFLICT DO NOTHING`). `idempotencyKey` provides additional dedup. |
| **SummaryNode** | Duplicate IDs treated as idempotent (`ON CONFLICT DO NOTHING`). DAG edges are what matter. |
| **Artifact** | Content-addressed by raw bytes. Same content = same ID. Re-storing is a no-op. |

## Idempotency Key Semantics

| Scenario | Behavior |
|----------|----------|
| Same key, same content | No-op, return success |
| Same key, different content | Throw `IdempotencyConflictError` |
| Different key, same content | Both stored (different idempotency keys) |
| No key provided | No idempotency dedup (content-hash dedup still applies) |
