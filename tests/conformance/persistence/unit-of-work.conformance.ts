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
    id: createEventId(`evt_conf_uow_${conversationId}_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-03-01T00:40:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

export const registerUnitOfWorkConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('unit-of-work contract', () => {
    it('rolls back all mutations atomically when a later write fails', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const seedEvent = createEvent(conversationId, 1, 'seed event');

        await runtime.unitOfWork.execute(async (tx) => {
          await tx.ledger.appendEvents(conversationId, [seedEvent]);
          await tx.context.appendContextItems(conversationId, [
            createContextItem({
              conversationId,
              position: 0,
              ref: createMessageContextItemRef(seedEvent.id),
            }),
          ]);
        });

        const baseline = await runtime.unitOfWork.execute(async (tx) => {
          const context = await tx.context.getCurrentContext(conversationId);
          return {
            version: context.version,
            refs: context.items.map((item) => item.ref.type),
          };
        });
        const baselineEvents = (await runtime.ledger.getEvents(conversationId)).map((event) => event.id);

        const failingEvent = createEvent(conversationId, 2, 'should rollback');
        const summary = createSummaryNode({
          id: createSummaryNodeId('sum_conf_uow_atomic'),
          conversationId,
          kind: 'leaf',
          content: 'atomic rollback summary',
          tokenCount: createTokenCount(4),
          artifactIds: [],
          createdAt: createTimestamp(new Date('2026-03-01T00:42:00.000Z')),
        });

        await expect(
          runtime.unitOfWork.execute(async (tx) => {
            await tx.ledger.appendEvents(conversationId, [failingEvent]);
            await tx.dag.createNode(summary);
            await tx.dag.addLeafEdges(summary.id, [failingEvent.id]);

            await tx.context.replaceContextItems(
              conversationId,
              createContextVersion(0),
              [0],
              createContextItem({
                conversationId,
                position: 0,
                ref: createSummaryContextItemRef(summary.id),
              }),
            );
          }),
        ).rejects.toBeInstanceOf(StaleContextVersionError);

        const after = await runtime.unitOfWork.execute(async (tx) => {
          const context = await tx.context.getCurrentContext(conversationId);
          const createdSummary = await tx.dag.getNode(summary.id);
          return {
            version: context.version,
            refs: context.items.map((item) => item.ref.type),
            createdSummary,
          };
        });
        const afterEvents = (await runtime.ledger.getEvents(conversationId)).map((event) => event.id);

        expect(after.version).toBe(baseline.version);
        expect(after.refs).toEqual(baseline.refs);
        expect(afterEvents).toEqual(baselineEvents);
        expect(afterEvents).not.toContain(failingEvent.id);
        expect(after.createdSummary).toBeNull();
      } finally {
        await runtime.destroy();
      }
    });
  });
};
