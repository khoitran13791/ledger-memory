import { describe, expect, it } from 'vitest';

import { StaleContextVersionError } from '@ledgermind/application';
import {
  createArtifact,
  createArtifactId,
  createContextItem,
  createContextVersion,
  createConversationConfig,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createMimeType,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  InvariantViolationError,
} from '@ledgermind/domain';
import type { ConversationId } from '@ledgermind/domain';
import { createCompactionThresholds } from '@ledgermind/domain';

import { createPgUnitOfWork } from '../pg-unit-of-work';
import type { PgPoolClientLike, PgPoolLike } from '../types';

import { createPostgresTestHarness } from './postgres-test-harness';

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

const createInlineTextArtifact = (conversationId: ConversationId, id: string) => {
  return createArtifact({
    id: createArtifactId(id),
    conversationId,
    storageKind: 'inline_text',
    mimeType: createMimeType('text/plain'),
    tokenCount: createTokenCount(4),
  });
};

const createRetryableError = () => {
  return Object.assign(new Error('serialization failure'), { code: '40001' });
};

class AlwaysRetryableFailingClient implements PgPoolClientLike {
  readonly queries: string[] = [];

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }> {
    this.queries.push('query');
    void text;
    void params;
    throw createRetryableError();
  }

  release(): void {}
}

class AlwaysRetryableFailingPool implements PgPoolLike {
  readonly clients: AlwaysRetryableFailingClient[] = [];
  readonly connectAttempts: number[] = [];

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }> {
    void text;
    void params;
    throw new Error('not used in transaction path');
  }

  async connect(): Promise<PgPoolClientLike> {
    this.connectAttempts.push(this.connectAttempts.length + 1);
    const client = new AlwaysRetryableFailingClient();
    this.clients.push(client);
    return client;
  }
}

