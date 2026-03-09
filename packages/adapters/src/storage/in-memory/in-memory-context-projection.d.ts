import type { ContextProjectionPort } from '@ledgermind/application';
import { type ContextItem, type ContextVersion, type ConversationId, type TokenCount } from '@ledgermind/domain';
import type { InMemoryPersistenceState } from './state';
export declare class InMemoryContextProjection implements ContextProjectionPort {
    private readonly state;
    constructor(state?: InMemoryPersistenceState);
    getCurrentContext(conversationId: ConversationId): Promise<{
        readonly items: readonly ContextItem[];
        readonly version: ContextVersion;
    }>;
    getContextTokenCount(conversationId: ConversationId): Promise<TokenCount>;
    appendContextItems(conversationId: ConversationId, items: readonly ContextItem[]): Promise<ContextVersion>;
    replaceContextItems(conversationId: ConversationId, expectedVersion: ContextVersion, positionsToRemove: readonly number[], replacement: ContextItem): Promise<ContextVersion>;
}
//# sourceMappingURL=in-memory-context-projection.d.ts.map