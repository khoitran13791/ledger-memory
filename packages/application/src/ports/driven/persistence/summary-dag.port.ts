import type {
  ConversationId,
  EventId,
  LedgerEvent,
  SummaryNode,
  SummaryNodeId,
} from '@ledgermind/domain';

export interface IntegrityCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
  readonly affectedIds?: readonly string[];
}

export interface IntegrityReport {
  readonly passed: boolean;
  readonly checks: readonly IntegrityCheckResult[];
}

export interface SummaryDagPort {
  createNode(node: SummaryNode): Promise<void>;

  getNode(id: SummaryNodeId): Promise<SummaryNode | null>;

  addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void>;

  addCondensedEdges(
    summaryId: SummaryNodeId,
    parentSummaryIds: readonly SummaryNodeId[],
  ): Promise<void>;

  getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]>;

  /**
   * Recursively expands a summary subtree to source messages, ordered by
   * ascending sequence.
   */
  expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]>;

  searchSummaries(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly SummaryNode[]>;

  checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport>;
}
