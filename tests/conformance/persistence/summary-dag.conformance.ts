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
} from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from '../run-conformance';

const INTEGRITY_CHECK_NAMES = [
  'no_orphan_edges',
  'no_orphan_context_refs',
  'acyclic_dag',
  'leaf_coverage',
  'condensed_coverage',
  'contiguous_positions',
  'monotonic_sequence',
  'artifact_propagation',
] as const;

const createEvent = (conversationId: ConversationId, sequence: number, content: string) => {
  return createLedgerEvent({
    id: createEventId(`evt_conf_dag_${conversationId}_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-03-01T00:30:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

export const registerSummaryDagConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('summary DAG contract', () => {
    it('expands summaries to transitive source messages in ascending sequence order', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;
        const first = createEvent(conversationId, 1, 'dag alpha');
        const second = createEvent(conversationId, 2, 'dag beta');
        const third = createEvent(conversationId, 3, 'dag gamma');

        await runtime.ledger.appendEvents(conversationId, [first, second, third]);

        const leaf = createSummaryNode({
          id: createSummaryNodeId('sum_conf_dag_leaf'),
          conversationId,
          kind: 'leaf',
          content: 'leaf summary',
          tokenCount: createTokenCount(9),
          artifactIds: [],
          createdAt: createTimestamp(new Date('2026-03-01T00:31:00.000Z')),
        });

        const condensed = createSummaryNode({
          id: createSummaryNodeId('sum_conf_dag_condensed'),
          conversationId,
          kind: 'condensed',
          content: 'condensed summary',
          tokenCount: createTokenCount(6),
          artifactIds: [],
          createdAt: createTimestamp(new Date('2026-03-01T00:31:30.000Z')),
        });

        await runtime.dag.createNode(leaf);
        await runtime.dag.createNode(condensed);
        await runtime.dag.addLeafEdges(leaf.id, [first.id, second.id, third.id]);
        await runtime.dag.addCondensedEdges(condensed.id, [leaf.id]);

        const expanded = await runtime.dag.expandToMessages(condensed.id);
        expect(expanded.map((event) => event.sequence)).toEqual([1, 2, 3]);
        expect(expanded.map((event) => event.id)).toEqual([first.id, second.id, third.id]);

        const report = await runtime.dag.checkIntegrity(conversationId);
        expect(report.passed).toBe(true);
        expect(report.checks.map((check) => check.name)).toEqual(INTEGRITY_CHECK_NAMES);
      } finally {
        await runtime.destroy();
      }
    });

    it('detects injected orphan summary message edges when corruption tooling is available', async () => {
      const runtime = await adapter.createRuntime();

      try {
        if (!runtime.corruption.canInjectOrphanSummaryMessageEdge) {
          return;
        }

        const conversationId = runtime.defaultConversationId;
        const seed = createEvent(conversationId, 1, 'dag seed event');

        await runtime.ledger.appendEvents(conversationId, [seed]);

        const leaf = createSummaryNode({
          id: createSummaryNodeId('sum_conf_dag_orphan_leaf'),
          conversationId,
          kind: 'leaf',
          content: 'orphan edge leaf',
          tokenCount: createTokenCount(4),
          artifactIds: [],
          createdAt: createTimestamp(new Date('2026-03-01T00:32:00.000Z')),
        });

        await runtime.dag.createNode(leaf);
        await runtime.dag.addLeafEdges(leaf.id, [seed.id]);

        await runtime.corruption.injectOrphanSummaryMessageEdge({
          summaryId: leaf.id,
          missingMessageId: createEventId('evt_conf_dag_missing_orphan_edge'),
        });

        const report = await runtime.dag.checkIntegrity(conversationId);
        const orphanCheck = report.checks.find((check) => check.name === 'no_orphan_edges');

        expect(orphanCheck).toBeDefined();
        expect(orphanCheck?.passed).toBe(false);
        expect(report.passed).toBe(false);
      } finally {
        await runtime.destroy();
      }
    });
  });
};
