import { createConversation, createConversationId, InvariantViolationError, } from '@ledgermind/domain';
import { createInMemoryPersistenceState } from './state';
const createNextConversationId = (ordinal) => {
    return createConversationId(`conv_${String(ordinal).padStart(6, '0')}`);
};
export class InMemoryConversationStore {
    state;
    constructor(state = createInMemoryPersistenceState()) {
        this.state = state;
    }
    async create(config, parentId) {
        if (parentId && !this.state.conversations.has(parentId)) {
            throw new InvariantViolationError('Parent conversation does not exist.');
        }
        const id = createNextConversationId(this.state.nextConversationOrdinal);
        this.state.nextConversationOrdinal += 1;
        const conversation = createConversation({
            id,
            parentId: parentId ?? null,
            config,
        });
        this.state.conversations.set(conversation.id, conversation);
        return conversation;
    }
    async get(id) {
        return this.state.conversations.get(id) ?? null;
    }
    async getAncestorChain(id) {
        const chain = [];
        const visited = new Set();
        let current = this.state.conversations.get(id);
        while (current?.parentId) {
            const parentId = current.parentId;
            if (visited.has(parentId)) {
                break;
            }
            visited.add(parentId);
            chain.push(parentId);
            current = this.state.conversations.get(parentId);
        }
        return chain.reverse();
    }
}
//# sourceMappingURL=in-memory-conversation-store.js.map