import type {
  ArtifactId,
  ConversationId,
  EventId,
  EventMetadata,
  LedgerEvent,
  MessageRole,
  MimeType,
  SequenceNumber,
  SummaryKind,
  SummaryNodeId,
  Timestamp,
  TokenCount,
} from '@ledgermind/domain';

import type { CallerContext } from '../driven/auth/authorization.port';
import type { IntegrityReport } from '../driven/persistence/summary-dag.port';

export type Metadata = Readonly<Record<string, unknown>>;

export interface NewLedgerEvent {
  readonly role: MessageRole;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly metadata?: EventMetadata;
  readonly occurredAt?: Timestamp;
}

export interface AppendLedgerEventsInput {
  readonly conversationId: ConversationId;
  readonly events: readonly NewLedgerEvent[];
  readonly idempotencyKey?: string;
}

export interface AppendLedgerEventsOutput {
  readonly appendedEvents: readonly LedgerEvent[];
  readonly contextTokenCount: TokenCount;
}

export type PinRule =
  | {
      readonly type: 'message';
      readonly messageId: EventId;
    }
  | {
      readonly type: 'summary';
      readonly summaryId: SummaryNodeId;
    }
  | {
      readonly type: 'position';
      readonly position: number;
    };

export interface RetrievalHint {
  readonly query: string;
  readonly scope?: SummaryNodeId;
  readonly limit?: number;
}

export interface MaterializeContextInput {
  readonly conversationId: ConversationId;
  readonly budgetTokens: number;
  readonly overheadTokens: number;
  readonly pinRules?: readonly PinRule[];
  readonly retrievalHints?: readonly RetrievalHint[];
}

export interface ModelMessage {
  readonly role: MessageRole;
  readonly content: string;
}

export interface SummaryReference {
  readonly id: SummaryNodeId;
  readonly kind: SummaryKind;
  readonly tokenCount: TokenCount;
}

export interface ArtifactReference {
  readonly id: ArtifactId;
  readonly mimeType: MimeType;
  readonly tokenCount: TokenCount;
}

export interface MaterializeContextOutput {
  readonly systemPreamble: string;
  readonly modelMessages: readonly ModelMessage[];
  readonly summaryReferences: readonly SummaryReference[];
  readonly artifactReferences: readonly ArtifactReference[];
  readonly budgetUsed: TokenCount;
}

export interface RunCompactionInput {
  readonly conversationId: ConversationId;
  readonly trigger: 'soft' | 'hard';
  readonly targetTokens?: TokenCount;
}

export interface RunCompactionOutput {
  readonly rounds: number;
  readonly nodesCreated: readonly SummaryNodeId[];
  readonly tokensFreed: TokenCount;
  readonly converged: boolean;
}

export interface GrepInput {
  readonly conversationId: ConversationId;
  readonly pattern: string;
  readonly scope?: SummaryNodeId;
}

export interface GrepMatch {
  readonly eventId: EventId;
  readonly sequence: SequenceNumber;
  readonly excerpt: string;
  readonly coveringSummaryId?: SummaryNodeId;
}

export interface GrepOutput {
  readonly matches: readonly GrepMatch[];
}

export interface DescribeInput {
  readonly id: SummaryNodeId | ArtifactId;
}

export interface DescribeOutput {
  readonly kind: 'summary' | 'artifact';
  readonly metadata: Metadata;
  readonly tokenCount: TokenCount;
  readonly parentIds?: readonly SummaryNodeId[];
  readonly explorationSummary?: string;
}

export interface ExpandInput {
  readonly summaryId: SummaryNodeId;
  readonly callerContext: CallerContext;
}

export interface ExpandOutput {
  readonly messages: readonly LedgerEvent[];
}

export interface CheckIntegrityInput {
  readonly conversationId: ConversationId;
}

export interface CheckIntegrityOutput {
  readonly report: IntegrityReport;
}

export type ArtifactSource =
  | {
      readonly kind: 'path';
      readonly path: string;
    }
  | {
      readonly kind: 'text';
      readonly content: string;
    }
  | {
      readonly kind: 'binary';
      readonly data: Uint8Array;
    };

export interface StoreArtifactInput {
  readonly conversationId: ConversationId;
  readonly source: ArtifactSource;
  readonly mimeType?: MimeType;
}

export interface StoreArtifactOutput {
  readonly artifactId: ArtifactId;
  readonly tokenCount: TokenCount;
}

export interface ExplorerHints {
  readonly preferredExplorer?: string;
}

export interface ExploreArtifactInput {
  readonly artifactId: ArtifactId;
  readonly explorerHints?: ExplorerHints;
}

export interface ExploreArtifactOutput {
  readonly explorerUsed: string;
  readonly summary: string;
  readonly metadata: Metadata;
  readonly tokenCount: TokenCount;
}

export interface MemoryEngine {
  append(input: AppendLedgerEventsInput): Promise<AppendLedgerEventsOutput>;
  materializeContext(input: MaterializeContextInput): Promise<MaterializeContextOutput>;
  runCompaction(input: RunCompactionInput): Promise<RunCompactionOutput>;
  checkIntegrity(input: CheckIntegrityInput): Promise<CheckIntegrityOutput>;
  grep(input: GrepInput): Promise<GrepOutput>;
  describe(input: DescribeInput): Promise<DescribeOutput>;
  expand(input: ExpandInput): Promise<ExpandOutput>;
  storeArtifact(input: StoreArtifactInput): Promise<StoreArtifactOutput>;
  exploreArtifact(input: ExploreArtifactInput): Promise<ExploreArtifactOutput>;
}
