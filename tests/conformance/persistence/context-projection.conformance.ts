import { describe, expect, it } from 'vitest';

import { StaleContextVersionError } from '@ledgermind/application';
import {
  createContextItem,
  createContextVersion,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  type ConversationId,
} from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from '../run-conformance';

const createEvent = (conversationId: ConversationId, sequence: number, content: string) => {
  return createLedgerEvent({
    id: createEventId(`evt_conf_context_${conversationId}_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-03-01T00:20:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

export const registerContextProjectionConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('context projection contract', () => {
    it('throws StaleContextVersionError on stale replace attempts', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const first = createEvent(conversationId, 1, 'context first');
        const second = createEvent(conversationId, 2, 'context second');

        await runtime.ledger.appendEvents(conversationId, [first, second]);
        await runtime.context.appendContextItems(conversationId, [
          createContextItem({
            conversationId,
            position: 0,
            ref: createMessageContextItemRef(first.id),
          }),
          createContextItem({
            conversationId,
            position: 1,
            ref: createMessageContextItemRef(second.id),
          }),
        ]);

        const summary = createSummaryNode({
          id: createSummaryNodeId('sum_conf_context_stale'),
          conversationId,
          kind: 'leaf',
          content: 'stale replacement summary',
          tokenCount: createTokenCount(6),
          artifactIds: [],
          createdAt: createTimestamp(new Date('2026-03-01T00:22:00.000Z')),
        });
        await runtime.dag.createNode(summary);

        await expect(
          runtime.context.replaceContextItems(
            conversationId,
            createContextVersion(0),
            [0],
            createContextItem({
              conversationId,
              position: 0,
              ref: createSummaryContextItemRef(summary.id),
            }),
          ),
        ).rejects.toBeInstanceOf(StaleContextVersionError);
      } finally {
        await runtime.destroy();
      }
    });

    it('keeps positions contiguous after successful replace', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const first = createEvent(conversationId, 1, 'contiguous first');
        const second = createEvent(conversationId, 2, 'contiguous second');

        await runtime.ledger.appendEvents(conversationId, [first, second]);
        await runtime.context.appendContextItems(conversationId, [
          createContextItem({
            conversationId,
            position: 0,
            ref: createMessageContextItemRef(first.id),
          }),
          createContextItem({
            conversationId,
            position: 1,
            ref: createMessageContextItemRef(second.id),
          }),
        ]);

        const summary = createSummaryNode({
          id: createSummaryNodeId('sum_conf_context_contiguous'),
          conversationId,
          kind: 'leaf',
          content: 'contiguous summary',
          tokenCount: createTokenCount(5),
          artifactIds: [],
          createdAt: createTimestamp(new Date('2026-03-01T00:23:00.000Z')),
        });
        await runtime.dag.createNode(summary);

        const before = await runtime.context.getCurrentContext(conversationId);

        await runtime.context.replaceContextItems(
          conversationId,
          before.version,
          [0],
          createContextItem({
            conversationId,
            position: 0,
            ref: createSummaryContextItemRef(summary.id),
          }),
        );

        const after = await runtime.context.getCurrentContext(conversationId);
        expect(after.items.map((item) => item.position)).toEqual([0, 1]);
        expect(after.items[0]?.ref.type).toBe('summary');
        expect(after.items[1]?.ref.type).toBe('message');
      } finally {
        await runtime.destroy();
      }
    });
  });
};
