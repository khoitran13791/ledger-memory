import { describe, expect, it } from 'vitest';

import { InMemoryLedgerStore, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { createLedgerEvent } from '@ledgermind/domain';
import {
  createConversationId,
  createEventId,
  createSequenceNumber,
  createSummaryNodeId,
} from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';
import { NonMonotonicSequenceError } from '@ledgermind/domain';

const createEvent = (
  conversationId: ReturnType<typeof createConversationId>,
  sequence: number,
  content: string,
) => {
  return createLedgerEvent({
    id: createEventId(`evt_${conversationId}_${sequence}_${content.replace(/\s+/g, '_')}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

describe('InMemoryLedgerStore', () => {
  it('appends events atomically in input order and supports range reads', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryLedgerStore(state);
    const conversationId = createConversationId('conv_ledger_1');

    const events = [
      createEvent(conversationId, 1, 'alpha event'),
      createEvent(conversationId, 2, 'beta event'),
      createEvent(conversationId, 3, 'gamma event'),
    ];

    await store.appendEvents(conversationId, events);

    const allEvents = await store.getEvents(conversationId);
    expect(allEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);

    const rangeEvents = await store.getEvents(conversationId, {
      start: createSequenceNumber(2),
      end: createSequenceNumber(3),
    });
    expect(rangeEvents.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it('treats duplicate event IDs as idempotent no-op', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryLedgerStore(state);
    const conversationId = createConversationId('conv_ledger_2');

    const first = createEvent(conversationId, 1, 'same event');

    await store.appendEvents(conversationId, [first]);
    await store.appendEvents(conversationId, [first]);

    const allEvents = await store.getEvents(conversationId);
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]?.id).toBe(first.id);
  });

  it('rejects non-monotonic sequence append', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryLedgerStore(state);
    const conversationId = createConversationId('conv_ledger_3');

    await store.appendEvents(conversationId, [createEvent(conversationId, 1, 'first')]);

    await expect(
      store.appendEvents(conversationId, [createEvent(conversationId, 3, 'gap')]),
    ).rejects.toBeInstanceOf(NonMonotonicSequenceError);

    const events = await store.getEvents(conversationId);
    expect(events.map((event) => event.sequence)).toEqual([1]);
  });

  it('supports substring search and regex search with scope', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryLedgerStore(state);
    const conversationId = createConversationId('conv_ledger_4');

    const evt1 = createEvent(conversationId, 1, 'alpha banana');
    const evt2 = createEvent(conversationId, 2, 'beta carrot');
    const evt3 = createEvent(conversationId, 3, 'alpha delta');

    await store.appendEvents(conversationId, [evt1, evt2, evt3]);

    const searchMatches = await store.searchEvents(conversationId, 'alpha');
    expect(searchMatches.map((event) => event.id)).toEqual([evt1.id, evt3.id]);

    const summaryId = createSummaryNodeId('sum_scope_1');
    state.leafMessageEdgesBySummary.set(summaryId, [evt3.id]);
    state.summaryNodesById.set(summaryId, {
      id: summaryId,
      conversationId,
      kind: 'leaf',
      content: 'scope summary',
      tokenCount: createTokenCount(5),
      artifactIds: [],
      createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
    });
    state.summaryNodeIdsByConversation.set(conversationId, [summaryId]);

    const scopedSearchMatches = await store.searchEvents(conversationId, 'alpha', summaryId);
    expect(scopedSearchMatches.map((event) => event.id)).toEqual([evt3.id]);

    const regexMatches = await store.regexSearchEvents(conversationId, 'alpha', summaryId);
    expect(regexMatches).toHaveLength(1);

    const scopedMatch = regexMatches[0];
    expect(scopedMatch).toBeDefined();
    if (!scopedMatch) {
      throw new Error('Expected scoped regex match to exist.');
    }

    expect(scopedMatch.eventId).toBe(evt3.id);
    expect(scopedMatch.coveringSummaryId).toBe(summaryId);
  });
});
