import type {
  LedgerAppendPort,
  LedgerReadGrepMatch,
  LedgerReadPort,
  RegexSearchPageInput,
  RegexSearchPageOutput,
  SequenceRange,
} from '@ledgermind/application';
import {
  InvariantViolationError,
  NonMonotonicSequenceError,
  createSequenceNumber,
  type ConversationId,
  type EventId,
  type LedgerEvent,
  type SequenceNumber,
  type SummaryNodeId,
} from '@ledgermind/domain';

import type { InMemoryPersistenceState } from './state';
import { createInMemoryPersistenceState } from './state';

const sortEventsBySequence = (events: readonly LedgerEvent[]): LedgerEvent[] => {
  return [...events].sort((left, right) => left.sequence - right.sequence);
};

const toSearchTokens = (value: string): readonly string[] => {
  return value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
};

const hasTokenOverlap = (content: string, query: string): boolean => {
  const queryTokens = new Set(toSearchTokens(query));
  if (queryTokens.size === 0) {
    return false;
  }

  const contentTokens = new Set(toSearchTokens(content));
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      return true;
    }
  }

  return false;
};

const getRangeBounds = (range?: SequenceRange): { start?: number; end?: number } => {
  if (!range) {
    return {};
  }

  const bounds: { start?: number; end?: number } = {};

  if (range.start !== undefined) {
    bounds.start = range.start;
  }

  if (range.end !== undefined) {
    bounds.end = range.end;
  }

  return bounds;
};

const createExcerpt = (content: string, start: number, length: number): string => {
  const excerptStart = Math.max(0, start - 24);
  const excerptEnd = Math.min(content.length, start + Math.max(1, length) + 24);
  return content.slice(excerptStart, excerptEnd);
};

const collectScopedMessageIds = (
  state: InMemoryPersistenceState,
  scope: SummaryNodeId,
): ReadonlySet<EventId> => {
  if (!state.summaryNodesById.has(scope)) {
    return new Set<EventId>();
  }

  const visited = new Set<SummaryNodeId>();
  const messageIds = new Set<EventId>();

  const visit = (summaryId: SummaryNodeId): void => {
    if (visited.has(summaryId)) {
      return;
    }

    visited.add(summaryId);

    const directMessages = state.leafMessageEdgesBySummary.get(summaryId) ?? [];
    for (const messageId of directMessages) {
      messageIds.add(messageId);
    }

    const parents = state.condensedParentEdgesBySummary.get(summaryId) ?? [];
    for (const parentId of parents) {
      visit(parentId);
    }
  };

  visit(scope);
  return messageIds;
};

const buildActiveCoverageByEventId = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): ReadonlyMap<EventId, SummaryNodeId> => {
  const coverage = new Map<EventId, SummaryNodeId>();
  const contextItems = [...(state.contextItemsByConversation.get(conversationId) ?? [])].sort(
    (left, right) => left.position - right.position,
  );

  for (const item of contextItems) {
    if (item.ref.type !== 'summary') {
      continue;
    }

    const coveredMessageIds = collectScopedMessageIds(state, item.ref.summaryId);
    for (const messageId of coveredMessageIds) {
      if (!coverage.has(messageId)) {
        coverage.set(messageId, item.ref.summaryId);
      }
    }
  }

  return coverage;
};

export class InMemoryLedgerStore implements LedgerAppendPort, LedgerReadPort {
  constructor(private readonly state: InMemoryPersistenceState = createInMemoryPersistenceState()) {}

  async appendEvents(conversationId: ConversationId, events: readonly LedgerEvent[]): Promise<void> {
    const existing = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
    const next = [...existing];

    for (const event of events) {
      if (event.conversationId !== conversationId) {
        throw new InvariantViolationError('LedgerEvent conversation mismatch during append.');
      }

      if (this.state.ledgerEventsById.has(event.id)) {
        continue;
      }

      const expectedSequence = next.length + 1;
      if (event.sequence !== expectedSequence) {
        throw new NonMonotonicSequenceError(
          `LedgerEvent sequence must be gap-free. Expected ${expectedSequence}, received ${event.sequence}.`,
        );
      }

      next.push(event);
    }

    this.state.ledgerEventsByConversation.set(conversationId, next);

    for (const event of next) {
      this.state.ledgerEventsById.set(event.id, event);
    }
  }

  async getNextSequence(conversationId: ConversationId): Promise<SequenceNumber> {
    const events = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
    return createSequenceNumber(events.length + 1);
  }

  async getEvents(
    conversationId: ConversationId,
    range?: SequenceRange,
  ): Promise<readonly LedgerEvent[]> {
    const events = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
    const sorted = sortEventsBySequence(events);

    if (!range) {
      return sorted;
    }

    const { start, end } = getRangeBounds(range);

    return sorted.filter((event) => {
      if (start !== undefined && event.sequence < start) {
        return false;
      }

      if (end !== undefined && event.sequence > end) {
        return false;
      }

      return true;
    });
  }

  async searchEvents(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly LedgerEvent[]> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const events = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
    const scopedMessageIds = scope ? collectScopedMessageIds(this.state, scope) : null;

    return sortEventsBySequence(events).filter((event) => {
      if (scopedMessageIds !== null && !scopedMessageIds.has(event.id)) {
        return false;
      }

      return hasTokenOverlap(event.content, normalizedQuery);
    });
  }

  async regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    page: RegexSearchPageInput,
  ): Promise<RegexSearchPageOutput> {
    const regex = new RegExp(pattern);
    const events = sortEventsBySequence(this.state.ledgerEventsByConversation.get(conversationId) ?? []);
    const scopedMessageIds = page.scope ? collectScopedMessageIds(this.state, page.scope) : null;
    const activeCoverageByEventId =
      page.scope === undefined ? buildActiveCoverageByEventId(this.state, conversationId) : null;

    const matches: LedgerReadGrepMatch[] = [];

    for (const event of events) {
      if (scopedMessageIds && !scopedMessageIds.has(event.id)) {
        continue;
      }

      const match = regex.exec(event.content);
      if (!match || match.index === undefined) {
        continue;
      }

      const result: LedgerReadGrepMatch =
        page.scope === undefined
          ? {
              eventId: event.id,
              sequence: event.sequence,
              excerpt: createExcerpt(event.content, match.index, match[0]?.length ?? 0),
              ...(activeCoverageByEventId?.get(event.id) === undefined
                ? {}
                : { coveringSummaryId: activeCoverageByEventId.get(event.id)! }),
            }
          : {
              eventId: event.id,
              sequence: event.sequence,
              excerpt: createExcerpt(event.content, match.index, match[0]?.length ?? 0),
              coveringSummaryId: page.scope,
            };

      matches.push(result);
    }

    return {
      matches: matches.slice(page.offset, page.offset + page.limit),
      totalMatchCount: matches.length,
    };
  }
}
