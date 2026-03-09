import { describe, expect, it } from 'vitest';

import { IdempotencyConflictError } from '@ledgermind/application';
import { createLedgerEvent } from '@ledgermind/domain';
import { createEventId, createSequenceNumber, createSummaryNode, createSummaryNodeId } from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';
import type { ConversationId, EventMetadata } from '@ledgermind/domain';
import { NonMonotonicSequenceError } from '@ledgermind/domain';

import { PgLedgerStore } from '../pg-ledger-store';
import { createExecutorForClient, createPostgresTestHarness } from './postgres-test-harness';

const createEvent = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
  metadata: EventMetadata = {},
) => {
  return createLedgerEvent({
    id: createEventId(`evt_${conversationId}_${sequence}_${content.replace(/\s+/g, '_')}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata,
  });
};

const setupScopedSearchFixture = async (
  harness: Awaited<ReturnType<typeof createPostgresTestHarness>>,
): Promise<{
  readonly conversationId: ConversationId;
  readonly scopedSummaryId: ReturnType<typeof createSummaryNodeId>;
  readonly scopedEventIds: readonly ReturnType<typeof createEventId>[];
  readonly allEventIds: readonly ReturnType<typeof createEventId>[];
}> => {
  const { ledger, dag, conversationId, withClient } = harness;

  const evt1 = createEvent(conversationId, 1, 'alpha scope one');
  const evt2 = createEvent(conversationId, 2, 'alpha scope two');
  const evt3 = createEvent(conversationId, 3, 'alpha outside one');
  const evt4 = createEvent(conversationId, 4, 'alpha outside two');

  await ledger.appendEvents(conversationId, [evt1, evt2, evt3, evt4]);

  const scopedLeafId = createSummaryNodeId('sum_scope_desc_leaf_in');
  const scopedLeaf = createSummaryNode({
    id: scopedLeafId,
    conversationId,
    kind: 'leaf',
    content: 'scoped leaf summary',
    tokenCount: createTokenCount(8),
    artifactIds: [],
    createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
  });

  const scopedCondensedId = createSummaryNodeId('sum_scope_desc_condensed');
  const scopedCondensed = createSummaryNode({
    id: scopedCondensedId,
    conversationId,
    kind: 'condensed',
    content: 'scoped condensed summary',
    tokenCount: createTokenCount(8),
    artifactIds: [],
    createdAt: createTimestamp(new Date('2026-01-01T00:10:30.000Z')),
  });

  const outsideLeafId = createSummaryNodeId('sum_scope_desc_leaf_out');
  const outsideLeaf = createSummaryNode({
    id: outsideLeafId,
    conversationId,
    kind: 'leaf',
    content: 'outside leaf summary',
    tokenCount: createTokenCount(8),
    artifactIds: [],
    createdAt: createTimestamp(new Date('2026-01-01T00:11:00.000Z')),
  });

  await dag.createNode(scopedLeaf);
  await dag.createNode(scopedCondensed);
  await dag.createNode(outsideLeaf);

  await dag.addLeafEdges(scopedLeafId, [evt1.id, evt2.id]);
  await dag.addLeafEdges(outsideLeafId, [evt3.id, evt4.id]);

  await withClient(async (client) => {
    await client.query(
      `INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
       VALUES ($1, $2, $3)`,
      [scopedCondensedId, scopedLeafId, 0],
    );
  });

  return {
    conversationId,
    scopedSummaryId: scopedCondensedId,
    scopedEventIds: [evt1.id, evt2.id],
    allEventIds: [evt1.id, evt2.id, evt3.id, evt4.id],
  };
};

describe('PgLedgerStore', () => {
  it('appends events atomically in input order and supports range reads', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;

      const events = [
        createEvent(conversationId, 1, 'alpha event'),
        createEvent(conversationId, 2, 'beta event'),
        createEvent(conversationId, 3, 'gamma event'),
      ];

      await ledger.appendEvents(conversationId, events);

      const allEvents = await ledger.getEvents(conversationId);
      expect(allEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);

      const rangeEvents = await ledger.getEvents(conversationId, {
        start: createSequenceNumber(2),
        end: createSequenceNumber(3),
      });
      expect(rangeEvents.map((event) => event.sequence)).toEqual([2, 3]);
    } finally {
      await harness.destroy();
    }
  });

  it('round-trips persisted event fields with full fidelity', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;

      const source = createLedgerEvent({
        id: createEventId(`evt_${conversationId}_roundtrip_1`),
        conversationId,
        sequence: createSequenceNumber(1),
        role: 'assistant',
        content: 'round-trip payload with nested metadata',
        tokenCount: createTokenCount(42),
        occurredAt: createTimestamp(new Date('2026-01-01T00:00:01.000Z')),
        metadata: {
          artifactIds: ['file_rt_1'],
          nested: {
            attempt: 1,
          },
        },
      });

      await ledger.appendEvents(conversationId, [source]);

      const loaded = await ledger.getEvents(conversationId);
      expect(loaded).toEqual([source]);
    } finally {
      await harness.destroy();
    }
  });

  it('rejects duplicate (conversation_id, seq) at schema level', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId, withClient } = harness;

      await ledger.appendEvents(conversationId, [createEvent(conversationId, 1, 'seed')]);

      await expect(
        withClient(async (client) => {
          await client.query(
            `
              INSERT INTO ledger_events (
                id,
                conversation_id,
                seq,
                role,
                content,
                token_count,
                occurred_at,
                metadata,
                idempotency_key
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
            `,
            [
              createEventId(`evt_${conversationId}_dup_seq_raw_1`),
              conversationId,
              1,
              'user',
              'raw duplicate seq',
              5,
              '2026-01-01T00:00:59.000Z',
              '{}',
              null,
            ],
          );
        }),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await harness.destroy();
    }
  });

  it('rejects negative token_count at schema level', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, withClient } = harness;

      await expect(
        withClient(async (client) => {
          await client.query(
            `
              INSERT INTO ledger_events (
                id,
                conversation_id,
                seq,
                role,
                content,
                token_count,
                occurred_at,
                metadata,
                idempotency_key
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
            `,
            [
              createEventId(`evt_${conversationId}_neg_token_raw_1`),
              conversationId,
              1,
              'user',
              'raw negative token count',
              -1,
              '2026-01-01T00:00:58.000Z',
              '{}',
              null,
            ],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await harness.destroy();
    }
  });

  it('treats duplicate event IDs as idempotent no-op', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;
      const first = createEvent(conversationId, 1, 'same event');

      await ledger.appendEvents(conversationId, [first]);
      await ledger.appendEvents(conversationId, [first]);

      const allEvents = await ledger.getEvents(conversationId);
      expect(allEvents).toHaveLength(1);
      expect(allEvents[0]?.id).toBe(first.id);
    } finally {
      await harness.destroy();
    }
  });

  it('rejects non-monotonic sequence append', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;

      await ledger.appendEvents(conversationId, [createEvent(conversationId, 1, 'first')]);

      await expect(
        ledger.appendEvents(conversationId, [createEvent(conversationId, 3, 'gap')]),
      ).rejects.toBeInstanceOf(NonMonotonicSequenceError);

      const events = await ledger.getEvents(conversationId);
      expect(events.map((event) => event.sequence)).toEqual([1]);
    } finally {
      await harness.destroy();
    }
  });

  it('serializes concurrent appends on the same conversation and keeps sequences contiguous', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, withClient } = harness;

      await withClient(async (clientA) => {
        await withClient(async (clientB) => {
          await clientA.query('BEGIN');
          await clientB.query('BEGIN');

          let committedA = false;
          let committedB = false;

          try {
            await clientA.query(
              `SELECT id
               FROM conversations
               WHERE id = $1
               FOR UPDATE`,
              [conversationId],
            );

            const ledgerA = new PgLedgerStore(createExecutorForClient(clientA));
            const ledgerB = new PgLedgerStore(createExecutorForClient(clientB));

            const appendFromA = async () => {
              await ledgerA.appendEvents(conversationId, [createEvent(conversationId, 1, 'concurrent alpha')]);
              await clientA.query('COMMIT');
              committedA = true;
            };

            const appendFromB = async () => {
              await ledgerB.appendEvents(conversationId, [createEvent(conversationId, 2, 'concurrent beta')]);
              await clientB.query('COMMIT');
              committedB = true;
            };

            await Promise.all([appendFromA(), appendFromB()]);
          } finally {
            if (!committedA) {
              try {
                await clientA.query('ROLLBACK');
              } catch {
                // Ignore rollback cleanup failures in test harness.
              }
            }

            if (!committedB) {
              try {
                await clientB.query('ROLLBACK');
              } catch {
                // Ignore rollback cleanup failures in test harness.
              }
            }
          }
        });
      });

      const events = await harness.ledger.getEvents(conversationId);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(events.map((event) => event.content)).toEqual(['concurrent alpha', 'concurrent beta']);
    } finally {
      await harness.destroy();
    }
  });

  it('scopes full-text search to descendant summaries only', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const fixture = await setupScopedSearchFixture(harness);

      const scopedSearchMatches = await harness.ledger.searchEvents(
        fixture.conversationId,
        'alpha',
        fixture.scopedSummaryId,
      );
      expect(scopedSearchMatches.map((event) => event.id)).toEqual(fixture.scopedEventIds);

      const unscopedSearchMatches = await harness.ledger.searchEvents(fixture.conversationId, 'alpha');
      expect(unscopedSearchMatches.map((event) => event.id)).toEqual(fixture.allEventIds);
    } finally {
      await harness.destroy();
    }
  });

  it('scopes regex search to descendant summaries only', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const fixture = await setupScopedSearchFixture(harness);

      const scopedRegexMatches = await harness.ledger.regexSearchEvents(
        fixture.conversationId,
        'alpha',
        fixture.scopedSummaryId,
      );
      expect(scopedRegexMatches.map((match) => match.eventId)).toEqual(fixture.scopedEventIds);
      expect(scopedRegexMatches.every((match) => match.coveringSummaryId === fixture.scopedSummaryId)).toBe(true);

      const unscopedRegexMatches = await harness.ledger.regexSearchEvents(fixture.conversationId, 'alpha');
      expect(unscopedRegexMatches.map((match) => match.eventId)).toEqual(fixture.allEventIds);
    } finally {
      await harness.destroy();
    }
  });

  it('returns regex matches with sequence ordering and bounded excerpts', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;

      const evt1 = createEvent(conversationId, 1, `${'a'.repeat(60)} alpha ${'b'.repeat(60)}`);
      const evt2 = createEvent(conversationId, 2, `${'c'.repeat(60)} alpha ${'d'.repeat(60)}`);
      await ledger.appendEvents(conversationId, [evt1, evt2]);

      const matches = await ledger.regexSearchEvents(conversationId, 'alpha');

      expect(matches.map((match) => match.sequence)).toEqual([1, 2]);
      expect(matches.map((match) => match.eventId)).toEqual([evt1.id, evt2.id]);
      expect(matches.every((match) => match.excerpt.includes('alpha'))).toBe(true);
      expect(matches.every((match) => match.excerpt.length <= 53)).toBe(true);
      expect(matches.every((match) => match.excerpt.length < evt1.content.length)).toBe(true);
      expect(matches.every((match) => match.coveringSummaryId === undefined)).toBe(true);
    } finally {
      await harness.destroy();
    }
  });

  it('persists idempotency key extracted from metadata', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId, withClient } = harness;
      const event = createEvent(conversationId, 1, 'alpha event', {
        __ledgermind_idempotencyKey: 'idem-key',
        __ledgermind_idempotencyDigest: 'digest-alpha',
      });

      await ledger.appendEvents(conversationId, [event]);

      await withClient(async (client) => {
        const result = await client.query<{ readonly idempotency_key: string | null }>(
          `
            SELECT idempotency_key
            FROM ledger_events
            WHERE id = $1
          `,
          [event.id],
        );

        expect(result.rows[0]?.idempotency_key).toBe('idem-key');
      });
    } finally {
      await harness.destroy();
    }
  });

  it('persists batch idempotency key exactly once for multi-event append', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId, withClient } = harness;
      const first = createEvent(conversationId, 1, 'batch alpha', {
        __ledgermind_idempotencyKey: 'batch-key',
        __ledgermind_idempotencyDigest: 'batch-digest',
      });
      const second = createEvent(conversationId, 2, 'batch beta', {
        __ledgermind_idempotencyKey: 'batch-key',
        __ledgermind_idempotencyDigest: 'batch-digest',
      });

      await ledger.appendEvents(conversationId, [first, second]);

      const allEvents = await ledger.getEvents(conversationId);
      expect(allEvents.map((event) => event.sequence)).toEqual([1, 2]);

      await withClient(async (client) => {
        const result = await client.query<{
          readonly seq: number | string;
          readonly idempotency_key: string | null;
        }>(
          `
            SELECT seq, idempotency_key
            FROM ledger_events
            WHERE conversation_id = $1
            ORDER BY seq ASC
          `,
          [conversationId],
        );

        expect(result.rows).toEqual([
          { seq: '1', idempotency_key: 'batch-key' },
          { seq: '2', idempotency_key: null },
        ]);
      });
    } finally {
      await harness.destroy();
    }
  });

  it('treats same idempotency key with same digest as no-op success', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;
      const first = createEvent(conversationId, 1, 'payload alpha', {
        __ledgermind_idempotencyKey: 'shared-key',
        __ledgermind_idempotencyDigest: 'digest-alpha',
      });
      const duplicatePayload = createEvent(conversationId, 2, 'payload retry', {
        __ledgermind_idempotencyKey: 'shared-key',
        __ledgermind_idempotencyDigest: 'digest-alpha',
      });

      await ledger.appendEvents(conversationId, [first]);
      await ledger.appendEvents(conversationId, [duplicatePayload]);

      const allEvents = await ledger.getEvents(conversationId);
      expect(allEvents).toHaveLength(1);
      expect(allEvents[0]?.id).toBe(first.id);
      expect(allEvents[0]?.content).toBe('payload alpha');
    } finally {
      await harness.destroy();
    }
  });

  it('throws typed conflict for same idempotency key with different digest', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;
      const first = createEvent(conversationId, 1, 'payload alpha', {
        __ledgermind_idempotencyKey: 'shared-key',
        __ledgermind_idempotencyDigest: 'digest-alpha',
      });
      const conflictingPayload = createEvent(conversationId, 2, 'payload beta', {
        __ledgermind_idempotencyKey: 'shared-key',
        __ledgermind_idempotencyDigest: 'digest-beta',
      });

      await ledger.appendEvents(conversationId, [first]);

      await expect(ledger.appendEvents(conversationId, [conflictingPayload])).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );

      const allEvents = await ledger.getEvents(conversationId);
      expect(allEvents).toHaveLength(1);
      expect(allEvents[0]?.id).toBe(first.id);
      expect(allEvents[0]?.content).toBe('payload alpha');
    } finally {
      await harness.destroy();
    }
  });
});
