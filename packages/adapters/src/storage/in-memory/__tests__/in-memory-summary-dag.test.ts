import { describe, expect, it } from 'vitest';

import { InMemorySummaryDag, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { InvalidDagEdgeError } from '@ledgermind/domain';
import { createLedgerEvent, createSummaryNode } from '@ledgermind/domain';
import {
  createArtifactId,
  createConversationId,
  createEventId,
  createSequenceNumber,
  createSummaryNodeId,
} from '@ledgermind/domain';
import { createTimestamp } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

const createMessage = (
  conversationId: ReturnType<typeof createConversationId>,
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
  conversationId: ReturnType<typeof createConversationId>,
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

describe('InMemorySummaryDag', () => {
  it('expands condensed summaries recursively to source messages ordered by sequence', async () => {
    const state = createInMemoryPersistenceState();
    const dag = new InMemorySummaryDag(state);
    const conversationId = createConversationId('conv_dag_1');

    const evt1 = createMessage(conversationId, 1, 'first');
    const evt2 = createMessage(conversationId, 2, 'second');
    state.ledgerEventsByConversation.set(conversationId, [evt1, evt2]);
    state.ledgerEventsById.set(evt1.id, evt1);
    state.ledgerEventsById.set(evt2.id, evt2);

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
  });

  it('prevents cycles when adding condensed edges', async () => {
    const state = createInMemoryPersistenceState();
    const dag = new InMemorySummaryDag(state);
    const conversationId = createConversationId('conv_dag_2');

    const a = createSummary(conversationId, 'sum_a', 'condensed');
    const b = createSummary(conversationId, 'sum_b', 'condensed');

    await dag.createNode(a);
    await dag.createNode(b);
    await dag.addCondensedEdges(a.id, [b.id]);

    await expect(dag.addCondensedEdges(b.id, [a.id])).rejects.toBeInstanceOf(InvalidDagEdgeError);
  });

  it('searches summaries by substring within a conversation', async () => {
    const state = createInMemoryPersistenceState();
    const dag = new InMemorySummaryDag(state);
    const conversationId = createConversationId('conv_dag_3');

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
  });

  it('reports all integrity checks and detects missing artifact propagation', async () => {
    const state = createInMemoryPersistenceState();
    const dag = new InMemorySummaryDag(state);
    const conversationId = createConversationId('conv_dag_4');

    const message = createMessage(conversationId, 1, 'tool result', ['file_123']);
    state.ledgerEventsByConversation.set(conversationId, [message]);
    state.ledgerEventsById.set(message.id, message);
    state.contextItemsByConversation.set(conversationId, []);

    const leaf = createSummary(conversationId, 'sum_leaf_missing_artifact', 'leaf');
    await dag.createNode(leaf);
    await dag.addLeafEdges(leaf.id, [message.id]);

    const report = await dag.checkIntegrity(conversationId);
    expect(report.checks).toHaveLength(8);
    expect(report.passed).toBe(false);

    const artifactPropagation = report.checks.find((check) => check.name === 'artifact_propagation');
    expect(artifactPropagation?.passed).toBe(false);
    expect(artifactPropagation?.affectedIds?.[0]).toContain(leaf.id);

    const leafWithArtifacts = createSummary(conversationId, 'sum_leaf_with_artifact', 'leaf', ['file_123']);
    await dag.createNode(leafWithArtifacts);
    await dag.addLeafEdges(leafWithArtifacts.id, [message.id]);

    const repairedReport = await dag.checkIntegrity(conversationId);
    const repairedArtifactPropagation = repairedReport.checks.find(
      (check) => check.name === 'artifact_propagation',
    );
    expect(repairedArtifactPropagation?.passed).toBe(false);
  });
});
