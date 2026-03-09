import { randomUUID } from 'node:crypto';
import { hrtime } from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  createArtifactId,
  createCompactionThresholds,
  createContextItem,
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
  type ConversationId,
  type EventMetadata,
} from '@ledgermind/domain';

import { createPostgresTestHarness } from '../../packages/infrastructure/src/postgres/__tests__/postgres-test-harness';

const SC004_P95_MAX_MS = 1000;
const SCALE_EVENT_COUNT = 10_000;
const SCALE_CONCURRENT_CONVERSATIONS = 100;

interface TimedResult<T> {
  readonly value: T;
  readonly durationMs: number;
}

type DomainEvent = ReturnType<typeof createLedgerEvent>;

const nowMs = (): number => {
  return Number(hrtime.bigint()) / 1_000_000;
};

const withTiming = async <T>(operation: () => Promise<T>): Promise<TimedResult<T>> => {
  const startedAt = nowMs();
  const value = await operation();
  const finishedAt = nowMs();

  return {
    value,
    durationMs: finishedAt - startedAt,
  };
};

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
};

const assertP95WithinThreshold = (samples: readonly number[], label: string): void => {
  const p95 = percentile(samples, 95);

  expect(
    p95,
    `${label} p95 exceeded SC-004 limit (${p95.toFixed(2)}ms > ${SC004_P95_MAX_MS}ms)`,
  ).toBeLessThanOrEqual(SC004_P95_MAX_MS);
};