describe('PgUnitOfWork', () => {
  it('commits multi-store mutations when callback succeeds', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { unitOfWork, conversations, ledger } = harness;

      let createdConversationId: ConversationId | null = null;

      await unitOfWork.execute(async (tx) => {
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

      const createdConversation = await conversations.get(conversationId);
      expect(createdConversation).not.toBeNull();

      const ledgerEvents = await ledger.getEvents(conversationId);
      expect(ledgerEvents).toHaveLength(1);

      const contextSnapshot = await unitOfWork.execute(async (tx) => tx.context.getCurrentContext(conversationId));
      expect(contextSnapshot.items).toHaveLength(1);
      expect(contextSnapshot.version).toBe(createContextVersion(1));

      const summary = await unitOfWork.execute(async (tx) => tx.dag.getNode(createSummaryNodeId('sum_uow_1')));
      expect(summary).not.toBeNull();
    } finally {
      await harness.destroy();
    }
  });

  it('rolls back all mutations when callback throws', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { unitOfWork, conversations, ledger } = harness;

      const baselineConversationCount = (await conversations.getAncestorChain(harness.conversationId)).length + 1;

      await expect(
        unitOfWork.execute(async (tx) => {
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

      const chainAfter = await conversations.getAncestorChain(harness.conversationId);
      expect(chainAfter.length + 1).toBe(baselineConversationCount);

      const rolledBackEvents = await ledger.getEvents(harness.conversationId);
      expect(rolledBackEvents).toHaveLength(0);
    } finally {
      await harness.destroy();
    }
  });

  it('rolls back writes across ledger context dag and artifact stores when a later mutation fails', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { unitOfWork, ledger } = harness;

      const seedConversation = await unitOfWork.execute(async (tx) => tx.conversations.create(createConfig()));
      const seedEvent = createEvent(seedConversation.id, 1, 'seed');

      await unitOfWork.execute(async (tx) => {
        await tx.ledger.appendEvents(seedConversation.id, [seedEvent]);
        await tx.context.appendContextItems(seedConversation.id, [
          createContextItem({
            conversationId: seedConversation.id,
            position: 0,
            ref: createMessageContextItemRef(seedEvent.id),
          }),
        ]);
      });

      const beforeState = await unitOfWork.execute(async (tx) => {
        const context = await tx.context.getCurrentContext(seedConversation.id);
        const summary = await tx.dag.getNode(createSummaryNodeId('sum_uow_atomicity'));
        const artifact = await tx.artifacts.getMetadata(createArtifactId('file_uow_atomicity'));

        return {
          contextVersion: context.version,
          contextItems: context.items,
          summaryExists: summary !== null,
          artifactExists: artifact !== null,
        };
      });
      const before = {
        eventIds: (await ledger.getEvents(seedConversation.id)).map((event) => event.id),
        ...beforeState,
      };

      const nextEvent = createEvent(seedConversation.id, 2, 'atomic candidate');
      const summary = createLeafSummary(seedConversation.id, 'sum_uow_atomicity');
      const artifact = createInlineTextArtifact(seedConversation.id, 'file_uow_atomicity');

      await expect(
        unitOfWork.execute(async (tx) => {
          await tx.ledger.appendEvents(seedConversation.id, [nextEvent]);
          await tx.context.appendContextItems(seedConversation.id, [
            createContextItem({
              conversationId: seedConversation.id,
              position: 99,
              ref: createMessageContextItemRef(nextEvent.id),
            }),
          ]);
          await tx.dag.createNode(summary);
          await tx.dag.addLeafEdges(summary.id, [nextEvent.id]);
          await tx.artifacts.store(artifact, 'artifact-text');

          await tx.context.replaceContextItems(
            seedConversation.id,
            createContextVersion(0),
            [0],
            createContextItem({
              conversationId: seedConversation.id,
              position: 0,
              ref: createSummaryContextItemRef(summary.id),
            }),
          );
        }),
      ).rejects.toBeInstanceOf(StaleContextVersionError);

      const afterState = await unitOfWork.execute(async (tx) => {
        const context = await tx.context.getCurrentContext(seedConversation.id);
        const summaryAfter = await tx.dag.getNode(summary.id);
        const artifactAfter = await tx.artifacts.getMetadata(artifact.id);

        return {
          contextVersion: context.version,
          contextItems: context.items,
          summaryExists: summaryAfter !== null,
          artifactExists: artifactAfter !== null,
        };
      });
      const after = {
        eventIds: (await ledger.getEvents(seedConversation.id)).map((event) => event.id),
        ...afterState,
      };

      expect(after).toEqual(before);
      expect(after.eventIds).not.toContain(nextEvent.id);
      expect(after.summaryExists).toBe(false);
      expect(after.artifactExists).toBe(false);
    } finally {
      await harness.destroy();
    }
  });

  it('rolls back on stale context version conflict with no partial writes', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { unitOfWork, ledger } = harness;

      const seedConversation = await unitOfWork.execute(async (tx) => tx.conversations.create(createConfig()));
      const seedEvent = createEvent(seedConversation.id, 1, 'seed');

      await unitOfWork.execute(async (tx) => {
        await tx.ledger.appendEvents(seedConversation.id, [seedEvent]);
        await tx.context.appendContextItems(seedConversation.id, [
          createContextItem({
            conversationId: seedConversation.id,
            position: 0,
            ref: createMessageContextItemRef(seedEvent.id),
          }),
        ]);
      });

      const beforeSnapshot = await unitOfWork.execute(async (tx) => {
        const context = await tx.context.getCurrentContext(seedConversation.id);
        const summary = await tx.dag.getNode(createSummaryNodeId('sum_uow_conflict'));

        return {
          contextItemsCount: context.items.length,
          contextVersion: context.version,
          summaryExists: summary !== null,
        };
      });

      const nextEvent = createEvent(seedConversation.id, 2, 'candidate');

      await expect(
        unitOfWork.execute(async (tx) => {
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

      const afterSnapshot = await unitOfWork.execute(async (tx) => {
        const context = await tx.context.getCurrentContext(seedConversation.id);
        const summary = await tx.dag.getNode(createSummaryNodeId('sum_uow_conflict'));

        return {
          contextItemsCount: context.items.length,
          contextVersion: context.version,
          summaryExists: summary !== null,
        };
      });

      expect(afterSnapshot).toEqual(beforeSnapshot);

      const allEvents = await ledger.getEvents(seedConversation.id);
      expect(allEvents.some((event) => event.id === nextEvent.id)).toBe(false);
    } finally {
      await harness.destroy();
    }
  });

  it('propagates typed retryable failure after bounded retry exhaustion', async () => {
    const executor = new AlwaysRetryableFailingPool();
    const unitOfWork = createPgUnitOfWork(executor);

    await expect(
      unitOfWork.execute(async () => {
        throw new Error('work should not run when begin fails');
      }),
    ).rejects.toMatchObject({
      name: 'PgRetryExhaustedError',
      code: 'PERSISTENCE_RETRY_EXHAUSTED',
      retryability: 'retryable',
      attempts: 3,
      sqlState: '40001',
    });

    expect(executor.connectAttempts).toHaveLength(3);
    for (const client of executor.clients) {
      expect(client.queries).toEqual(['query', 'query']);
    }
  });

  it('honors maxAttempts override for retry exhaustion propagation', async () => {
    const executor = new AlwaysRetryableFailingPool();
    const unitOfWork = createPgUnitOfWork(executor);

    await expect(
      unitOfWork.execute(
        async () => {
          throw new Error('work should not run when begin fails');
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toMatchObject({
      name: 'PgRetryExhaustedError',
      code: 'PERSISTENCE_RETRY_EXHAUSTED',
      retryability: 'retryable',
      attempts: 1,
      sqlState: '40001',
    });

    expect(executor.connectAttempts).toHaveLength(1);
    for (const client of executor.clients) {
      expect(client.queries).toEqual(['query', 'query']);
    }
  });

  it('fails fast on non-retryable failure without retry exhaustion wrapping', async () => {
    let connectAttempts = 0;
    const unitOfWork = createPgUnitOfWork({
      async query() {
        throw new Error('not used in transaction path');
      },
      async connect() {
        connectAttempts += 1;

        return {
          async query(text: string) {
            if (text === 'BEGIN') {
              throw Object.assign(new Error('check violation'), { code: '23514' });
            }

            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    });

    await expect(
      unitOfWork.execute(async () => {
        throw new Error('work should not run when begin fails');
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    expect(connectAttempts).toBe(1);
  });
});
