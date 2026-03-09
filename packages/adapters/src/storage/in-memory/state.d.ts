import { type Artifact, type ArtifactId, type ContextItem, type ContextVersion, type Conversation, type ConversationId, type EventId, type LedgerEvent, type SummaryNode, type SummaryNodeId } from '@ledgermind/domain';
export interface StoredArtifactRecord {
    readonly artifact: Artifact;
    readonly content: string | Uint8Array | null;
}
export interface InMemoryPersistenceState {
    readonly conversations: Map<ConversationId, Conversation>;
    nextConversationOrdinal: number;
    readonly ledgerEventsByConversation: Map<ConversationId, LedgerEvent[]>;
    readonly ledgerEventsById: Map<EventId, LedgerEvent>;
    readonly contextItemsByConversation: Map<ConversationId, ContextItem[]>;
    readonly contextVersionsByConversation: Map<ConversationId, ContextVersion>;
    readonly summaryNodesById: Map<SummaryNodeId, SummaryNode>;
    readonly summaryNodeIdsByConversation: Map<ConversationId, SummaryNodeId[]>;
    readonly leafMessageEdgesBySummary: Map<SummaryNodeId, EventId[]>;
    readonly condensedParentEdgesBySummary: Map<SummaryNodeId, SummaryNodeId[]>;
    readonly artifactsById: Map<ArtifactId, StoredArtifactRecord>;
}
export declare const cloneContextItem: (item: ContextItem, position?: number) => ContextItem;
export declare const cloneArtifactContent: (content: string | Uint8Array | null) => string | Uint8Array | null;
export declare const createInMemoryPersistenceState: () => InMemoryPersistenceState;
export declare const cloneInMemoryPersistenceState: (state: InMemoryPersistenceState) => InMemoryPersistenceState;
export declare const applyInMemoryPersistenceState: (target: InMemoryPersistenceState, source: InMemoryPersistenceState) => void;
export declare const getContextVersionOrDefault: (state: InMemoryPersistenceState, conversationId: ConversationId) => ContextVersion;
//# sourceMappingURL=state.d.ts.map