import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createArtifactId,
  createConversationId,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  InvalidDagEdgeError,
  type ConversationId,
  type LedgerEvent,
  type SummaryNode,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteLedgerStore } from '../sqlite-ledger-store';
import { SqliteSummaryDag } from '../sqlite-summary-dag';

const tempDirs: string[] = [];

const createMessage = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
  artifactIds: readonly string[] = [],
): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(`evt_sqlite_dag_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'assistant',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(
      new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`),
    ),
    metadata: artifactIds.length === 0 ? {} : { artifactIds },
  });
};

const createSummary = (
  conversationId: ConversationId,
  id: string,
  kind: 'leaf' | 'condensed',
  options: {
    readonly retrievalText?: string;
    readonly artifactIds?: readonly string[];
    readonly createdAt?: Date;
  } = {},
): SummaryNode => {
  return createSummaryNode({
    id: createSummaryNodeId(id),
    conversationId,
    kind,
    content: `${kind}-${id}`,
    tokenCount: createTokenCount(5),
    artifactIds: (options.artifactIds ?? []).map((artifactId) => createArtifactId(artifactId)),
    createdAt: createTimestamp(options.createdAt ?? new Date('2026-01-01T00:10:00.000Z')),
    ...(options.retrievalText === undefined ? {} : { retrievalText: options.retrievalText }),
  });
};

const createTestDatabase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-dag-'));
  tempDirs.push(dir);
  const database = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });
  const conversationId = createConversationId('conv_sqlite_dag_001');

  database.db
    .prepare(
      `INSERT INTO conversations (
        id,
        model_name,
        context_window,
        soft_threshold,
        hard_threshold
      )
      VALUES (?, ?, ?, ?, ?)`,
    )
    .run(conversationId, 'sqlite-local', 8192, 0.6, 0.9);

  return {
    database,
    conversationId,
    ledger: new SqliteLedgerStore(database.db),
    dag: new SqliteSummaryDag(database.db),
  };
};

const getCheck = (
  report: Awaited<ReturnType<SqliteSummaryDag['checkIntegrity']>>,
  name: string,
) => {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (check === undefined) {
    throw new Error(`Expected integrity check ${name} to exist.`);
  }

  return check;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteSummaryDag', () => {
  it('creates leaf nodes, adds leaf edges, and expands messages by ledger sequence', async () => {
    const { database, conversationId, ledger, dag } = await createTestDatabase();
    const first = createMessage(conversationId, 1, 'first');
    const second = createMessage(conversationId, 2, 'second');
    const third = createMessage(conversationId, 3, 'third');
    const leaf = createSummary(conversationId, 'sum_sqlite_leaf_order', 'leaf');

    try {
      await ledger.appendEvents(conversationId, [first, second, third]);
      await dag.createNode(leaf);
      await dag.addLeafEdges(leaf.id, [third.id, first.id, second.id]);

      const expanded = await dag.expandToMessages(leaf.id);

      expect(await dag.getNode(leaf.id)).toEqual(leaf);
      expect(expanded.map((message) => message.id)).toEqual([first.id, second.id, third.id]);
    } finally {
      database.close();
    }
  });

  it('rejects condensed self-cycles and reports all integrity checks passing for a valid DAG', async () => {
    const { database, conversationId, ledger, dag } = await createTestDatabase();
    const message = createMessage(conversationId, 1, 'valid source');
    const leaf = createSummary(conversationId, 'sum_sqlite_valid_leaf', 'leaf');
    const condensed = createSummary(conversationId, 'sum_sqlite_valid_condensed', 'condensed');

    try {
      await ledger.appendEvents(conversationId, [message]);
      await dag.createNode(leaf);
      await dag.createNode(condensed);
      await dag.addLeafEdges(leaf.id, [message.id]);
      await dag.addCondensedEdges(condensed.id, [leaf.id]);

      await expect(dag.addCondensedEdges(condensed.id, [condensed.id])).rejects.toBeInstanceOf(
        InvalidDagEdgeError,
      );

      const report = await dag.checkIntegrity(conversationId);
      expect(report.passed).toBe(true);
      expect(report.checks.map((check) => check.name)).toEqual([
        'no_orphan_edges',
        'no_orphan_context_refs',
        'acyclic_dag',
        'leaf_coverage',
        'condensed_coverage',
        'contiguous_positions',
        'monotonic_sequence',
        'artifact_propagation',
      ]);
      expect(report.checks.every((check) => check.passed)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('searches retrieval text and returns summary artifact ids within an optional scope', async () => {
    const { database, conversationId, dag } = await createTestDatabase();
    const auth = createSummary(conversationId, 'sum_sqlite_auth_leaf', 'leaf', {
      retrievalText: 'OAuth callback debugging and refresh token notes',
      artifactIds: ['file_auth_trace'],
      createdAt: new Date('2026-01-01T00:10:00.000Z'),
    });
    const payments = createSummary(conversationId, 'sum_sqlite_payments_leaf', 'leaf', {
      retrievalText: 'Payment provider webhook notes',
      artifactIds: ['file_payments_trace'],
      createdAt: new Date('2026-01-01T00:11:00.000Z'),
    });
    const scopedRoot = createSummary(conversationId, 'sum_sqlite_search_scope', 'condensed', {
      retrievalText: 'Search scope root',
      artifactIds: ['file_auth_trace'],
      createdAt: new Date('2026-01-01T00:12:00.000Z'),
    });

    try {
      await dag.createNode(auth);
      await dag.createNode(payments);
      await dag.createNode(scopedRoot);
      await dag.addCondensedEdges(scopedRoot.id, [auth.id]);

      await expect(dag.searchSummaries(conversationId, '   ')).resolves.toEqual([]);

      const scoped = await dag.searchSummaries(conversationId, 'oauth token', scopedRoot.id);
      expect(scoped.map((summary) => summary.id)).toEqual([auth.id]);
      expect(scoped[0]?.artifactIds).toEqual([createArtifactId('file_auth_trace')]);
    } finally {
      database.close();
    }
  });

  it('detects orphan edges and multi-node cycles in corrupted persisted DAG state', async () => {
    const { database, conversationId, dag } = await createTestDatabase();
    const orphanLeaf = createSummary(conversationId, 'sum_sqlite_orphan_leaf', 'leaf');
    const cycleA = createSummary(conversationId, 'sum_sqlite_cycle_a', 'condensed');
    const cycleB = createSummary(conversationId, 'sum_sqlite_cycle_b', 'condensed');

    try {
      await dag.createNode(orphanLeaf);
      await dag.createNode(cycleA);
      await dag.createNode(cycleB);

      database.db.exec('PRAGMA foreign_keys = OFF');
      database.db
        .prepare(
          `INSERT INTO summary_message_edges (summary_id, message_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(orphanLeaf.id, 'evt_sqlite_missing', 0);
      database.db
        .prepare(
          `INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(cycleA.id, cycleB.id, 0);
      database.db
        .prepare(
          `INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(cycleB.id, cycleA.id, 0);
      database.db.exec('PRAGMA foreign_keys = ON');

      const report = await dag.checkIntegrity(conversationId);

      expect(report.passed).toBe(false);
      expect(getCheck(report, 'no_orphan_edges')).toMatchObject({
        passed: false,
        affectedIds: [`leaf:${orphanLeaf.id}->message:evt_sqlite_missing`],
      });
      expect(getCheck(report, 'acyclic_dag')).toMatchObject({
        passed: false,
      });
      expect(getCheck(report, 'acyclic_dag').affectedIds).toEqual(
        expect.arrayContaining([cycleA.id]),
      );
    } finally {
      database.close();
    }
  });
});
