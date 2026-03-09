import type { ConversationId, LedgerEvent, SequenceNumber } from '@ledgermind/domain';

export interface LedgerAppendPort {
  /**
   * Appends events for a conversation as an atomic unit in input order.
   *
   * This boundary owns sequence semantics in Phase 1: persisted events must
   * remain strictly monotonic and gap-free per conversation.
   */
  appendEvents(conversationId: ConversationId, events: readonly LedgerEvent[]): Promise<void>;

  /**
   * Returns the next available sequence number for the given conversation.
   * Must be called within a transaction to ensure atomicity.
   */
  getNextSequence(conversationId: ConversationId): Promise<SequenceNumber>;
}
