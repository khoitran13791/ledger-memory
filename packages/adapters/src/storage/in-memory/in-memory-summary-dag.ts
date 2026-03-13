import type { IntegrityCheckResult, IntegrityReport, SummaryDagPort } from '@ledgermind/application';
import {
  InvalidDagEdgeError,
  InvariantViolationError,
  type ConversationId,
  type EventId,
  type EventMetadata,
  type LedgerEvent,
  type SummaryNode,
  type SummaryNodeId,
} from '@ledgermind/domain';

import type { InMemoryPersistenceState } from './state';
import { createInMemoryPersistenceState } from './state';

const toSearchTokens = (value: string): readonly string[] => {
  return value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
};

const scoreTokenOverlap = (content: string, query: string): number => {
  const queryTokens = toSearchTokens(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const contentTokens = new Set(toSearchTokens(content));
  let overlapCount = 0;

  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlapCount += 1;
    }
  }

  return overlapCount;
};

const uniquePush = <T>(target: T[], value: T): void => {
  if (!target.includes(value)) {
    target.push(value);
  }
};

const asStringSet = (values: readonly string[]): Set<string> => {
  return new Set(values.filter((value) => value.trim().length > 0));
};

const addFromUnknown = (target: Set<string>, value: unknown): void => {
  if (typeof value === 'string' && value.trim().length > 0) {
    target.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addFromUnknown(target, item);
    }
    return;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    addFromUnknown(target, (value as { readonly id?: unknown }).id);
  }
};

const extractArtifactIdsFromMetadata = (metadata: EventMetadata): Set<string> => {
  const result = new Set<string>();

  addFromUnknown(result, metadata['artifactIds']);
  addFromUnknown(result, metadata['artifact_ids']);
  addFromUnknown(result, metadata['artifactId']);
  addFromUnknown(result, metadata['artifact_id']);
  addFromUnknown(result, metadata['artifacts']);

  return result;
};

const checkForCycleOnEdge = (
  state: InMemoryPersistenceState,
  summaryId: SummaryNodeId,
  parentSummaryId: SummaryNodeId,
): void => {
  if (summaryId === parentSummaryId) {
    throw new InvalidDagEdgeError('Summary DAG edge cannot reference itself.');
  }

  const visited = new Set<SummaryNodeId>();

  const reachesTarget = (from: SummaryNodeId, target: SummaryNodeId): boolean => {
    if (from === target) {
      return true;
    }

    if (visited.has(from)) {
      return false;
    }

    visited.add(from);

    const parents = state.condensedParentEdgesBySummary.get(from) ?? [];
    for (const parent of parents) {
      if (reachesTarget(parent, target)) {
        return true;
      }
    }

    return false;
  };

  if (reachesTarget(parentSummaryId, summaryId)) {
    throw new InvalidDagEdgeError('Adding condensed edge would create a cycle.');
  }
};

const collectScopedSummaryIds = (
  state: InMemoryPersistenceState,
  rootSummaryId: SummaryNodeId,
): readonly SummaryNodeId[] => {
  if (!state.summaryNodesById.has(rootSummaryId)) {
    return [];
  }

  const scoped: SummaryNodeId[] = [];
  const queue: SummaryNodeId[] = [rootSummaryId];
  const visited = new Set<SummaryNodeId>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) {
      continue;
    }

    visited.add(current);
    scoped.push(current);

    for (const parentId of state.condensedParentEdgesBySummary.get(current) ?? []) {
      if (!visited.has(parentId)) {
        queue.push(parentId);
      }
    }
  }

  return scoped;
};

const expandSummaryToMessageIds = (
  state: InMemoryPersistenceState,
  summaryId: SummaryNodeId,
): EventId[] => {
  const visited = new Set<SummaryNodeId>();
  const inPath = new Set<SummaryNodeId>();
  const messageIds = new Set<EventId>();

  const visit = (currentSummaryId: SummaryNodeId): void => {
    if (inPath.has(currentSummaryId)) {
      throw new InvalidDagEdgeError('Cycle detected while expanding summary DAG.');
    }

    if (visited.has(currentSummaryId)) {
      return;
    }

    inPath.add(currentSummaryId);

    for (const messageId of state.leafMessageEdgesBySummary.get(currentSummaryId) ?? []) {
      messageIds.add(messageId);
    }

    for (const parentSummaryId of state.condensedParentEdgesBySummary.get(currentSummaryId) ?? []) {
      visit(parentSummaryId);
    }

    inPath.delete(currentSummaryId);
    visited.add(currentSummaryId);
  };

  visit(summaryId);

  return [...messageIds];
};