const createBulkEvent = (conversationId: ConversationId, sequence: number): DomainEvent => {
  const occurredAt = new Date('2026-02-06T00:00:00.000Z');
  occurredAt.setSeconds(sequence % 60, 0);

  const metadata: EventMetadata = Object.freeze({
    source: 'scale-test',
    batch: Math.floor((sequence - 1) / 500),
    artifactIds: [`file_scale_${Math.floor((sequence - 1) / 2_000)}`],
  });

  return createLedgerEvent({
    id: createEventId(`evt_scale_${conversationId}_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: sequence % 2 === 0 ? 'assistant' : 'user',
    content: `scale-event-${sequence} ${'payload '.repeat(16)}marker-${sequence % 13}`,
    tokenCount: createTokenCount(64),
    occurredAt: createTimestamp(occurredAt),
    metadata,
  });
};

const createSeededSummary = (
  conversationId: ConversationId,
  summaryId: ReturnType<typeof createSummaryNodeId>,
  sourceEventIds: readonly DomainEvent['id'][],
) => {
  return {
    summary: createSummaryNode({
      id: summaryId,
      conversationId,
      kind: 'leaf',
      content: '[Summary] Scale workload summary node.',
      tokenCount: createTokenCount(40),
      artifactIds: [createArtifactId('file_scale_0')],
      createdAt: createTimestamp(new Date('2026-02-06T00:30:00.000Z')),
    }),
    sourceEventIds,
  };
};

describe('postgres adapter scale + latency (SC-004 / SC-008)', () => {
  it(
    'handles up to 10k events per conversation while keeping append/context/expand p95 <= 1s',
    async () => {
      const harness = await createPostgresTestHarness();

      try {
        const { unitOfWork } = harness;

        const conversationId = await unitOfWork.execute(async (uow) => {
          const created = await uow.conversations.create(
            createConversationConfig({
              modelName: 'scale-10k-model',
              contextWindow: createTokenCount(128_000),
              thresholds: createCompactionThresholds(0.6, 1),
            }),
          );

          return created.id;
        });

        const events = Array.from({ length: SCALE_EVENT_COUNT }, (_, index) => {
          return createBulkEvent(conversationId, index + 1);
        });

        const appendDurations: number[] = [];
        const appendBatchSize = 250;

        for (let offset = 0; offset < events.length; offset += appendBatchSize) {
          const batch = events.slice(offset, offset + appendBatchSize);
          const append = await withTiming(async () => {
            await unitOfWork.execute(async (uow) => {
              await uow.ledger.appendEvents(conversationId, batch);
            });
          });

          appendDurations.push(append.durationMs);
        }

        const retrievedEvents = await harness.ledger.getEvents(conversationId);
        expect(retrievedEvents).toHaveLength(SCALE_EVENT_COUNT);

        await unitOfWork.execute(async (uow) => {
          await uow.context.appendContextItems(
            conversationId,
            events.map((event, index) =>
              createContextItem({
                conversationId,
                position: index,
                ref: createMessageContextItemRef(event.id),
              }),
            ),
          );
        });

        const contextReadDurations: number[] = [];
        for (let run = 0; run < 20; run += 1) {
          const contextRead = await withTiming(async () => {
            await unitOfWork.execute(async (uow) => {
              return uow.context.getCurrentContext(conversationId);
            });
          });

          contextReadDurations.push(contextRead.durationMs);
        }

        const summaryId = createSummaryNodeId(`sum_scale_${randomUUID().slice(0, 8)}`);
        const seed = createSeededSummary(
          conversationId,
          summaryId,
          events.slice(0, 2_000).map((event) => event.id),
        );

        await unitOfWork.execute(async (uow) => {
          await uow.dag.createNode(seed.summary);
          await uow.dag.addLeafEdges(seed.summary.id, seed.sourceEventIds);
          const snapshot = await uow.context.getCurrentContext(conversationId);

          await uow.context.replaceContextItems(
            conversationId,
            snapshot.version,
            [0, 1, 2, 3, 4],
            createContextItem({
              conversationId,
              position: 0,
              ref: createSummaryContextItemRef(seed.summary.id),
            }),
          );
        });

        const expandDurations: number[] = [];
        for (let run = 0; run < 20; run += 1) {
          const expansion = await withTiming(async () => {
            return unitOfWork.execute(async (uow) => uow.dag.expandToMessages(summaryId));
          });

          expandDurations.push(expansion.durationMs);
          expect(expansion.value).toHaveLength(seed.sourceEventIds.length);
        }

        assertP95WithinThreshold(appendDurations, 'append workload');
        assertP95WithinThreshold(contextReadDurations, 'context retrieval workload');
        assertP95WithinThreshold(expandDurations, 'summary expansion workload');
      } finally {
        await harness.destroy();
      }
    },
    180_000,
  );

  it(
    'supports up to 100 concurrent conversations with latency p95 <= 1s for append/context/expand',
    async () => {
      const harness = await createPostgresTestHarness();

      try {
        const { unitOfWork } = harness;

        const createConversationDurations: number[] = [];
        const conversationIds: ConversationId[] = [];

        for (let index = 0; index < SCALE_CONCURRENT_CONVERSATIONS; index += 1) {
          const created = await withTiming(async () => {
            return unitOfWork.execute(async (uow) => {
              return uow.conversations.create(
                createConversationConfig({
                  modelName: `concurrent-scale-${index + 1}`,
                  contextWindow: createTokenCount(16_384),
                  thresholds: createCompactionThresholds(0.6, 1),
                }),
              );
            });
          });

          createConversationDurations.push(created.durationMs);
          conversationIds.push(created.value.id);
        }

        const appendDurations: number[] = [];
        await Promise.all(
          conversationIds.map(async (conversationId, index) => {
            const event = createLedgerEvent({
              id: createEventId(`evt_concurrent_${conversationId}_1`),
              conversationId,
              sequence: createSequenceNumber(1),
              role: 'user',
              content: `concurrent-event-${index + 1}`,
              tokenCount: createTokenCount(12),
              occurredAt: createTimestamp(new Date('2026-02-06T01:00:00.000Z')),
              metadata: Object.freeze({ source: 'concurrent-scale' }),
            });

            const append = await withTiming(async () => {
              await unitOfWork.execute(async (uow) => {
                await uow.ledger.appendEvents(conversationId, [event]);
              });
            });

            appendDurations.push(append.durationMs);
          }),
        );

        const contextDurations: number[] = [];
        await Promise.all(
          conversationIds.map(async (conversationId, index) => {
            const summaryId = createSummaryNodeId(`sum_concurrent_${index + 1}`);

            const event = (await harness.ledger.getEvents(conversationId))[0];
            if (!event) {
              throw new Error('Expected seeded event for concurrent conversation.');
            }

            await unitOfWork.execute(async (uow) => {
              await uow.context.appendContextItems(conversationId, [
                createContextItem({
                  conversationId,
                  position: 0,
                  ref: createMessageContextItemRef(event.id),
                }),
              ]);

              await uow.dag.createNode(
                createSummaryNode({
                  id: summaryId,
                  conversationId,
                  kind: 'leaf',
                  content: `[Summary] concurrent-${index + 1}`,
                  tokenCount: createTokenCount(8),
                  artifactIds: [],
                  createdAt: createTimestamp(new Date('2026-02-06T01:10:00.000Z')),
                }),
              );
              await uow.dag.addLeafEdges(summaryId, [event.id]);
            });

            const contextRead = await withTiming(async () => {
              return unitOfWork.execute(async (uow) => uow.context.getCurrentContext(conversationId));
            });
            contextDurations.push(contextRead.durationMs);

            const expand = await withTiming(async () => {
              return unitOfWork.execute(async (uow) => uow.dag.expandToMessages(summaryId));
            });

            expect(expand.value).toHaveLength(1);
            contextDurations.push(expand.durationMs);
          }),
        );

        const appendSamples = [...createConversationDurations, ...appendDurations];
        assertP95WithinThreshold(appendSamples, 'concurrent append workload');
        assertP95WithinThreshold(contextDurations, 'concurrent context/expand workload');
      } finally {
        await harness.destroy();
      }
    },
    180_000,
  );
});
