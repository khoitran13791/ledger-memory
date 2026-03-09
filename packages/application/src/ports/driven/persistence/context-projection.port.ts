import type {
  ContextItem,
  ContextVersion,
  ConversationId,
  TokenCount,
} from '@ledgermind/domain';

/**
 * Returned by versioned mutation contracts when `expectedVersion` does not
 * match the current stored version.
 */
export class StaleContextVersionError extends Error {
  readonly expectedVersion: ContextVersion;
  readonly actualVersion: ContextVersion;

  constructor(expectedVersion: ContextVersion, actualVersion: ContextVersion) {
    super('Stale context version conflict.');
    this.name = 'StaleContextVersionError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface ContextProjectionPort {
  /**
   * Returns current context in contiguous position order with its version.
   */
  getCurrentContext(conversationId: ConversationId): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ContextVersion;
  }>;

  getContextTokenCount(conversationId: ConversationId): Promise<TokenCount>;

  /**
   * Appends items to the end of context, preserving contiguous positions.
   */
  appendContextItems(
    conversationId: ConversationId,
    items: readonly ContextItem[],
  ): Promise<ContextVersion>;

  /**
   * Must perform optimistic concurrency with `expectedVersion`.
   * Implementations must throw `StaleContextVersionError` when versions differ.
   * Silent overwrite behavior is forbidden.
   */
  replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: readonly number[],
    replacement: ContextItem,
  ): Promise<ContextVersion>;
}
