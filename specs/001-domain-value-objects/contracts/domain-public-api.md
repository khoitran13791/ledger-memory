# Contract: `@ledgermind/domain` Public API (Phase 1 Foundations)

This contract defines the expected exported surface of `packages/domain/src/index.ts` for the Domain Package Foundations feature.

## 1) Export Surface Categories

The package MUST export five categories:

1. `entities/*`
2. `value-objects/*`
3. `services/*`
4. `events/*`
5. `errors/*`

## 2) Entity Contracts

## 2.1 Conversation

```ts
export interface Conversation {
  readonly id: ConversationId;
  readonly parentId: ConversationId | null;
  readonly config: ConversationConfig;
  readonly createdAt: Timestamp;
}

export interface ConversationConfig {
  readonly modelName: string;
  readonly contextWindow: TokenCount;
  readonly thresholds: CompactionThresholds;
}
```

Validation behavior:
- Invalid `contextWindow` or threshold ordering MUST fail with domain error.

## 2.2 LedgerEvent

```ts
export interface LedgerEvent {
  readonly id: EventId;
  readonly conversationId: ConversationId;
  readonly sequence: SequenceNumber;
  readonly role: MessageRole;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly occurredAt: Timestamp;
  readonly metadata: EventMetadata;
}
```

Validation behavior:
- Non-negative token invariant MUST be enforced.
- Event identity MUST be derivable deterministically from canonical payload.

## 2.3 SummaryNode

```ts
export type SummaryKind = "leaf" | "condensed";

export interface SummaryNode {
  readonly id: SummaryNodeId;
  readonly conversationId: ConversationId;
  readonly kind: SummaryKind;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly artifactIds: readonly ArtifactId[];
  readonly createdAt: Timestamp;
}
```

## 2.4 DagEdge

```ts
export type DagEdge =
  | {
      readonly summaryId: SummaryNodeId;
      readonly messageId: EventId;
      readonly order: number;
    }
  | {
      readonly summaryId: SummaryNodeId;
      readonly parentSummaryId: SummaryNodeId;
      readonly order: number;
    };
```

## 2.5 ContextItem

```ts
export type ContextItemRef =
  | { readonly type: "message"; readonly messageId: EventId }
  | { readonly type: "summary"; readonly summaryId: SummaryNodeId };

export interface ContextItem {
  readonly conversationId: ConversationId;
  readonly position: number;
  readonly ref: ContextItemRef;
}
```

## 2.6 Artifact

```ts
export type StorageKind = "path" | "inline_text" | "inline_binary";

export interface Artifact {
  readonly id: ArtifactId;
  readonly conversationId: ConversationId;
  readonly storageKind: StorageKind;
  readonly originalPath: string | null;
  readonly mimeType: MimeType;
  readonly tokenCount: TokenCount;
  readonly explorationSummary: string | null;
  readonly explorerUsed: string | null;
}
```

## 3) Value Object Contracts

```ts
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type EventId = string & { readonly __brand: "EventId" };
export type SummaryNodeId = string & { readonly __brand: "SummaryNodeId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
export type SequenceNumber = number & { readonly __brand: "SequenceNumber" };
export type ContextVersion = number & { readonly __brand: "ContextVersion" };
export type MimeType = string & { readonly __brand: "MimeType" };
export type Timestamp = Date & { readonly __brand: "Timestamp" };

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TokenCount {
  readonly value: number;
}

export interface CompactionThresholds {
  readonly soft: number;
  readonly hard: number;
}

export interface TokenBudget {
  readonly contextWindow: TokenCount;
  readonly overhead: TokenCount;
  readonly reserve: TokenCount;
  readonly available: TokenCount;
}
```

Behavior requirements:
- Token values MUST reject negative input.
- Thresholds MUST enforce `soft < hard` and positive values.
- Context version VO MUST support optimistic-locking semantics representation.

## 4) Domain Service Contracts

## 4.1 TokenBudgetService

```ts
export interface TokenBudgetService {
  computeBudget(config: ConversationConfig, overhead: TokenCount): TokenBudget;
  isOverSoftThreshold(currentTokens: TokenCount, budget: TokenBudget): boolean;
  isOverHardThreshold(currentTokens: TokenCount, budget: TokenBudget): boolean;
  computeTargetFreeTokens(budget: TokenBudget, freePercentage: number): TokenCount;
}
```

## 4.2 CompactionPolicyService

