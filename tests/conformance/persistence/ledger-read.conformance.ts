import { describe, expect, it } from 'vitest';

import {
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  type ConversationId,
  type MessageRole,
} from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from '../run-conformance';

const createEvent = (input: {
  readonly conversationId: ConversationId;
  readonly sequence: number;
  readonly content: string;
  readonly role?: MessageRole;
}) => {
  return createLedgerEvent({
    id: createEventId(`evt_conf_read_${input.conversationId}_${input.sequence}`),
    conversationId: input.conversationId,
    sequence: createSequenceNumber(input.sequence),
    role: input.role ?? 'user',
    content: input.content,
    tokenCount: createTokenCount(Math.max(1, input.content.length)),
    occurredAt: createTimestamp(new Date(`2026-03-01T00:10:${String(input.sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

export const registerLedgerReadConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('ledger read contract', () => {
    it('returns events sorted by ascending sequence', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const events = [
          createEvent({ conversationId, sequence: 1, content: 'zeta entry' }),
          createEvent({ conversationId, sequence: 2, content: 'alpha entry' }),
          createEvent({ conversationId, sequence: 3, content: 'omega entry' }),
        ] as const;

        await runtime.ledger.appendEvents(conversationId, events);

        const loaded = await runtime.ledger.getEvents(conversationId);
        expect(loaded.map((event) => event.sequence)).toEqual([1, 2, 3]);
      } finally {
        await runtime.destroy();
      }
    });

    it('keeps sequence ordering when range bounds are applied', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const events = [
          createEvent({ conversationId, sequence: 1, content: 'range one' }),
          createEvent({ conversationId, sequence: 2, content: 'range two' }),
          createEvent({ conversationId, sequence: 3, content: 'range three' }),
        ] as const;

        await runtime.ledger.appendEvents(conversationId, events);

        const ranged = await runtime.ledger.getEvents(conversationId, {
          start: createSequenceNumber(2),
          end: createSequenceNumber(3),
        });

        expect(ranged.map((event) => event.sequence)).toEqual([2, 3]);
      } finally {
        await runtime.destroy();
      }
    });

    it('supports regex search by sequence with optional scope gating', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const eventOne = createEvent({
          conversationId,
          sequence: 1,
          content: 'auth token initialization',
        });
        const eventTwo = createEvent({
          conversationId,
          sequence: 2,
          content: 'auth refresh rotation',
        });

        await runtime.ledger.appendEvents(conversationId, [eventOne, eventTwo]);

        const unscoped = await runtime.ledger.regexSearchEvents(conversationId, 'auth');
        expect(unscoped.map((match) => match.sequence)).toEqual([1, 2]);

        if (!adapter.capabilities.regexSearch) {
          return;
        }

        const leafId = createSummaryNodeId('sum_conf_read_scope_leaf');
        const condensedId = createSummaryNodeId('sum_conf_read_scope_condensed');

        await runtime.dag.createNode(
          createSummaryNode({
            id: leafId,
            conversationId,
            kind: 'leaf',
            content: 'scoped leaf',
            tokenCount: createTokenCount(5),
            artifactIds: [],
            createdAt: createTimestamp(new Date('2026-03-01T00:20:00.000Z')),
          }),
        );
        await runtime.dag.createNode(
          createSummaryNode({
            id: condensedId,
            conversationId,
            kind: 'condensed',
            content: 'scoped condensed',
            tokenCount: createTokenCount(4),
            artifactIds: [],
            createdAt: createTimestamp(new Date('2026-03-01T00:20:30.000Z')),
          }),
        );
        await runtime.dag.addLeafEdges(leafId, [eventTwo.id]);
        await runtime.dag.addCondensedEdges(condensedId, [leafId]);

        const scoped = await runtime.ledger.regexSearchEvents(conversationId, 'auth', condensedId);
        expect(scoped).toHaveLength(1);
        expect(scoped[0]?.eventId).toBe(eventTwo.id);
      } finally {
        await runtime.destroy();
      }
    });
  });
};
