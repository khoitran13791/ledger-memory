import { describe, expect, it } from 'vitest';

import { InvalidDagEdgeError } from '@ledgermind/domain';
import { createContextItem, createLedgerEvent, createSummaryNode } from '@ledgermind/domain';
import {
  createArtifactId,
  createEventId,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNodeId,
} from '@ledgermind/domain';
import type { ConversationId } from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

import { createPostgresTestHarness } from './postgres-test-harness';

const createMessage = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
  artifactIds?: readonly string[],
) => {
  const metadata = artifactIds ? { artifactIds } : {};

  return createLedgerEvent({
    id: createEventId(`evt_dag_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'assistant',
    content,
    tokenCount: createTokenCount(content.length),
    occurredAt: createTimestamp(new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata,
  });
};

const createSummary = (
  conversationId: ConversationId,
  id: string,
  kind: 'leaf' | 'condensed',
  artifactIds: readonly string[] = [],
) => {
  return createSummaryNode({
    id: createSummaryNodeId(id),
    conversationId,
    kind,
    content: `${kind}-${id}`,
    tokenCount: createTokenCount(5),
    artifactIds: artifactIds.map((artifactId) => createArtifactId(artifactId)),
    createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
  });
};

const getCheck = (
  report: {
    readonly checks: readonly {
      readonly name: string;
      readonly passed: boolean;
      readonly affectedIds?: readonly string[];
    }[];
  },
  name: string,
) => {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`Expected integrity check ${name} to exist.`);
  }

  return check;
};

describe('PgSummaryDag', () => {
  it('creates required retrieval and expansion indexes in PostgreSQL schema', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { withClient } = harness;

      const indexes = await withClient(async (client) => {
        const result = await client.query<{
          readonly indexname: string;
          readonly indexdef: string;
        }>(
          `
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = ANY($1::text[])
            ORDER BY indexname ASC
          `,
          [
            [
              'idx_ledger_events_conv_seq',
              'idx_ledger_events_tsv',
              'idx_summary_nodes_tsv',
              'idx_summary_message_edges_summary_ord',
              'idx_summary_parent_edges_summary_ord',
            ],
          ],
        );

        return result.rows;
      });

      const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

      expect(byName.has('idx_ledger_events_conv_seq')).toBe(true);
      expect(byName.has('idx_ledger_events_tsv')).toBe(true);
      expect(byName.has('idx_summary_nodes_tsv')).toBe(true);
      expect(byName.has('idx_summary_message_edges_summary_ord')).toBe(true);
      expect(byName.has('idx_summary_parent_edges_summary_ord')).toBe(true);

      const summaryTsvDef = byName.get('idx_summary_nodes_tsv');
      expect(summaryTsvDef).toContain('USING gin');
      expect(summaryTsvDef).toContain("to_tsvector('english'::regconfig, content)");
    } finally {
      await harness.destroy();
    }
  });

  it('expands condensed summaries recursively to source messages ordered by sequence', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, dag, conversationId } = harness;

      const evt1 = createMessage(conversationId, 1, 'first');
      const evt2 = createMessage(conversationId, 2, 'second');
      await ledger.appendEvents(conversationId, [evt1, evt2]);

      const leafA = createSummary(conversationId, 'sum_leaf_a', 'leaf');
      const leafB = createSummary(conversationId, 'sum_leaf_b', 'leaf');
      const condensed = createSummary(conversationId, 'sum_condensed', 'condensed');

      await dag.createNode(leafA);
      await dag.createNode(leafB);
      await dag.createNode(condensed);
      await dag.addLeafEdges(leafA.id, [evt1.id]);
      await dag.addLeafEdges(leafB.id, [evt2.id]);
      await dag.addCondensedEdges(condensed.id, [leafB.id, leafA.id]);

      const messages = await dag.expandToMessages(condensed.id);
      expect(messages.map((message) => message.id)).toEqual([evt1.id, evt2.id]);
    } finally {
      await harness.destroy();
    }
  });

  it('prevents cycles when adding condensed edges', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { dag, conversationId } = harness;

      const a = createSummary(conversationId, 'sum_a', 'condensed');
      const b = createSummary(conversationId, 'sum_b', 'condensed');

      await dag.createNode(a);
      await dag.createNode(b);
      await dag.addCondensedEdges(a.id, [b.id]);

      await expect(dag.addCondensedEdges(b.id, [a.id])).rejects.toBeInstanceOf(InvalidDagEdgeError);
    } finally {
      await harness.destroy();
    }
  });

  it('searches summaries by full-text query within a conversation', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { dag, conversationId } = harness;

      const alpha = createSummaryNode({
        id: createSummaryNodeId('sum_alpha'),
        conversationId,
        kind: 'leaf',
        content: 'Auth system summary',
        tokenCount: createTokenCount(4),
        createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
      });
      const beta = createSummaryNode({
        id: createSummaryNodeId('sum_beta'),
        conversationId,
        kind: 'leaf',
        content: 'Payments summary',
        tokenCount: createTokenCount(4),
        createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
      });

      await dag.createNode(alpha);
      await dag.createNode(beta);

      const results = await dag.searchSummaries(conversationId, 'auth');
      expect(results.map((summary) => summary.id)).toEqual([alpha.id]);
    } finally {
      await harness.destroy();
    }
  });

  it('returns all 8 integrity checks as passing for valid state', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, dag, context, conversationId } = harness;

      const evt1 = createMessage(conversationId, 1, 'first valid', ['file_ok']);
      const evt2 = createMessage(conversationId, 2, 'second valid');
      await ledger.appendEvents(conversationId, [evt1, evt2]);

      const leaf = createSummary(conversationId, 'sum_integrity_leaf_valid', 'leaf', ['file_ok']);
      const condensed = createSummary(conversationId, 'sum_integrity_condensed_valid', 'condensed', ['file_ok']);
      await dag.createNode(leaf);
      await dag.createNode(condensed);
      await dag.addLeafEdges(leaf.id, [evt1.id, evt2.id]);
      await dag.addCondensedEdges(condensed.id, [leaf.id]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 42,
          ref: createSummaryContextItemRef(condensed.id),
        }),
      ]);

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
      await harness.destroy();
    }
  });

  it('fails no_orphan_edges when an edge points to a missing message', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { dag, conversationId, withClient } = harness;

      const leaf = createSummary(conversationId, 'sum_orphan_edge_leaf', 'leaf');
      await dag.createNode(leaf);

      await withClient(async (client) => {
        await client.query(`SET session_replication_role = replica`);
        try {
          await client.query(
            `
              INSERT INTO summary_message_edges (summary_id, message_id, ord)
              VALUES ($1, $2, $3)
            `,
            [leaf.id, 'evt_missing_orphan', 0],
          );
        } finally {
          await client.query(`SET session_replication_role = origin`);
        }
      });

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'no_orphan_edges');
      expect(check.passed).toBe(false);
      expect(check.affectedIds?.[0]).toContain(`leaf:${leaf.id}`);
    } finally {
      await harness.destroy();
    }
  });

  it('fails no_orphan_context_refs when context references a missing message', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, withClient, dag } = harness;

      await withClient(async (client) => {
        await client.query(`SET session_replication_role = replica`);
        try {
          await client.query(
            `
              INSERT INTO context_items (conversation_id, position, message_id, summary_id)
              VALUES ($1, $2, $3, NULL)
            `,
            [conversationId, 0, 'evt_missing_context'],
          );
        } finally {
          await client.query(`SET session_replication_role = origin`);
        }
      });

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'no_orphan_context_refs');
      expect(check.passed).toBe(false);
      expect(check.affectedIds?.[0]).toContain('evt_missing_context');
    } finally {
      await harness.destroy();
    }
  });

  it('fails acyclic_dag when parent edges form a cycle', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { dag, conversationId, withClient } = harness;

      const summaryA = createSummary(conversationId, 'sum_cycle_a', 'condensed');
      const summaryB = createSummary(conversationId, 'sum_cycle_b', 'condensed');
      await dag.createNode(summaryA);
      await dag.createNode(summaryB);

      await withClient(async (client) => {
        await client.query(
          `
            INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
            VALUES ($1, $2, $3), ($4, $5, $6)
          `,
          [summaryA.id, summaryB.id, 0, summaryB.id, summaryA.id, 0],
        );
      });

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'acyclic_dag');
      expect(check.passed).toBe(false);
      expect(check.affectedIds).toBeDefined();
      expect((check.affectedIds ?? []).length).toBeGreaterThan(0);
    } finally {
      await harness.destroy();
    }
  });

  it('fails leaf_coverage when a leaf has no message edges', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { dag, conversationId } = harness;

      const uncoveredLeaf = createSummary(conversationId, 'sum_leaf_uncovered', 'leaf');
      await dag.createNode(uncoveredLeaf);

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'leaf_coverage');
      expect(check.passed).toBe(false);
      expect(check.affectedIds).toContain(uncoveredLeaf.id);
    } finally {
      await harness.destroy();
    }
  });

  it('fails condensed_coverage when a condensed summary has no parent edges', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { dag, conversationId } = harness;

      const uncoveredCondensed = createSummary(conversationId, 'sum_condensed_uncovered', 'condensed');
      await dag.createNode(uncoveredCondensed);

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'condensed_coverage');
      expect(check.passed).toBe(false);
      expect(check.affectedIds).toContain(uncoveredCondensed.id);
    } finally {
      await harness.destroy();
    }
  });

  it('fails contiguous_positions when context positions are non-contiguous', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, dag, conversationId, withClient } = harness;

      const event = createMessage(conversationId, 1, 'context gap seed');
      await ledger.appendEvents(conversationId, [event]);

      await withClient(async (client) => {
        await client.query(
          `
            INSERT INTO context_items (conversation_id, position, message_id, summary_id)
            VALUES ($1, $2, $3, NULL)
          `,
          [conversationId, 2, event.id],
        );
      });

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'contiguous_positions');
      expect(check.passed).toBe(false);
      expect(check.affectedIds?.[0]).toBe('expected:0,actual:2');
    } finally {
      await harness.destroy();
    }
  });

  it('fails monotonic_sequence when ledger sequence has gaps', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, withClient, dag } = harness;

      await withClient(async (client) => {
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
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          `,
          [
            'evt_monotonic_gap',
            conversationId,
            3,
            'assistant',
            'gap event',
            2,
            '2026-01-01T00:00:03.000Z',
            '{}',
            null,
          ],
        );
      });

      const report = await dag.checkIntegrity(conversationId);
      const check = getCheck(report, 'monotonic_sequence');
      expect(check.passed).toBe(false);
      expect(check.affectedIds?.[0]).toContain('evt_monotonic_gap');
    } finally {
      await harness.destroy();
    }
  });

  it('fails artifact_propagation when summary artifact_ids omit lineage artifacts and passes after repair', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, dag, conversationId, withClient } = harness;

      const message = createMessage(conversationId, 1, 'tool result', ['file_123']);
      await ledger.appendEvents(conversationId, [message]);

      const leaf = createSummary(conversationId, 'sum_leaf_missing_artifact', 'leaf');
      await dag.createNode(leaf);
      await dag.addLeafEdges(leaf.id, [message.id]);

      const report = await dag.checkIntegrity(conversationId);
      const artifactPropagation = getCheck(report, 'artifact_propagation');
      expect(artifactPropagation.passed).toBe(false);
      expect(artifactPropagation.affectedIds?.[0]).toContain(leaf.id);

      await withClient(async (client) => {
        await client.query(
          `
            UPDATE summary_nodes
            SET artifact_ids = $2::jsonb
            WHERE id = $1
          `,
          [leaf.id, JSON.stringify(['file_123'])],
        );
      });

      const repairedReport = await dag.checkIntegrity(conversationId);
      const repairedArtifactPropagation = getCheck(repairedReport, 'artifact_propagation');
      expect(repairedArtifactPropagation.passed).toBe(true);
      expect(repairedReport.passed).toBe(true);
    } finally {
      await harness.destroy();
    }
  });
});
