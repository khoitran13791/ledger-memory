# LedgerMind: Design Decisions Addendum

> **Pre-Implementation Gap Resolution**
> Version: 1.0 | Date: February 26, 2026 | Status: Accepted
>
> This document resolves ambiguities and underspecified areas in the
> High-Level Design document that would block Phase 1 implementation.

---

## Table of Contents

1. [ID Canonicalization & Hashing Rules](#1-id-canonicalization--hashing-rules)
2. [LedgerEvent Representation](#2-ledgerevent-representation)
3. [Context Projection Concurrency](#3-context-projection-concurrency)
4. [DAG Integrity Checks (Enumerated)](#4-dag-integrity-checks-enumerated)
5. [Compaction Block Definition](#5-compaction-block-definition)
6. [Deterministic Fallback Specification](#6-deterministic-fallback-specification)
7. [Summarizer Test Stub Contract](#7-summarizer-test-stub-contract)
8. [Technology Stack](#8-technology-stack)
9. [Minor Fixes to HLD](#9-minor-fixes-to-hld)

---

## 1. ID Canonicalization & Hashing Rules

### Decision

All content-addressed IDs use **SHA-256 over a canonical byte string** derived
from a deterministic subset of fields. Timestamps are **excluded** from
hashing to guarantee "same content → same ID across runs." For `LedgerEvent`,
`sequence` is included to prevent collisions when identical content appears
multiple times in the same conversation.

### Canonical Serialization

IDs are produced by:

```
id = prefix + "_" + hex(SHA-256(canonicalBytes))
```

Where `canonicalBytes` is a UTF-8 encoding of a **stable JSON string** built
with these rules:

1. Keys are sorted lexicographically (ASCII order).
2. No whitespace between tokens (`JSON.stringify` with no spacer).
3. Unicode escaping follows `JSON.stringify` defaults (no custom escaping).
4. `undefined` values are omitted (standard JSON behavior).
5. Numbers are serialized as JSON numbers (no trailing zeros beyond spec).

### Per-Entity Hashing Inputs

| Entity | Prefix | Hashed Fields | Excluded |
|--------|--------|---------------|----------|
| **LedgerEvent** | `evt` | `{ content, conversationId, role, sequence }` | `occurredAt`, `metadata` |
| **SummaryNode** | `sum` | `{ content, conversationId, kind }` | `createdAt`, `tokenCount`, `artifactIds` |
| **Artifact** | `file` | `{ contentHash }` where `contentHash = hex(SHA-256(rawBytes))` | `originalPath`, `mimeType`, `tokenCount` |

**Note on LedgerEvent:** Including `conversationId` and `role` prevents
cross-conversation ID collisions for identical content (e.g., the same user
message in two conversations gets different IDs). Including `sequence`
distinguishes repeated same-content messages within a single conversation.

### Collision / Duplicate Handling

- **LedgerEvent**: Duplicate IDs within the same conversation are rejected
  (`INSERT ... ON CONFLICT DO NOTHING`). The `idempotencyKey` field provides
  an additional application-level deduplication mechanism for callers.
- **SummaryNode**: Duplicate summary IDs are possible if identical content is
  generated for the same conversation. Treat as idempotent (`ON CONFLICT DO
  NOTHING`) — the DAG edges are what matter.
- **Artifact**: Content-addressed by raw bytes. Same file content = same ID.
  Re-storing is a no-op.

### HashPort Interface

```typescript
// domain/services/id.service.ts (canonical definition)
// Re-exported via application/ports/driven/crypto/hash.port.ts
interface HashPort {
  sha256(input: Uint8Array): string;  // returns hex string
}
```

`HashPort` is defined in the domain layer alongside `IdService` (which depends on it).
The application layer re-exports it from `application/ports/driven/crypto/hash.port.ts`
for convenience. Domain never imports `crypto` directly.

---

## 2. LedgerEvent Representation

### Decision

Phase 1 uses a **single-table design** with a `content: string` column and an
optional `metadata: JSON` column. No `message_parts` normalization.

### Rationale

- The Volt `message_parts` table exists to support multi-part messages
  (text + tool-call + tool-result in one turn). In LedgerMind, each part is a
  separate `LedgerEvent` with its own role and sequence number.
- This simplifies the schema, keeps events truly atomic, and avoids the
  coupling that Volt's parts table introduced.
- If multi-part grouping is needed later, a `turnId` field can be added
  without schema migration (it's metadata, not structure).

### Event Roles and Content Rules

| Role | Content | Metadata |
|------|---------|----------|
| `system` | System prompt text | `{}` |
| `user` | User message text | `{}` |
| `assistant` | Assistant response text | `{ toolCalls?: ToolCallRef[] }` |
| `tool` | Tool result text/JSON | `{ toolName: string, toolCallId: string }` |

### Schema (Replaces HLD §11.1 `ledger_events`)

```sql
CREATE TABLE ledger_events (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  role            message_role NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL CHECK (token_count >= 0),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, idempotency_key)
);
```

This matches the HLD schema with the addition of a `metadata JSONB` column
and removal of any need for a `message_parts` table.

---

## 3. Context Projection Concurrency

### Decision

Add a **`version` column** to the context projection for optimistic
concurrency control. All mutations to context items must provide the
expected version; a mismatch triggers a retry.

### Updated Schema

```sql
CREATE TABLE context_versions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version         BIGINT NOT NULL DEFAULT 0
);
```

### Updated Port Interface

```typescript
interface ContextProjectionPort {
  getCurrentContext(conversationId: ConversationId): Promise<{
    items: ContextItem[];
    version: ContextVersion;
  }>;
  getContextTokenCount(conversationId: ConversationId): Promise<TokenCount>;
  appendContextItems(
    conversationId: ConversationId,
    items: ContextItem[],
  ): Promise<ContextVersion>;  // returns new version
  replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: number[],
    replacement: ContextItem,
  ): Promise<ContextVersion>;  // returns new version; throws StaleContextError on mismatch
}
```

### Value Object

```typescript
type ContextVersion = number & { readonly __brand: "ContextVersion" };
```

### Behavior

1. `appendContextItems` always succeeds (append is safe — new items get the
   next position after the current max).
2. `replaceContextItems` checks `expectedVersion` against current version.
   If they don't match → throw `StaleContextError` (application layer retries
   from the top of the compaction loop).
3. Version increments atomically with every mutation (append or replace).

---

## 4. DAG Integrity Checks (Enumerated)

### Decision

The "8 integrity checks" referenced in HLD §1.2 are defined as follows.
These are implemented as the `SummaryDagPort.checkIntegrity()` method and
run as part of the golden test suite.

| # | Check | SQL / Logic | Error |
|---|-------|-------------|-------|
| 1 | **No orphan edges** | Every `summary_message_edges.message_id` exists in `ledger_events`; every `summary_parent_edges.parent_summary_id` exists in `summary_nodes` | `DanglingEdgeError` |
| 2 | **No orphan context refs** | Every `context_items.message_id` exists in `ledger_events`; every `context_items.summary_id` exists in `summary_nodes` | `DanglingContextRefError` |
| 3 | **Acyclic DAG** | Recursive CTE from any node never visits the same node twice | `CycleDetectedError` |
| 4 | **Leaf covers ≥ 1 message** | Every `summary_nodes` with `kind = 'leaf'` has ≥ 1 row in `summary_message_edges` | `EmptyLeafError` |
| 5 | **Condensed covers ≥ 1 summary** | Every `summary_nodes` with `kind = 'condensed'` has ≥ 1 row in `summary_parent_edges` | `EmptyCondensedError` |
| 6 | **Contiguous context positions** | `context_items` positions for a conversation form `[0, 1, 2, ..., N-1]` with no gaps | `NonContiguousContextError` |
| 7 | **Monotonic ledger sequence** | `ledger_events.seq` for a conversation is strictly monotonically increasing with no gaps | `NonMonotonicSequenceError` |
| 8 | **Artifact ID propagation** | For every `summary_nodes` whose source messages/summaries reference artifacts, `artifact_ids` JSONB contains all those artifact IDs (union of sources) | `LostArtifactIdError` |

### IntegrityReport Type

```typescript
interface IntegrityReport {
  readonly passed: boolean;
  readonly checks: IntegrityCheckResult[];
}

interface IntegrityCheckResult {
  readonly name: string;         // e.g., "acyclic_dag"
  readonly passed: boolean;
  readonly details?: string;     // human-readable explanation on failure
  readonly affectedIds?: string[]; // IDs of problematic entities
}
```

---

## 5. Compaction Block Definition

### Decision

A **compaction block** is a contiguous sequence of the **oldest non-pinned
context items**, up to a configurable token target.

### Algorithm: `selectCandidates()`

```
function selectCandidates(contextItems, pinRules):
  unpinned = contextItems.filter(item => !isPinned(item, pinRules))

  if unpinned.length == 0:
    return []  // nothing to compact

  // Sort by position (oldest = lowest position)
  unpinned.sortBy(position, ascending)

  // Build a block from the front (oldest) up to BLOCK_TOKEN_TARGET
  block = []
  blockTokens = 0
  MIN_BLOCK_SIZE = 2       // never compact a single item
  BLOCK_TOKEN_TARGET = available_budget × 0.25  // compact ~25% of budget per round

  for item in unpinned:
    if blockTokens >= BLOCK_TOKEN_TARGET and block.length >= MIN_BLOCK_SIZE:
      break
    block.push(item)
    blockTokens += item.tokenCount

  return [{ items: block, tokenCount: blockTokens }]
```

### Pin Rules

Items are pinned if any of the following hold:

1. The item is the **system prompt** (position 0, if system role).
2. The item is within the **tail window** — the most recent N items
   (default: N = 3, configurable via `ConversationConfig`).
3. The item is explicitly pinned by the caller via `PinRule`.

### Configuration

```typescript
interface CompactionConfig {
  readonly maxRounds: number;              // default: 10
  readonly blockTokenTargetFraction: number; // default: 0.25
  readonly minBlockSize: number;           // default: 2
  readonly tailWindowSize: number;         // default: 3
  readonly targetFreePercentage: number;   // default: 0.15 (aim for 15% free after compaction)
}
```

---

## 6. Deterministic Fallback Specification

### Decision

Level 3 (deterministic fallback) uses **head-only truncation** to a
maximum of 512 tokens. No LLM call. Guaranteed to terminate.

### Algorithm

```
function deterministicFallback(content: string, tokenizer: TokenizerPort): string:
  MAX_TOKENS = 512
  MARKER = "\n\n[... truncated — use memory.expand(summary_id) for full content ...]"

  tokens = tokenizer.countTokens(content)
  if tokens.value <= MAX_TOKENS:
    return content  // already under limit

  // Binary search for the character cutoff that produces ≤ MAX_TOKENS
  // (accounts for marker tokens)
  markerTokens = tokenizer.countTokens(MARKER)
  targetTokens = MAX_TOKENS - markerTokens.value

  // Simple approach: estimate chars per token ratio, then verify
  ratio = content.length / tokens.value
  estimatedCutoff = floor(targetTokens * ratio)

  // Trim to last word boundary
  cutoff = content.lastIndexOf(' ', estimatedCutoff)
  if cutoff <= 0: cutoff = estimatedCutoff

  truncated = content.substring(0, cutoff) + MARKER

  // Verify and adjust if needed (should be within 1 iteration)
  while tokenizer.countTokens(truncated).value > MAX_TOKENS:
    cutoff = floor(cutoff * 0.9)
    cutoff = content.lastIndexOf(' ', cutoff)
    truncated = content.substring(0, cutoff) + MARKER

  return truncated
```

### Properties

- **Input:** any string content (raw messages concatenated, or a parent summary)
- **Output:** string ≤ 512 tokens, always
- **No LLM call:** pure string manipulation + tokenizer
- **Convergence guarantee:** since output ≤ 512 and `shouldEscalate()` only
  triggers when `outputTokens >= inputTokens`, and Level 3 output is bounded,
  the compaction loop always terminates

### Escalation Contract (All Levels)

| Level | Mode | Must Produce | On Failure |
|-------|------|-------------|------------|
| 1 | Normal | `output < input` tokens | Escalate to L2 |
| 2 | Aggressive | `output < input` tokens | Escalate to L3 |
| 3 | Deterministic | `output ≤ 512` tokens | N/A (always succeeds) |

**Post-hoc enforcement:** After L1 and L2 summarization, if the LLM output
is ≥ input tokens, the application layer does **not** accept it and escalates.
This is the `shouldEscalate()` check, not a retry.

---

## 7. Summarizer Test Stub Contract

### Decision

Phase 1 golden tests use a **deterministic summarizer** that produces
predictable output without LLM calls. Real LLM summarization is tested
separately in integration tests (not golden tests).

### DeterministicSummarizer Implementation

```typescript
class DeterministicSummarizer implements SummarizerPort {
  constructor(private tokenizer: TokenizerPort) {}

  async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
    const joined = input.messages.map(m => m.content).join("\n");
    const inputTokens = this.tokenizer.countTokens(joined);

    if (input.mode === "normal") {
      // Take first 60% of content (simulates a good summary)
      const target = Math.floor(joined.length * 0.6);
      const cutoff = joined.lastIndexOf(" ", target);
      const content = joined.substring(0, cutoff > 0 ? cutoff : target);
      return {
        content: `[Summary] ${content}`,
        tokenCount: this.tokenizer.countTokens(`[Summary] ${content}`),
        preservedArtifactIds: input.artifactIdsToPreserve,
      };
    }

    // Aggressive: take first 30% of content
    const target = Math.floor(joined.length * 0.3);
    const cutoff = joined.lastIndexOf(" ", target);
    const content = joined.substring(0, cutoff > 0 ? cutoff : target);
    return {
      content: `[Aggressive Summary] ${content}`,
      tokenCount: this.tokenizer.countTokens(`[Aggressive Summary] ${content}`),
      preservedArtifactIds: input.artifactIdsToPreserve,
    };
  }
}
```

### SimpleTokenizer (Test Stub)

```typescript
class SimpleTokenizer implements TokenizerPort {
  // 1 token ≈ 4 characters (rough GPT-family approximation)
  countTokens(text: string): TokenCount {
    return { value: Math.ceil(text.length / 4) } as TokenCount;
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return { value: Math.ceil(byteLength / 4) } as TokenCount;
  }
}
```

### Golden Test Requirements

1. All golden tests use `DeterministicSummarizer` + `SimpleTokenizer`.
2. Golden tests are **snapshot-stable** — same input always produces same
   IDs, same DAG structure, same materialized output.
3. Golden test fixtures are checked into `tests/golden/fixtures/`.
4. The same golden test vectors run against both in-memory and PostgreSQL
   adapters (contract test pattern).

---

## 8. Technology Stack

### Decision

| Category | Choice | Rationale |
|----------|--------|-----------|
| **Language** | TypeScript 5.x (strict mode) | Matches HLD; branded types require TS |
| **Runtime** | Node.js 22 LTS | Avoids Volt's Bun coupling; best ecosystem compat |
| **Package Manager** | pnpm 9.x | Fast, reliable workspaces, strict dependency isolation |
| **Monorepo** | Turborepo | Minimal config, task caching, parallelized builds |
| **Test Framework** | Vitest | TS-native, fast, excellent monorepo support |
| **Build** | tsup (libraries) + tsc --noEmit (type checking) | Simple ESM/CJS dual output |
| **Lint** | ESLint + @typescript-eslint + eslint-plugin-boundaries | Enforces dependency rule across packages |
| **Format** | Prettier | Standard, opinionless |
| **DB Driver** | pg (node-postgres) | No ORM; SQL stays in infra adapters |
| **Migrations** | node-pg-migrate | Simple, SQL-first, no ORM dependency |
| **CI** | GitHub Actions | Standard for OSS |

### Package Layout (Monorepo)

```
ledger-memory/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json        # shared TS config
├── packages/
│   ├── domain/               # zero deps — entities, value objects, services, events, errors
│   ├── application/          # depends on: domain — use cases, ports, strategies, DTOs
│   ├── adapters/             # depends on: application, domain — storage, LLM, tools, explorers
│   ├── infrastructure/       # depends on: adapters, application — SQL, crypto, config
│   └── sdk/                  # depends on: all — public API, createMemoryEngine()
├── apps/
│   └── mcp-server/           # Phase 2+ — standalone MCP server binary
├── tests/
│   └── golden/               # cross-package golden test fixtures
└── docs/
```

### Dependency Rule Enforcement

In addition to TypeScript project references (`composite: true`), add
`eslint-plugin-boundaries` rules:

```jsonc
// .eslintrc — boundary rules
{
  "rules": {
    "boundaries/element-types": ["error", {
      "default": "disallow",
      "rules": [
        { "from": "domain", "allow": [] },
        { "from": "application", "allow": ["domain"] },
        { "from": "adapters", "allow": ["application", "domain"] },
        { "from": "infrastructure", "allow": ["adapters", "application", "domain"] },
        { "from": "sdk", "allow": ["infrastructure", "adapters", "application", "domain"] }
      ]
    }]
  }
}
```

---

## 9. Minor Fixes to HLD

These are small corrections to apply to the High-Level Design when
implementation begins:

| Section | Issue | Resolution |
|---------|-------|------------|
| §6.1 Artifact | `Buffer` type in `StoreArtifactInput` | Replace with `Uint8Array` in all port interfaces |
| §6.2 Value Objects | `TokenCount` is `{ value: number }` | Keep as-is; factory function enforces `value >= 0` |
| §8.2 `ContextProjectionPort` | Missing concurrency control | Add `expectedVersion` param per §3 above |
| §8.2 `SummaryDagPort` | `checkIntegrity()` return type `IntegrityReport` not defined | Defined in §4 above |
| §10 Package Structure | `adapters` and `infrastructure` are separate packages | Keep this split — adapters contain mapping logic, infrastructure contains platform bindings |
| §11.1 Schema | No `metadata` column on `ledger_events` | Add `metadata JSONB NOT NULL DEFAULT '{}'` per §2 above |
| §11.1 Schema | No context versioning | Add `context_versions` table per §3 above |
| §12.2 Compaction | "Oldest block" undefined | Defined in §5 above |
| §12.2 Compaction | Deterministic fallback underspecified | Defined in §6 above |

---

## Summary of Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | ID hashing | SHA-256 of sorted-key JSON of content fields only (no timestamps) |
| 2 | Event model | Single table, `metadata JSONB`, no parts table |
| 3 | Context concurrency | Optimistic locking via `context_versions.version` |
| 4 | Integrity checks | 8 checks enumerated (orphans, cycles, coverage, propagation) |
| 5 | Compaction block | Contiguous oldest non-pinned items, up to 25% of budget |
| 6 | Deterministic fallback | Head-only truncation to ≤ 512 tokens, no LLM |
| 7 | Test summarizer | Deterministic prefix-based stub (60% normal, 30% aggressive) |
| 8 | Tech stack | pnpm + Turborepo + Node 22 + Vitest + tsup + pg |

All decisions are **Phase 1 scoped** and can be revisited for Phase 2/3
without breaking the architecture (ports insulate all boundaries).
