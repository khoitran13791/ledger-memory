import { describe, expect, it } from 'vitest';

import { InMemoryUnitOfWork, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { StaleContextVersionError } from '@ledgermind/application';
import {
  createContextItem,
  createContextVersion,
  createConversationConfig,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';
import type { ConversationId } from '@ledgermind/domain';
import { createCompactionThresholds } from '@ledgermind/domain';

const createConfig = () => {
  return createConversationConfig({
    modelName: 'test-model',
    contextWindow: createTokenCount(4096),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

const createEvent = (conversationId: ConversationId, sequence: number, content: string) => {
  return createLedgerEvent({
    id: createEventId(`evt_uow_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

const createLeafSummary = (conversationId: ConversationId, id: string) => {
  return createSummaryNode({
    id: createSummaryNodeId(id),
    conversationId,
    kind: 'leaf',
    content: `summary-${id}`,
    tokenCount: createTokenCount(4),
    createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
  });
};

describe('InMemoryUnitOfWork', () => {
  it('commits multi-store mutations when callback succeeds', async () => {
    const state = createInMemoryPersistenceState();
    const uow = new InMemoryUnitOfWork(state);

    let createdConversationId: ConversationId | null = null;

    await uow.execute(async (tx) => {
      const conversation = await tx.conversations.create(createConfig());
      createdConversationId = conversation.id;

      const event = createEvent(conversation.id, 1, 'first event');
      await tx.ledger.appendEvents(conversation.id, [event]);

      await tx.context.appendContextItems(conversation.id, [
        createContextItem({
          conversationId: conversation.id,
          position: 0,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      const summary = createLeafSummary(conversation.id, 'sum_uow_1');
      await tx.dag.createNode(summary);
      await tx.dag.addLeafEdges(summary.id, [event.id]);
    });

    expect(createdConversationId).not.toBeNull();
    if (createdConversationId === null) {
      throw new Error('Expected conversation id to be assigned.');
    }

    const conversationId = createdConversationId;

    expect(state.conversations.has(conversationId)).toBe(true);
    expect(state.ledgerEventsByConversation.get(conversationId)).toHaveLength(1);
    expect(state.contextItemsByConversation.get(conversationId)).toHaveLength(1);
    expect(state.contextVersionsByConversation.get(conversationId)).toBe(1);
    expect(state.summaryNodeIdsByConversation.get(conversationId)).toHaveLength(1);
  });

  it('rolls back all mutations when callback throws', async () => {
    const state = createInMemoryPersistenceState();
    const uow = new InMemoryUnitOfWork(state);

    await expect(
      uow.execute(async (tx) => {
        const conversation = await tx.conversations.create(createConfig());

        const event = createEvent(conversation.id, 1, 'should rollback');
        await tx.ledger.appendEvents(conversation.id, [event]);

        await tx.context.appendContextItems(conversation.id, [
          createContextItem({
            conversationId: conversation.id,
            position: 0,
            ref: createMessageContextItemRef(event.id),
          }),
        ]);

        throw new Error('abort transaction');
      }),
    ).rejects.toThrow('abort transaction');

    expect(state.conversations.size).toBe(0);
    expect(state.ledgerEventsByConversation.size).toBe(0);
    expect(state.ledgerEventsById.size).toBe(0);
    expect(state.contextItemsByConversation.size).toBe(0);
    expect(state.contextVersionsByConversation.size).toBe(0);
    expect(state.summaryNodesById.size).toBe(0);
  });

  it('rolls back on stale context version conflict with no partial writes', async () => {
    const state = createInMemoryPersistenceState();
    const uow = new InMemoryUnitOfWork(state);

    const seedConversation = await uow.execute(async (tx) => tx.conversations.create(createConfig()));
    const seedEvent = createEvent(seedConversation.id, 1, 'seed');

    await uow.execute(async (tx) => {
      await tx.ledger.appendEvents(seedConversation.id, [seedEvent]);
      await tx.context.appendContextItems(seedConversation.id, [
        createContextItem({
          conversationId: seedConversation.id,
          position: 0,
          ref: createMessageContextItemRef(seedEvent.id),
        }),
      ]);
    });

    const beforeSnapshot = {
      conversationCount: state.conversations.size,
      ledgerEventCount: state.ledgerEventsByConversation.get(seedConversation.id)?.length ?? 0,
      contextItemsCount: state.contextItemsByConversation.get(seedConversation.id)?.length ?? 0,
      contextVersion: state.contextVersionsByConversation.get(seedConversation.id) ?? 0,
      summaryCount: state.summaryNodeIdsByConversation.get(seedConversation.id)?.length ?? 0,
    };

    const nextEvent = createEvent(seedConversation.id, 2, 'candidate');

    await expect(
      uow.execute(async (tx) => {
        await tx.ledger.appendEvents(seedConversation.id, [nextEvent]);

        const replacementSummary = createLeafSummary(seedConversation.id, 'sum_uow_conflict');
        await tx.dag.createNode(replacementSummary);

        await tx.context.replaceContextItems(
          seedConversation.id,
          createContextVersion(0),
          [0],
          createContextItem({
            conversationId: seedConversation.id,
            position: 0,
            ref: createSummaryContextItemRef(replacementSummary.id),
          }),
        );
      }),
    ).rejects.toBeInstanceOf(StaleContextVersionError);

    const afterSnapshot = {
      conversationCount: state.conversations.size,
      ledgerEventCount: state.ledgerEventsByConversation.get(seedConversation.id)?.length ?? 0,
      contextItemsCount: state.contextItemsByConversation.get(seedConversation.id)?.length ?? 0,
      contextVersion: state.contextVersionsByConversation.get(seedConversation.id) ?? 0,
      summaryCount: state.summaryNodeIdsByConversation.get(seedConversation.id)?.length ?? 0,
    };

    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(state.ledgerEventsById.has(nextEvent.id)).toBe(false);
  });
});
