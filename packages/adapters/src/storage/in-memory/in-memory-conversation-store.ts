import type { ConversationPort } from '@ledgermind/application';
import {
  createConversation,
  createConversationId,
  InvariantViolationError,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
} from '@ledgermind/domain';

import type { InMemoryPersistenceState } from './state';
import { createInMemoryPersistenceState } from './state';

const createNextConversationId = (ordinal: number): ConversationId => {
  return createConversationId(`conv_${String(ordinal).padStart(6, '0')}`);
};

export class InMemoryConversationStore implements ConversationPort {
  constructor(private readonly state: InMemoryPersistenceState = createInMemoryPersistenceState()) {}

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
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

  async get(id: ConversationId): Promise<Conversation | null> {
    return this.state.conversations.get(id) ?? null;
  }

  async getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]> {
    const chain: ConversationId[] = [];
    const visited = new Set<ConversationId>();

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