const computeExpectedArtifactIds = (
  state: InMemoryPersistenceState,
  summaryId: SummaryNodeId,
  memo: Map<SummaryNodeId, Set<string>>,
  inPath: Set<SummaryNodeId>,
): Set<string> => {
  const cached = memo.get(summaryId);
  if (cached) {
    return new Set(cached);
  }

  if (inPath.has(summaryId)) {
    return new Set();
  }

  inPath.add(summaryId);

  const expected = new Set<string>();
  const node = state.summaryNodesById.get(summaryId);

  if (node?.kind === 'leaf') {
    for (const messageId of state.leafMessageEdgesBySummary.get(summaryId) ?? []) {
      const event = state.ledgerEventsById.get(messageId);
      if (!event) {
        continue;
      }

      for (const artifactId of extractArtifactIdsFromMetadata(event.metadata)) {
        expected.add(artifactId);
      }
    }
  } else {
    for (const parentSummaryId of state.condensedParentEdgesBySummary.get(summaryId) ?? []) {
      const parentExpected = computeExpectedArtifactIds(state, parentSummaryId, memo, inPath);
      for (const artifactId of parentExpected) {
        expected.add(artifactId);
      }
    }
  }

  inPath.delete(summaryId);
  memo.set(summaryId, new Set(expected));
  return expected;
};

const createIntegrityCheckResult = (
  name: string,
  passed: boolean,
  details?: string,
  affectedIds?: readonly string[],
): IntegrityCheckResult => {
  return {
    name,
    passed,
    ...(details === undefined ? {} : { details }),
    ...(affectedIds === undefined ? {} : { affectedIds }),
  };
};

const buildNoOrphanEdgesCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const affected: string[] = [];

  for (const [summaryId, messageIds] of state.leafMessageEdgesBySummary.entries()) {
    const summaryNode = state.summaryNodesById.get(summaryId);

    if (!summaryNode) {
      affected.push(`missing_summary:${summaryId}`);
      continue;
    }

    if (summaryNode.conversationId !== conversationId) {
      continue;
    }

    for (const messageId of messageIds) {
      if (!state.ledgerEventsById.has(messageId)) {
        affected.push(`leaf:${summaryId}->message:${messageId}`);
      }
    }
  }

  for (const [summaryId, parentSummaryIds] of state.condensedParentEdgesBySummary.entries()) {
    const summaryNode = state.summaryNodesById.get(summaryId);

    if (!summaryNode) {
      affected.push(`missing_summary:${summaryId}`);
      continue;
    }

    if (summaryNode.conversationId !== conversationId) {
      continue;
    }

    for (const parentSummaryId of parentSummaryIds) {
      if (!state.summaryNodesById.has(parentSummaryId)) {
        affected.push(`condensed:${summaryId}->parent:${parentSummaryId}`);
      }
    }
  }

  return createIntegrityCheckResult(
    'no_orphan_edges',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Found edges pointing to missing message/summary nodes.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildNoOrphanContextRefsCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const affected: string[] = [];

  for (const item of state.contextItemsByConversation.get(conversationId) ?? []) {
    if (item.ref.type === 'message') {
      if (!state.ledgerEventsById.has(item.ref.messageId)) {
        affected.push(`position:${item.position}:message:${item.ref.messageId}`);
      }
      continue;
    }

    if (!state.summaryNodesById.has(item.ref.summaryId)) {
      affected.push(`position:${item.position}:summary:${item.ref.summaryId}`);
    }
  }

  return createIntegrityCheckResult(
    'no_orphan_context_refs',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Found context items pointing to missing messages or summaries.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildAcyclicDagCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const summaryIds = state.summaryNodeIdsByConversation.get(conversationId) ?? [];
  const visited = new Set<SummaryNodeId>();
  const inPath = new Set<SummaryNodeId>();
  const cycleStarts = new Set<string>();

  const walk = (summaryId: SummaryNodeId): void => {
    if (inPath.has(summaryId)) {
      cycleStarts.add(summaryId);
      return;
    }

    if (visited.has(summaryId)) {
      return;
    }

    inPath.add(summaryId);

    for (const parentSummaryId of state.condensedParentEdgesBySummary.get(summaryId) ?? []) {
      walk(parentSummaryId);
    }

    inPath.delete(summaryId);
    visited.add(summaryId);
  };

  for (const summaryId of summaryIds) {
    walk(summaryId);
  }

  const affected = [...cycleStarts];

  return createIntegrityCheckResult(
    'acyclic_dag',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Cycle detected in condensed summary parent edges.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildLeafCoverageCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const affected: string[] = [];

  for (const summaryId of state.summaryNodeIdsByConversation.get(conversationId) ?? []) {
    const node = state.summaryNodesById.get(summaryId);
    if (!node || node.kind !== 'leaf') {
      continue;
    }

    const messageIds = state.leafMessageEdgesBySummary.get(summaryId) ?? [];
    if (messageIds.length === 0) {
      affected.push(summaryId);
    }
  }

  return createIntegrityCheckResult(
    'leaf_coverage',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Leaf summaries without message coverage were found.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildCondensedCoverageCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const affected: string[] = [];

  for (const summaryId of state.summaryNodeIdsByConversation.get(conversationId) ?? []) {
    const node = state.summaryNodesById.get(summaryId);
    if (!node || node.kind !== 'condensed') {
      continue;
    }

    const parentSummaryIds = state.condensedParentEdgesBySummary.get(summaryId) ?? [];
    if (parentSummaryIds.length === 0) {
      affected.push(summaryId);
    }
  }

  return createIntegrityCheckResult(
    'condensed_coverage',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Condensed summaries without parent coverage were found.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildContiguousPositionsCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const items = [...(state.contextItemsByConversation.get(conversationId) ?? [])].sort(
    (left, right) => left.position - right.position,
  );

  const affected: string[] = [];

  for (const [index, item] of items.entries()) {
    if (item.position !== index) {
      affected.push(`expected:${index},actual:${item.position}`);
    }
  }

  return createIntegrityCheckResult(
    'contiguous_positions',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Context positions are not contiguous from 0..N-1.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildMonotonicSequenceCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const events = [...(state.ledgerEventsByConversation.get(conversationId) ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  );

  const affected: string[] = [];

  for (const [index, event] of events.entries()) {
    const expected = index + 1;
    const actual = event.sequence;
    if (actual !== expected) {
      affected.push(`${event.id}:expected:${expected},actual:${actual}`);
    }
  }

  return createIntegrityCheckResult(
    'monotonic_sequence',
    affected.length === 0,
    affected.length === 0 ? undefined : 'Ledger sequences are not strictly monotonic and gap-free.',
    affected.length === 0 ? undefined : affected,
  );
};

const buildArtifactPropagationCheck = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): IntegrityCheckResult => {
  const affected: string[] = [];
  const memo = new Map<SummaryNodeId, Set<string>>();

  for (const summaryId of state.summaryNodeIdsByConversation.get(conversationId) ?? []) {
    const node = state.summaryNodesById.get(summaryId);
    if (!node) {
      continue;
    }

    const expected = computeExpectedArtifactIds(state, summaryId, memo, new Set());
    const actual = asStringSet(node.artifactIds);

    const missing = [...expected].filter((artifactId) => !actual.has(artifactId));
    if (missing.length > 0) {
      affected.push(`${summaryId}:missing:${missing.join(',')}`);
    }
  }

  return createIntegrityCheckResult(
    'artifact_propagation',
    affected.length === 0,
    affected.length === 0
      ? undefined
      : 'Summary artifact_ids are missing IDs required by message/parent lineage.',
    affected.length === 0 ? undefined : affected,
  );
};

export class InMemorySummaryDag implements SummaryDagPort {
  constructor(private readonly state: InMemoryPersistenceState = createInMemoryPersistenceState()) {}

  async createNode(node: SummaryNode): Promise<void> {
    if (this.state.summaryNodesById.has(node.id)) {
      return;
    }

    this.state.summaryNodesById.set(node.id, node);

    const summaryIds = this.state.summaryNodeIdsByConversation.get(node.conversationId) ?? [];
    uniquePush(summaryIds, node.id);
    this.state.summaryNodeIdsByConversation.set(node.conversationId, summaryIds);
  }

  async getNode(id: SummaryNodeId): Promise<SummaryNode | null> {
    return this.state.summaryNodesById.get(id) ?? null;
  }

  async addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void> {
    const node = this.state.summaryNodesById.get(summaryId);
    if (!node) {
      throw new InvariantViolationError('Cannot add leaf edges for unknown summary node.');
    }

    if (node.kind !== 'leaf') {
      throw new InvariantViolationError('Leaf edges can only be added to leaf summary nodes.');
    }

    const edges = this.state.leafMessageEdgesBySummary.get(summaryId) ?? [];

    for (const messageId of messageIds) {
      const message = this.state.ledgerEventsById.get(messageId);
      if (!message) {
        throw new InvariantViolationError('Cannot add leaf edge for unknown ledger event.');
      }

      if (message.conversationId !== node.conversationId) {
        throw new InvariantViolationError('Leaf edge message conversation must match summary conversation.');
      }

      uniquePush(edges, messageId);
    }

    this.state.leafMessageEdgesBySummary.set(summaryId, edges);
  }

  async addCondensedEdges(
    summaryId: SummaryNodeId,
    parentSummaryIds: readonly SummaryNodeId[],
  ): Promise<void> {
    const node = this.state.summaryNodesById.get(summaryId);
    if (!node) {
      throw new InvariantViolationError('Cannot add condensed edges for unknown summary node.');
    }

    if (node.kind !== 'condensed') {
      throw new InvariantViolationError('Condensed edges can only be added to condensed summary nodes.');
    }

    const edges = this.state.condensedParentEdgesBySummary.get(summaryId) ?? [];

    for (const parentSummaryId of parentSummaryIds) {
      const parentSummary = this.state.summaryNodesById.get(parentSummaryId);
      if (!parentSummary) {
        throw new InvariantViolationError('Cannot add condensed edge for unknown parent summary node.');
      }

      if (parentSummary.conversationId !== node.conversationId) {
        throw new InvariantViolationError(
          'Condensed edge parent summary conversation must match summary conversation.',
        );
      }

      checkForCycleOnEdge(this.state, summaryId, parentSummaryId);
      uniquePush(edges, parentSummaryId);
    }

    this.state.condensedParentEdgesBySummary.set(summaryId, edges);
  }

  async getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]> {
    return [...(this.state.condensedParentEdgesBySummary.get(summaryId) ?? [])];
  }

  async expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]> {
    if (!this.state.summaryNodesById.has(summaryId)) {
      return [];
    }

    const messageIds = expandSummaryToMessageIds(this.state, summaryId);

    const messages = messageIds
      .map((messageId) => this.state.ledgerEventsById.get(messageId))
      .filter((event): event is LedgerEvent => event !== undefined)
      .sort((left, right) => left.sequence - right.sequence);

    return messages;
  }

  async searchSummaries(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly SummaryNode[]> {
    const normalized = query.trim();
    if (normalized.length === 0) {
      return [];
    }

    const scopedIds =
      scope === undefined
        ? null
        : new Set(
            collectScopedSummaryIds(this.state, scope).filter((summaryId) => {
              const node = this.state.summaryNodesById.get(summaryId);
              return node?.conversationId === conversationId;
            }),
          );

    if (scope !== undefined && scopedIds !== null && scopedIds.size === 0) {
      return [];
    }

    const summaryIds = this.state.summaryNodeIdsByConversation.get(conversationId) ?? [];

    return summaryIds
      .filter((summaryId) => scopedIds === null || scopedIds.has(summaryId))
      .map((summaryId) => this.state.summaryNodesById.get(summaryId))
      .filter((node): node is SummaryNode => node !== undefined)
      .map((node, index) => ({
        node,
        index,
        score: scoreTokenOverlap(node.content, normalized),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        const createdAtDiff = right.node.createdAt.getTime() - left.node.createdAt.getTime();
        if (createdAtDiff !== 0) {
          return createdAtDiff;
        }

        return left.index - right.index;
      })
      .map((entry) => entry.node);
  }

  async checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport> {
    const checks: IntegrityCheckResult[] = [
      buildNoOrphanEdgesCheck(this.state, conversationId),
      buildNoOrphanContextRefsCheck(this.state, conversationId),
      buildAcyclicDagCheck(this.state, conversationId),
      buildLeafCoverageCheck(this.state, conversationId),
      buildCondensedCoverageCheck(this.state, conversationId),
      buildContiguousPositionsCheck(this.state, conversationId),
      buildMonotonicSequenceCheck(this.state, conversationId),
      buildArtifactPropagationCheck(this.state, conversationId),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  }
}
