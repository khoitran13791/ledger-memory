import type { Conversation, ConversationConfig, ConversationId } from '@ledgermind/domain';

export interface ConversationPort {
  create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation>;
  get(id: ConversationId): Promise<Conversation | null>;

  /**
   * Returns ancestor IDs from root to immediate parent.
   */
  getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]>;
}
