import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { StaleContextVersionError } from '@ledgermind/application';
import { createContextItem, createMessageContextItemRef, createSummaryContextItemRef } from '@ledgermind/domain';
import { createContextVersion } from '@ledgermind/domain';
import { createEventId, createSummaryNodeId } from '@ledgermind/domain';
import type { ConversationId } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';
import { createLedgerEvent, createSummaryNode } from '@ledgermind/domain';
import { createSequenceNumber } from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

import { PgContextProjection } from '../pg-context-projection';
import type { PgExecutor } from '../types';
import { createPostgresTestHarness } from './postgres-test-harness';

const createMessage = (
  conversationId: ConversationId,
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

const createSingleClientExecutor = (pool: Pool, schemaName: string): PgExecutor => {
  const quotedSchema = `"${schemaName.replaceAll('"', '""')}"`;

  return {
    query: async <Row extends object = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) => {
      const client = await pool.connect();

      try {
        await client.query(`SET search_path TO ${quotedSchema}, public`);
        const result = await client.query<Row>(text, params as unknown[] | undefined);
        return {
          rows: result.rows,
          rowCount: result.rowCount,
        };
      } finally {
        client.release();
      }
    },
    release: () => undefined,
  };
};

describe('PgContextProjection', () => {
  it('appends context items contiguously and increments version', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, dag, conversationId } = harness;

      const event = createMessage(conversationId, 'evt_1', 1, 5);
      await ledger.appendEvents(conversationId, [event]);

      const summary = createSummaryNode({
        id: createSummaryNodeId('sum_1'),
        conversationId,
        kind: 'leaf',
        content: 'summary-1',
        tokenCount: createTokenCount(5),
        createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
      });
      await dag.createNode(summary);

      const firstVersion = await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 999,
          ref: createMessageContextItemRef(event.id),
        }),
        createContextItem({
          conversationId,
          position: 777,
          ref: createSummaryContextItemRef(summary.id),
        }),
      ]);

      expect(firstVersion).toBe(createContextVersion(1));

      const snapshot = await context.getCurrentContext(conversationId);
      expect(snapshot.version).toBe(createContextVersion(1));
      expect(snapshot.items.map((item) => item.position)).toEqual([0, 1]);
      expect(snapshot.items[0]?.ref.type).toBe('message');
      expect(snapshot.items[1]?.ref.type).toBe('summary');
    } finally {
      await harness.destroy();
    }
  });

  it('returns empty context snapshot with initialized version for a new conversation', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, conversationId } = harness;

      const snapshot = await context.getCurrentContext(conversationId);

      expect(snapshot.version).toBe(createContextVersion(0));
      expect(snapshot.items).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  it('returns latest version and deterministic ordering after append and replace mutations', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, dag, conversationId } = harness;

      const events = [
        createMessage(conversationId, 'evt_read_v1', 1, 5),
        createMessage(conversationId, 'evt_read_v2', 2, 5),
        createMessage(conversationId, 'evt_read_v3', 3, 5),
      ];
      await ledger.appendEvents(conversationId, events);

      const summary = createSummaryNode({
        id: createSummaryNodeId('sum_read_v1'),
        conversationId,
        kind: 'leaf',
        content: 'summary-read-v1',
        tokenCount: createTokenCount(5),
        createdAt: createTimestamp(new Date('2026-01-01T00:15:00.000Z')),
      });
      await dag.createNode(summary);

      const versionAfterAppend = await context.appendContextItems(
        conversationId,
        events.map((event, position) =>
          createContextItem({
            conversationId,
            position,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );

      const afterAppendSnapshot = await context.getCurrentContext(conversationId);
      expect(afterAppendSnapshot.version).toBe(versionAfterAppend);
      expect(afterAppendSnapshot.items.map((item) => item.position)).toEqual([0, 1, 2]);
      expect(afterAppendSnapshot.items.every((item) => item.ref.type === 'message')).toBe(true);

      const versionAfterReplace = await context.replaceContextItems(
        conversationId,
        versionAfterAppend,
        [0, 1],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summary.id),
        }),
      );

      const afterReplaceSnapshot = await context.getCurrentContext(conversationId);
      expect(afterReplaceSnapshot.version).toBe(versionAfterReplace);
      expect(afterReplaceSnapshot.items.map((item) => item.position)).toEqual([0, 1]);
      expect(afterReplaceSnapshot.items[0]?.ref.type).toBe('summary');
      expect(afterReplaceSnapshot.items[1]?.ref.type).toBe('message');
    } finally {
      await harness.destroy();
    }
  });

  it('returns deterministic snapshot/version values across projection re-instantiation', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { pool, schemaName, context, ledger, dag, conversationId } = harness;

      const eventA = createMessage(conversationId, 'evt_snapshot_a', 1, 5);
      const eventB = createMessage(conversationId, 'evt_snapshot_b', 2, 5);
      await ledger.appendEvents(conversationId, [eventA, eventB]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(eventA.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(eventB.id),
        }),
      ]);

      const summary = createSummaryNode({
        id: createSummaryNodeId('sum_snapshot_recovery'),
        conversationId,
        kind: 'leaf',
        content: 'summary-snapshot-recovery',
        tokenCount: createTokenCount(5),
        createdAt: createTimestamp(new Date('2026-01-01T00:16:00.000Z')),
      });
      await dag.createNode(summary);

      const recoveredContext = new PgContextProjection(createSingleClientExecutor(pool, schemaName));

      const beforeMutation = await recoveredContext.getCurrentContext(conversationId);
      expect(beforeMutation.version).toBe(createContextVersion(1));
      expect(beforeMutation.items.map((item) => item.position)).toEqual([0, 1]);
      expect(beforeMutation.items.every((item) => item.ref.type === 'message')).toBe(true);

      const nextVersion = await recoveredContext.replaceContextItems(
        conversationId,
        beforeMutation.version,
        [0],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summary.id),
        }),
      );
      expect(nextVersion).toBe(createContextVersion(2));

      const snapshotFromOriginal = await context.getCurrentContext(conversationId);
      const reloadedContext = new PgContextProjection(createSingleClientExecutor(pool, schemaName));
      const snapshotFromReloaded = await reloadedContext.getCurrentContext(conversationId);

      expect(snapshotFromOriginal).toEqual(snapshotFromReloaded);
      expect(snapshotFromOriginal.version).toBe(createContextVersion(2));
      expect(snapshotFromOriginal.items.map((item) => item.position)).toEqual([0, 1]);
      expect(snapshotFromOriginal.items[0]?.ref.type).toBe('summary');
      expect(snapshotFromOriginal.items[1]?.ref.type).toBe('message');
    } finally {
      await harness.destroy();
    }
  });

  it('computes token count from ledger events and summary nodes', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, context, dag, conversationId } = harness;

      const event = createMessage(conversationId, 'evt_ctx_pg_1', 1, 11);
      await ledger.appendEvents(conversationId, [event]);

      const summary = createSummaryNode({
        id: createSummaryNodeId('sum_ctx_pg_1'),
        conversationId,
        kind: 'leaf',
        content: 'summary',
        tokenCount: createTokenCount(7),
        createdAt: createTimestamp(new Date('2026-01-01T00:01:00.000Z')),
      });
      await dag.createNode(summary);

      await context.appendContextItems(conversationId, [
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

      const tokenCount = await context.getContextTokenCount(conversationId);
      expect(tokenCount.value).toBe(18);
    } finally {
      await harness.destroy();
    }
  });

  it('throws stale context version error on replace mismatch and leaves snapshot unchanged', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, conversationId } = harness;

      const eventA = createMessage(conversationId, 'evt_a', 1, 5);
      const eventB = createMessage(conversationId, 'evt_b', 2, 5);
      await ledger.appendEvents(conversationId, [eventA, eventB]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(eventA.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(eventB.id),
        }),
      ]);

      const before = await context.getCurrentContext(conversationId);

      await expect(
        context.replaceContextItems(
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

      const after = await context.getCurrentContext(conversationId);
      expect(after.version).toBe(before.version);
      expect(after.items).toEqual(before.items);
    } finally {
      await harness.destroy();
    }
  });

  it('allows only one concurrent replace at the same expected version and keeps context consistent', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, dag, conversationId } = harness;

      const eventA = createMessage(conversationId, 'evt_concurrent_a', 1, 5);
      const eventB = createMessage(conversationId, 'evt_concurrent_b', 2, 5);
      await ledger.appendEvents(conversationId, [eventA, eventB]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(eventA.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(eventB.id),
        }),
      ]);

      const replacementSummaryA = createSummaryNode({
        id: createSummaryNodeId('sum_concurrent_a'),
        conversationId,
        kind: 'leaf',
        content: 'summary-concurrent-a',
        tokenCount: createTokenCount(5),
        createdAt: createTimestamp(new Date('2026-01-01T00:21:00.000Z')),
      });
      const replacementSummaryB = createSummaryNode({
        id: createSummaryNodeId('sum_concurrent_b'),
        conversationId,
        kind: 'leaf',
        content: 'summary-concurrent-b',
        tokenCount: createTokenCount(5),
        createdAt: createTimestamp(new Date('2026-01-01T00:22:00.000Z')),
      });
      await dag.createNode(replacementSummaryA);
      await dag.createNode(replacementSummaryB);

      const before = await context.getCurrentContext(conversationId);
      expect(before.version).toBe(createContextVersion(1));

      const expectedVersion = before.version;
      const settled = await Promise.allSettled([
        context.replaceContextItems(
          conversationId,
          expectedVersion,
          [0],
          createContextItem({
            conversationId,
            position: 0,
            ref: createSummaryContextItemRef(replacementSummaryA.id),
          }),
        ),
        context.replaceContextItems(
          conversationId,
          expectedVersion,
          [0],
          createContextItem({
            conversationId,
            position: 0,
            ref: createSummaryContextItemRef(replacementSummaryB.id),
          }),
        ),
      ]);

      const successes = settled.filter((result) => result.status === 'fulfilled');
      const staleFailure = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' && result.reason instanceof StaleContextVersionError,
      );

      expect(successes).toHaveLength(1);
      expect(staleFailure).toBeDefined();

      const success = successes[0];
      expect(success).toBeDefined();
      if (!success || success.status !== 'fulfilled') {
        throw new Error('Expected one concurrent replace to succeed.');
      }

      expect(success.value).toBe(createContextVersion(2));

      if (!staleFailure) {
        throw new Error('Expected one concurrent replace to fail with stale context version.');
      }

      expect(staleFailure.reason.expectedVersion).toBe(expectedVersion);
      expect(staleFailure.reason.actualVersion).toBe(createContextVersion(2));

      const after = await context.getCurrentContext(conversationId);
      expect(after.version).toBe(createContextVersion(2));
      expect(after.items.map((item) => item.position)).toEqual([0, 1]);

      const firstItem = after.items[0];
      const secondItem = after.items[1];

      expect(firstItem).toBeDefined();
      expect(secondItem).toBeDefined();
      if (!firstItem || !secondItem) {
        throw new Error('Expected context items to exist after concurrent replace.');
      }

      expect(firstItem.ref.type).toBe('summary');
      expect(secondItem.ref.type).toBe('message');
      if (firstItem.ref.type === 'summary') {
        expect([replacementSummaryA.id, replacementSummaryB.id]).toContain(firstItem.ref.summaryId);
      }
    } finally {
      await harness.destroy();
    }
  });

  it('replaces removed positions with one summary item and reindexes', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, dag, conversationId } = harness;

      const events = [
        createMessage(conversationId, 'evt_1', 1, 5),
        createMessage(conversationId, 'evt_2', 2, 5),
        createMessage(conversationId, 'evt_3', 3, 5),
        createMessage(conversationId, 'evt_4', 4, 5),
      ];
      await ledger.appendEvents(conversationId, events);

      const replacementSummary = createSummaryNode({
        id: createSummaryNodeId('sum_new'),
        conversationId,
        kind: 'leaf',
        content: 'summary-new',
        tokenCount: createTokenCount(5),
        createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
      });
      await dag.createNode(replacementSummary);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(events[0]!.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(events[1]!.id),
        }),
        createContextItem({
          conversationId,
          position: 2,
          ref: createMessageContextItemRef(events[2]!.id),
        }),
        createContextItem({
          conversationId,
          position: 3,
          ref: createMessageContextItemRef(events[3]!.id),
        }),
      ]);

      const nextVersion = await context.replaceContextItems(
        conversationId,
        createContextVersion(1),
        [1, 2],
        createContextItem({
          conversationId,
          position: 1,
          ref: createSummaryContextItemRef(replacementSummary.id),
        }),
      );

      expect(nextVersion).toBe(createContextVersion(2));

      const snapshot = await context.getCurrentContext(conversationId);
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
    } finally {
      await harness.destroy();
    }
  });

  it('rejects out-of-range remove positions during replace', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, conversationId } = harness;

      const event = createMessage(conversationId, 'evt_1', 1, 5);
      await ledger.appendEvents(conversationId, [event]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      await expect(
        context.replaceContextItems(
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
    } finally {
      await harness.destroy();
    }
  });

  it('rejects context row with both message and summary refs at schema level', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, ledger, dag, withClient } = harness;
      const event = createMessage(conversationId, 'evt_ctx_schema_both', 1, 5);
      const summary = createSummaryNode({
        id: createSummaryNodeId('sum_ctx_schema_both'),
        conversationId,
        kind: 'leaf',
        content: 'schema-check-summary',
        tokenCount: createTokenCount(3),
        createdAt: createTimestamp(new Date('2026-01-01T00:20:00.000Z')),
      });

      await ledger.appendEvents(conversationId, [event]);
      await dag.createNode(summary);

      await expect(
        withClient(async (client) => {
          await client.query(
            `
              INSERT INTO context_items (conversation_id, position, message_id, summary_id)
              VALUES ($1, $2, $3, $4)
            `,
            [conversationId, 0, event.id, summary.id],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await harness.destroy();
    }
  });

  it('rejects context row with neither message nor summary ref at schema level', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, withClient } = harness;

      await expect(
        withClient(async (client) => {
          await client.query(
            `
              INSERT INTO context_items (conversation_id, position, message_id, summary_id)
              VALUES ($1, $2, NULL, NULL)
            `,
            [conversationId, 0],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await harness.destroy();
    }
  });
});
