import type { ConversationId } from '@ledgermind/domain';

export interface CallerContext {
  readonly conversationId: ConversationId;
  readonly isSubAgent: boolean;
  readonly parentConversationId?: ConversationId;
}

export interface AuthorizationPort {
  canExpand(caller: CallerContext): boolean;
}
