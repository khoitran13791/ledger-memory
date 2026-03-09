import { describe, expect, it } from 'vitest';

import { InMemoryContextProjection, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { StaleContextVersionError } from '@ledgermind/application';
import { createContextItem, createMessageContextItemRef, createSummaryContextItemRef } from '@ledgermind/domain';
import { createContextVersion } from '@ledgermind/domain';
import { createConversationId, createEventId, createSummaryNodeId } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';
import { createLedgerEvent, createSummaryNode } from '@ledgermind/domain';
import { createSequenceNumber } from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

const createMessage = (
  conversationId: ReturnType<typeof createConversationId>,
  id: string,
  sequence: number,
  tokenCount: number,
) => {
  return createLedgerEvent({
    id: createEventId(id),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content: `message-${id}`,
    tokenCount: createTokenCount(tokenCount),
    occurredAt: createTimestamp(new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

describe('InMemoryContextProjection', () => {
  it('appends context items contiguously and increments version', async () => {
    const state = createInMemoryPersistenceState();
    const projection = new InMemoryContextProjection(state);
    const conversationId = createConversationId('conv_ctx_1');

    const firstVersion = await projection.appendContextItems(conversationId, [
      createContextItem({
        conversationId,
        position: 999,
        ref: createMessageContextItemRef(createEventId('evt_1')),
      }),
      createContextItem({
        conversationId,
        position: 777,
        ref: createSummaryContextItemRef(createSummaryNodeId('sum_1')),
      }),
    ]);

    expect(firstVersion).toBe(createContextVersion(1));

    const snapshot = await projection.getCurrentContext(conversationId);
    expect(snapshot.version).toBe(createContextVersion(1));
    expect(snapshot.items.map((item) => item.position)).toEqual([0, 1]);
  });

  it('computes token count from ledger events and summary nodes', async () => {
    const state = createInMemoryPersistenceState();
    const projection = new InMemoryContextProjection(state);
    const conversationId = createConversationId('conv_ctx_2');

    const event = createMessage(conversationId, 'evt_ctx_1', 1, 11);
    state.ledgerEventsByConversation.set(conversationId, [event]);
    state.ledgerEventsById.set(event.id, event);

    const summary = createSummaryNode({
      id: createSummaryNodeId('sum_ctx_1'),
      conversationId,
      kind: 'leaf',
      content: 'summary',
      tokenCount: createTokenCount(7),
      createdAt: createTimestamp(new Date('2026-01-01T00:01:00.000Z')),
    });
    state.summaryNodesById.set(summary.id, summary);
    state.summaryNodeIdsByConversation.set(conversationId, [summary.id]);

    await projection.appendContextItems(conversationId, [
      createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(event.id),
      }),
      createContextItem({
        conversationId,
        position: 1,
        ref: createSummaryContextItemRef(summary.id),
      }),
    ]);

    const tokenCount = await projection.getContextTokenCount(conversationId);
    expect(tokenCount.value).toBe(18);
  });

  it('throws stale context version error on replace mismatch', async () => {
    const state = createInMemoryPersistenceState();
    const projection = new InMemoryContextProjection(state);
    const conversationId = createConversationId('conv_ctx_3');

    await projection.appendContextItems(conversationId, [
      createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(createEventId('evt_a')),
      }),
      createContextItem({
        conversationId,
        position: 1,
        ref: createMessageContextItemRef(createEventId('evt_b')),
      }),
    ]);

    const before = await projection.getCurrentContext(conversationId);

    await expect(
      projection.replaceContextItems(
        conversationId,
        createContextVersion(0),
        [0],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(createSummaryNodeId('sum_replacement')),
        }),
      ),
    ).rejects.toBeInstanceOf(StaleContextVersionError);

    const after = await projection.getCurrentContext(conversationId);
    expect(after.version).toBe(before.version);
    expect(after.items).toEqual(before.items);
  });

  it('replaces removed positions with one summary item and reindexes', async () => {
    const state = createInMemoryPersistenceState();
    const projection = new InMemoryContextProjection(state);
    const conversationId = createConversationId('conv_ctx_4');

    await projection.appendContextItems(conversationId, [
      createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(createEventId('evt_1')),
      }),
      createContextItem({
        conversationId,
        position: 1,
        ref: createMessageContextItemRef(createEventId('evt_2')),
      }),
      createContextItem({
        conversationId,
        position: 2,
        ref: createMessageContextItemRef(createEventId('evt_3')),
      }),
      createContextItem({
        conversationId,
        position: 3,
        ref: createMessageContextItemRef(createEventId('evt_4')),
      }),
    ]);

    const nextVersion = await projection.replaceContextItems(
      conversationId,
      createContextVersion(1),
      [1, 2],
      createContextItem({
        conversationId,
        position: 1,
        ref: createSummaryContextItemRef(createSummaryNodeId('sum_new')),
      }),
    );

    expect(nextVersion).toBe(createContextVersion(2));

    const snapshot = await projection.getCurrentContext(conversationId);
    expect(snapshot.items.map((item) => item.position)).toEqual([0, 1, 2]);

    const insertedSummary = snapshot.items[1];
    const trailingMessage = snapshot.items[2];

    expect(insertedSummary).toBeDefined();
    expect(trailingMessage).toBeDefined();
    if (!insertedSummary || !trailingMessage) {
      throw new Error('Expected reindexed context items to exist.');
    }

    expect(insertedSummary.ref.type).toBe('summary');
    expect(trailingMessage.ref.type).toBe('message');
  });

  it('rejects out-of-range remove positions during replace', async () => {
    const state = createInMemoryPersistenceState();
    const projection = new InMemoryContextProjection(state);
    const conversationId = createConversationId('conv_ctx_5');

    await projection.appendContextItems(conversationId, [
      createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(createEventId('evt_1')),
      }),
    ]);

    await expect(
      projection.replaceContextItems(
        conversationId,
        createContextVersion(1),
        [3],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(createSummaryNodeId('sum_x')),
        }),
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });
});
