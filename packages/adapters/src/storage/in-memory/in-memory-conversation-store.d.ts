import type { ConversationPort } from '@ledgermind/application';
import { type Conversation, type ConversationConfig, type ConversationId } from '@ledgermind/domain';
import type { InMemoryPersistenceState } from './state';
export declare class InMemoryConversationStore implements ConversationPort {
    private readonly state;
    constructor(state?: InMemoryPersistenceState);
    create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation>;
    get(id: ConversationId): Promise<Conversation | null>;
    getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]>;
}
//# sourceMappingURL=in-memory-conversation-store.d.ts.map