```ts
export interface CompactionPolicyService {
  selectCandidates(contextItems: readonly ContextItem[], pinRules: readonly PinRule[]): readonly CompactionCandidate[];
  shouldEscalate(inputTokens: TokenCount, outputTokens: TokenCount): boolean;
}
```

Contract behavior:
- Candidate selection uses oldest non-pinned contiguous block policy.
- Escalation rule: escalate when `outputTokens >= inputTokens`.

## 4.3 IdService

```ts
export interface IdService {
  generateEventId(input: {
    readonly content: string;
    readonly conversationId: ConversationId;
    readonly role: MessageRole;
    readonly sequence: SequenceNumber;
  }): EventId;

  generateSummaryId(input: {
    readonly content: string;
    readonly conversationId: ConversationId;
    readonly kind: SummaryKind;
  }): SummaryNodeId;

  generateArtifactId(input: {
    readonly contentHashHex: string;
  }): ArtifactId;
}
```

Deterministic identity contract:
- Canonical JSON with sorted keys, JSON default encoding, UTF-8 bytes.
- ID format: `<prefix>_<sha256hex>`.
- Hashed fields align to addendum decisions:
  - event: `{ content, conversationId, role, sequence }`
  - summary: `{ content, conversationId, kind }`
  - artifact: `{ contentHash }`

## 5) Domain Event Contracts

```ts
export interface LedgerEventAppended {
  readonly type: "LedgerEventAppended";
  readonly conversationId: ConversationId;
  readonly eventId: EventId;
  readonly sequence: SequenceNumber;
  readonly tokenCount: TokenCount;
}

export interface CompactionTriggered {
  readonly type: "CompactionTriggered";
  readonly conversationId: ConversationId;
  readonly trigger: "soft" | "hard";
  readonly currentTokens: TokenCount;
  readonly threshold: TokenCount;
}

export interface SummaryNodeCreated {
  readonly type: "SummaryNodeCreated";
  readonly conversationId: ConversationId;
  readonly nodeId: SummaryNodeId;
  readonly kind: SummaryKind;
  readonly level: 1 | 2 | 3;
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly coveredItemCount: number;
}

export interface CompactionCompleted {
  readonly type: "CompactionCompleted";
  readonly conversationId: ConversationId;
  readonly rounds: number;
  readonly nodesCreated: readonly SummaryNodeId[];
  readonly tokensFreed: TokenCount;
  readonly converged: boolean;
}

export interface ArtifactStored {
  readonly type: "ArtifactStored";
  readonly conversationId: ConversationId;
  readonly artifactId: ArtifactId;
  readonly storageKind: StorageKind;
  readonly tokenCount: TokenCount;
}

export interface ContextMaterialized {
  readonly type: "ContextMaterialized";
  readonly conversationId: ConversationId;
  readonly budgetUsed: TokenCount;
  readonly budgetTotal: TokenCount;
  readonly itemCount: number;
}

export type DomainEvent =
  | LedgerEventAppended
  | CompactionTriggered
  | SummaryNodeCreated
  | CompactionCompleted
  | ArtifactStored
  | ContextMaterialized;
```

## 6) Domain Error Contracts

```ts
export abstract class DomainError extends Error {
  abstract readonly code: string;
}

export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";
}

export class HashMismatchError extends DomainError {
  readonly code = "HASH_MISMATCH";
}

export class InvalidDagEdgeError extends DomainError {
  readonly code = "INVALID_DAG_EDGE";
}

export class NonMonotonicSequenceError extends DomainError {
  readonly code = "NON_MONOTONIC_SEQUENCE";
}

export class BudgetExceededError extends DomainError {
  readonly code = "BUDGET_EXCEEDED";
}
```

## 7) Non-Functional Contract Requirements

- `@ledgermind/domain` MUST introduce zero runtime dependencies.
- Public exports MUST be stable and typed (no `any`-shaped external contract surface).
- The package MUST compile with strict TypeScript settings inherited from monorepo base config.
- Domain API MUST not leak application/adapters/infrastructure types.

## 8) Verification Checklist

1. `pnpm --filter @ledgermind/domain typecheck` passes.
2. `pnpm --filter @ledgermind/domain test` includes deterministic tests for:
   - valid + invalid invariant cases,
   - deterministic ID stability and changed-hash-field divergence.
3. `pnpm --filter @ledgermind/domain lint` passes with no boundary violations.
4. `packages/domain/package.json` has no runtime `dependencies`.
