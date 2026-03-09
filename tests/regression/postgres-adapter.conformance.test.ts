import { describe, expect, it } from 'vitest';

import { IdempotencyConflictError, StaleContextVersionError } from '@ledgermind/application';
import {
  createArtifactId,
  createCompactionThresholds,
  createContextItem,
  createContextVersion,
  createConversationConfig,
  createConversationId,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  InvariantViolationError,
} from '@ledgermind/domain';
import type { ConversationId } from '@ledgermind/domain';
import { createPgUnitOfWork } from '@ledgermind/infrastructure';
import type { PgPoolClientLike, PgPoolLike } from '@ledgermind/infrastructure';

import { createPostgresTestHarness } from '../../packages/infrastructure/src/postgres/__tests__/postgres-test-harness';

const createConversationCfg = (modelName: string) => {
  return createConversationConfig({
    modelName,
    contextWindow: createTokenCount(4096),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

const createEvent = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
  metadata: Record<string, unknown> = {},
) => {
  return createLedgerEvent({
    id: createEventId(`evt_conf_${conversationId}_${sequence}_${content.replace(/\s+/g, '_')}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata,
  });
};

const createLeafSummary = (
  conversationId: ConversationId,
  id: string,
  artifactIds: readonly string[] = [],
) => {
  return createSummaryNode({
    id: createSummaryNodeId(id),
    conversationId,
    kind: 'leaf',
    content: `summary-${id}`,
    tokenCount: createTokenCount(6),
    artifactIds: artifactIds.map((artifactId) => createArtifactId(artifactId)),
    createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
  });
};

const CHECK_NAMES = [
  'no_orphan_edges',
  'no_orphan_context_refs',
  'acyclic_dag',
  'leaf_coverage',
  'condensed_coverage',
  'contiguous_positions',
  'monotonic_sequence',
  'artifact_propagation',
] as const;

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

describe('postgres adapter conformance (FR-014 / FR-016)', () => {
  it('enforces idempotency semantics for same-key retries and conflicts', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;

      const first = createEvent(conversationId, 1, 'idempotent payload', {
        __ledgermind_idempotencyKey: 'idem-key',
        __ledgermind_idempotencyDigest: 'digest-alpha',
      });

      const sameDigestRetry = createEvent(conversationId, 2, 'retry payload different body', {
        __ledgermind_idempotencyKey: 'idem-key',
        __ledgermind_idempotencyDigest: 'digest-alpha',
      });

      const conflictingRetry = createEvent(conversationId, 2, 'conflict payload', {
        __ledgermind_idempotencyKey: 'idem-key',
        __ledgermind_idempotencyDigest: 'digest-beta',
      });

      await ledger.appendEvents(conversationId, [first]);
      await ledger.appendEvents(conversationId, [sameDigestRetry]);

      const afterNoopRetry = await ledger.getEvents(conversationId);
      expect(afterNoopRetry).toHaveLength(1);
      expect(afterNoopRetry[0]?.id).toBe(first.id);

      await expect(ledger.appendEvents(conversationId, [conflictingRetry])).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );

      const afterConflict = await ledger.getEvents(conversationId);
      expect(afterConflict).toHaveLength(1);
      expect(afterConflict[0]?.id).toBe(first.id);
    } finally {
      await harness.destroy();
    }
  });

  it('rejects stale context replacement and preserves contiguous stable context state', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, ledger, dag, conversationId } = harness;

      const evt1 = createEvent(conversationId, 1, 'context-first');
      const evt2 = createEvent(conversationId, 2, 'context-second');
      await ledger.appendEvents(conversationId, [evt1, evt2]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(evt1.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(evt2.id),
        }),
      ]);

      const summary = createLeafSummary(conversationId, 'sum_conf_stale');
      await dag.createNode(summary);

      const before = await context.getCurrentContext(conversationId);
      expect(before.items.map((item) => item.position)).toEqual([0, 1]);

      await expect(
        context.replaceContextItems(
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

      const after = await context.getCurrentContext(conversationId);
      expect(after.version).toBe(before.version);
      expect(after.items).toEqual(before.items);
      expect(after.items.map((item) => item.position)).toEqual([0, 1]);
    } finally {
      await harness.destroy();
    }
  });

  it('expands summary lineage in sequence order and reports all integrity families as passing', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, dag, context, conversationId } = harness;

      const evt1 = createEvent(conversationId, 1, 'alpha', { artifactIds: ['file_alpha'] });
      const evt2 = createEvent(conversationId, 2, 'beta');
      await ledger.appendEvents(conversationId, [evt1, evt2]);

      const leaf = createLeafSummary(conversationId, 'sum_conf_leaf', ['file_alpha']);

      const condensed = createSummaryNode({
        id: createSummaryNodeId('sum_conf_condensed'),
        conversationId,
        kind: 'condensed',
        content: 'condensed-content',
        tokenCount: createTokenCount(5),
        artifactIds: [createArtifactId('file_alpha')],
        createdAt: createTimestamp(new Date('2026-01-01T00:12:00.000Z')),
      });

      await dag.createNode(leaf);
      await dag.createNode(condensed);
      await dag.addLeafEdges(leaf.id, [evt1.id, evt2.id]);
      await dag.addCondensedEdges(condensed.id, [leaf.id]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 100,
          ref: createSummaryContextItemRef(condensed.id),
        }),
      ]);

      const expanded = await dag.expandToMessages(condensed.id);
      expect(expanded.map((event) => event.sequence)).toEqual([1, 2]);
      expect(expanded.map((event) => event.id)).toEqual([evt1.id, evt2.id]);

      const report = await dag.checkIntegrity(conversationId);
      expect(report.passed).toBe(true);
      expect(report.checks.map((check) => check.name)).toEqual(CHECK_NAMES);
      expect(report.checks.every((check) => check.passed)).toBe(true);
    } finally {
      await harness.destroy();
    }
  });

  it('preserves persisted conversation/ledger state across store re-instantiation', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { pool, schemaName, conversations, ledger } = harness;

      const root = await conversations.create(createConversationCfg('root'));
      const child = await conversations.create(createConversationCfg('child'), root.id);
      const event = createEvent(child.id, 1, 'recovery-event');
      await ledger.appendEvents(child.id, [event]);

      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName.replaceAll('"', '""')}", public`);

        const reloadedUow = createPgUnitOfWork({
          query: async <Row extends object = Record<string, unknown>>(
            text: string,
            params?: readonly unknown[],
          ) => {
            const result = await client.query<Row>(text, params as unknown[] | undefined);
            return {
              rows: result.rows,
              rowCount: result.rowCount,
            };
          },
          connect: async () => {
            return {
              query: async <Row extends object = Record<string, unknown>>(
                text: string,
                params?: readonly unknown[],
              ) => {
                const result = await client.query<Row>(text, params as unknown[] | undefined);
                return {
                  rows: result.rows,
                  rowCount: result.rowCount,
                };
              },
              release: () => undefined,
            };
          },
        });

        const recovered = await reloadedUow.execute(async (tx) => {
          const loadedChild = await tx.conversations.get(child.id);
          const chain = await tx.conversations.getAncestorChain(child.id);

          return {
            loadedChild,
            chain,
          };
        });

        const recoveredEvents = await ledger.getEvents(child.id);

        expect(recovered.loadedChild?.id).toBe(child.id);
        expect(recovered.chain).toEqual([root.id]);
        expect(recoveredEvents.map((item) => item.id)).toEqual([event.id]);
      } finally {
        client.release();
      }
    } finally {
      await harness.destroy();
    }
  });

  it('rolls back multi-store writes atomically when later mutation fails', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { unitOfWork, ledger } = harness;

      const seedConversation = await unitOfWork.execute(async (tx) => tx.conversations.create(createConversationCfg('seed')));
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

      const before = await unitOfWork.execute(async (tx) => {
        const context = await tx.context.getCurrentContext(seedConversation.id);
        return {
          version: context.version,
          refs: context.items.map((item) => item.ref.type),
        };
      });
      const beforeEventIds = (await ledger.getEvents(seedConversation.id)).map((event) => event.id);

      const nextEvent = createEvent(seedConversation.id, 2, 'should-rollback');
      const summary = createLeafSummary(seedConversation.id, 'sum_conf_atomic');

      await expect(
        unitOfWork.execute(async (tx) => {
          await tx.ledger.appendEvents(seedConversation.id, [nextEvent]);
          await tx.dag.createNode(summary);
          await tx.dag.addLeafEdges(summary.id, [nextEvent.id]);

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

      const after = await unitOfWork.execute(async (tx) => {
        const context = await tx.context.getCurrentContext(seedConversation.id);
        return {
          version: context.version,
          refs: context.items.map((item) => item.ref.type),
          summary: await tx.dag.getNode(summary.id),
        };
      });
      const afterEventIds = (await ledger.getEvents(seedConversation.id)).map((event) => event.id);

      expect(after.version).toBe(before.version);
      expect(after.refs).toEqual(before.refs);
      expect(afterEventIds).toEqual(beforeEventIds);
      expect(afterEventIds).not.toContain(nextEvent.id);
      expect(after.summary).toBeNull();
    } finally {
      await harness.destroy();
    }
  });

  it('returns typed retryable error after bounded retry exhaustion for transient failures', async () => {
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

  it('fails fast on non-retryable begin failure without retry wrapping', async () => {
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

  it('supports deterministic ordered range and search retrieval on persisted ledger data', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, dag, conversationId } = harness;

      const evt1 = createEvent(conversationId, 1, 'alpha banana');
      const evt2 = createEvent(conversationId, 2, 'beta carrot');
      const evt3 = createEvent(conversationId, 3, 'alpha delta');

      await ledger.appendEvents(conversationId, [evt1, evt2, evt3]);

      const range = await ledger.getEvents(conversationId, {
        start: createSequenceNumber(2),
        end: createSequenceNumber(3),
      });
      expect(range.map((event) => event.sequence)).toEqual([2, 3]);

      const textMatches = await ledger.searchEvents(conversationId, 'alpha');
      expect(textMatches.map((event) => event.id)).toEqual([evt1.id, evt3.id]);

      const scopedLeaf = createLeafSummary(conversationId, 'sum_conf_scope_leaf');
      const scopedCondensed = createSummaryNode({
        id: createSummaryNodeId('sum_conf_scope_condensed'),
        conversationId,
        kind: 'condensed',
        content: 'scoped condensed',
        tokenCount: createTokenCount(4),
        createdAt: createTimestamp(new Date('2026-01-01T00:20:00.000Z')),
      });

      await dag.createNode(scopedLeaf);
      await dag.createNode(scopedCondensed);
      await dag.addLeafEdges(scopedLeaf.id, [evt3.id]);
      await dag.addCondensedEdges(scopedCondensed.id, [scopedLeaf.id]);

      const scopedText = await ledger.searchEvents(conversationId, 'alpha', scopedCondensed.id);
      expect(scopedText.map((event) => event.id)).toEqual([evt3.id]);

      const scopedRegex = await ledger.regexSearchEvents(conversationId, 'alpha', scopedCondensed.id);
      expect(scopedRegex).toHaveLength(1);
      expect(scopedRegex[0]?.eventId).toBe(evt3.id);
      expect(scopedRegex[0]?.coveringSummaryId).toBe(scopedCondensed.id);
    } finally {
      await harness.destroy();
    }
  });

  it('returns empty retrieval results for unknown conversation references', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversations, ledger } = harness;
      const unknownConversationId = createConversationId('conv_999999');

      const loaded = await conversations.get(unknownConversationId);
      const ancestors = await conversations.getAncestorChain(unknownConversationId);
      const events = await ledger.getEvents(unknownConversationId);
      const textMatches = await ledger.searchEvents(unknownConversationId, 'missing');
      const regexMatches = await ledger.regexSearchEvents(unknownConversationId, 'missing');

      expect(loaded).toBeNull();
      expect(ancestors).toEqual([]);
      expect(events).toEqual([]);
      expect(textMatches).toEqual([]);
      expect(regexMatches).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });
});
