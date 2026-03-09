import type { StorageKind } from '../entities/artifact';
import type { SummaryKind } from '../entities/summary-node';
import type { ArtifactId, ConversationId, EventId, SequenceNumber, SummaryNodeId } from '../value-objects/ids';
import type { TokenCount } from '../value-objects/token-count';

export interface LedgerEventAppended {
  readonly type: 'LedgerEventAppended';
  readonly conversationId: ConversationId;
  readonly eventId: EventId;
  readonly sequence: SequenceNumber;
  readonly tokenCount: TokenCount;
}

export interface CompactionTriggered {
  readonly type: 'CompactionTriggered';
  readonly conversationId: ConversationId;
  readonly trigger: 'soft' | 'hard';
  readonly currentTokens: TokenCount;
  readonly threshold: TokenCount;
}

export interface SummaryNodeCreated {
  readonly type: 'SummaryNodeCreated';
  readonly conversationId: ConversationId;
  readonly nodeId: SummaryNodeId;
  readonly kind: SummaryKind;
  readonly level: 1 | 2 | 3;
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly coveredItemCount: number;
}

export interface CompactionCompleted {
  readonly type: 'CompactionCompleted';
  readonly conversationId: ConversationId;
  readonly rounds: number;
  readonly nodesCreated: readonly SummaryNodeId[];
  readonly tokensFreed: TokenCount;
  readonly converged: boolean;
}

export interface ArtifactStored {
  readonly type: 'ArtifactStored';
  readonly conversationId: ConversationId;
  readonly artifactId: ArtifactId;
  readonly storageKind: StorageKind;
  readonly tokenCount: TokenCount;
}

export interface ContextMaterialized {
  readonly type: 'ContextMaterialized';
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
