import type {
  ConversationId,
  EventId,
  LedgerEvent,
  SequenceNumber,
  SummaryNodeId,
} from '@ledgermind/domain';

/**
 * Inclusive sequence window over a single conversation.
 */
export interface SequenceRange {
  readonly start?: SequenceNumber;
  readonly end?: SequenceNumber;
}

export interface GrepMatch {
  readonly eventId: EventId;
  readonly sequence: SequenceNumber;
  readonly excerpt: string;
  readonly coveringSummaryId?: SummaryNodeId;
}

export interface LedgerReadPort {
  /**
   * Returns events in ascending sequence order.
   *
   * When `range` is provided, `start`/`end` are inclusive bounds.
   */
  getEvents(conversationId: ConversationId, range?: SequenceRange): Promise<readonly LedgerEvent[]>;

  /**
   * Performs keyword/full-text search within a single conversation.
   * Returned events are ordered by ascending sequence.
   */
  searchEvents(conversationId: ConversationId, query: string): Promise<readonly LedgerEvent[]>;

  /**
   * Performs regex search within a single conversation (optionally scoped to a
   * summary subtree).
   * Returned matches are ordered by ascending event sequence.
   */
  regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    scope?: SummaryNodeId,
  ): Promise<readonly GrepMatch[]>;
}
