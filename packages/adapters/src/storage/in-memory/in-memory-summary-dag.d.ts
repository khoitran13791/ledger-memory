import type { IntegrityReport, SummaryDagPort } from '@ledgermind/application';
import { type ConversationId, type EventId, type LedgerEvent, type SummaryNode, type SummaryNodeId } from '@ledgermind/domain';
import type { InMemoryPersistenceState } from './state';
export declare class InMemorySummaryDag implements SummaryDagPort {
    private readonly state;
    constructor(state?: InMemoryPersistenceState);
    createNode(node: SummaryNode): Promise<void>;
    getNode(id: SummaryNodeId): Promise<SummaryNode | null>;
    addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void>;
    addCondensedEdges(summaryId: SummaryNodeId, parentSummaryIds: readonly SummaryNodeId[]): Promise<void>;
    getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]>;
    expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]>;
    searchSummaries(conversationId: ConversationId, query: string, scope?: SummaryNodeId): Promise<readonly SummaryNode[]>;
    checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport>;
}
//# sourceMappingURL=in-memory-summary-dag.d.ts.map