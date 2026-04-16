import type {
  OperatorFailureMetadata,
  StoredOperatorRun,
  StoredOperatorTask,
} from '@ledgermind/application';
import {
  createContextItem,
  createContextVersion,
  type Artifact,
  type ArtifactId,
  type ContextItem,
  type ContextVersion,
  type Conversation,
  type ConversationId,
  type EventId,
  type LedgerEvent,
  type SummaryNode,
  type SummaryNodeId,
  type Timestamp,
} from '@ledgermind/domain';

export interface StoredArtifactRecord {
  readonly artifact: Artifact;
  readonly content: string | Uint8Array | null;
}

export interface StoredOperatorTaskRecord extends StoredOperatorTask {
  readonly output?: unknown;
  readonly lastFailureAt?: Timestamp;
}

export interface InMemoryPersistenceState {
  readonly conversations: Map<ConversationId, Conversation>;
  nextConversationOrdinal: number;
  readonly ledgerEventsByConversation: Map<ConversationId, LedgerEvent[]>;
  readonly ledgerEventsById: Map<EventId, LedgerEvent>;
  readonly contextItemsByConversation: Map<ConversationId, ContextItem[]>;
  readonly contextVersionsByConversation: Map<ConversationId, ContextVersion>;
  readonly summaryNodesById: Map<SummaryNodeId, SummaryNode>;
  readonly summaryNodeIdsByConversation: Map<ConversationId, SummaryNodeId[]>;
  readonly leafMessageEdgesBySummary: Map<SummaryNodeId, EventId[]>;
  readonly condensedParentEdgesBySummary: Map<SummaryNodeId, SummaryNodeId[]>;
  readonly artifactsById: Map<ArtifactId, StoredArtifactRecord>;
  readonly operatorRunsById: Map<string, StoredOperatorRun>;
  readonly operatorTasksById: Map<string, StoredOperatorTaskRecord>;
  readonly operatorTaskIdsByRun: Map<string, string[]>;
  readonly operatorRunIdByConversationAndKey: Map<string, string>;
  readonly operatorRunOrdinalsByConversation: Map<ConversationId, number>;
}

const cloneContextItemRef = (item: ContextItem): ContextItem['ref'] => {
  if (item.ref.type === 'message') {
    return {
      type: 'message',
      messageId: item.ref.messageId,
    };
  }

  return {
    type: 'summary',
    summaryId: item.ref.summaryId,
  };
};

export const cloneContextItem = (item: ContextItem, position: number = item.position): ContextItem => {
  return createContextItem({
    conversationId: item.conversationId,
    position,
    ref: cloneContextItemRef(item),
  });
};

export const cloneArtifactContent = (
  content: string | Uint8Array | null,
): string | Uint8Array | null => {
  if (content === null) {
    return null;
  }

  if (typeof content === 'string') {
    return content;
  }

  return new Uint8Array(content);
};

const cloneOperatorFailureMetadata = (failure: OperatorFailureMetadata): OperatorFailureMetadata => {
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    ...(failure.details === undefined ? {} : { details: { ...failure.details } }),
  };
};

const cloneStoredOperatorRun = (run: StoredOperatorRun): StoredOperatorRun => {
  const cloned: StoredOperatorRun = {
    ...run,
    outputSchema: { ...run.outputSchema },
    retryPolicy: { ...run.retryPolicy },
    ...(run.delegatedScope === undefined
      ? {}
      : {
          delegatedScope: {
            ...(run.delegatedScope.messageIds === undefined
              ? {}
              : { messageIds: [...run.delegatedScope.messageIds] }),
            ...(run.delegatedScope.summaryIds === undefined
              ? {}
              : { summaryIds: [...run.delegatedScope.summaryIds] }),
            ...(run.delegatedScope.artifactIds === undefined
              ? {}
              : { artifactIds: [...run.delegatedScope.artifactIds] }),
            ...(run.delegatedScope.note === undefined ? {} : { note: run.delegatedScope.note }),
          },
        }),
    ...(run.keptWork === undefined ? {} : { keptWork: { ...run.keptWork } }),
  };

  if (run.terminalFailureSummary !== undefined) {
    return {
      ...cloned,
      terminalFailureSummary: cloneOperatorFailureMetadata(run.terminalFailureSummary),
    };
  }

  return cloned;
};

const cloneStoredOperatorTask = (task: StoredOperatorTaskRecord): StoredOperatorTaskRecord => {
  const cloned: StoredOperatorTaskRecord = {
    ...task,
  };

  if (task.terminalFailure !== undefined) {
    return {
      ...cloned,
      terminalFailure: cloneOperatorFailureMetadata(task.terminalFailure),
    };
  }

  return cloned;
};

export const createInMemoryPersistenceState = (): InMemoryPersistenceState => {
  return {
    conversations: new Map(),
    nextConversationOrdinal: 1,
    ledgerEventsByConversation: new Map(),
    ledgerEventsById: new Map(),
    contextItemsByConversation: new Map(),
    contextVersionsByConversation: new Map(),
    summaryNodesById: new Map(),
    summaryNodeIdsByConversation: new Map(),
    leafMessageEdgesBySummary: new Map(),
    condensedParentEdgesBySummary: new Map(),
    artifactsById: new Map(),
    operatorRunsById: new Map(),
    operatorTasksById: new Map(),
    operatorTaskIdsByRun: new Map(),
    operatorRunIdByConversationAndKey: new Map(),
    operatorRunOrdinalsByConversation: new Map(),
  };
};

export const cloneInMemoryPersistenceState = (
  state: InMemoryPersistenceState,
): InMemoryPersistenceState => {
  return {
    conversations: new Map(state.conversations),
    nextConversationOrdinal: state.nextConversationOrdinal,
    ledgerEventsByConversation: new Map(
      [...state.ledgerEventsByConversation.entries()].map(([conversationId, events]) => [
        conversationId,
        [...events],
      ]),
    ),
    ledgerEventsById: new Map(state.ledgerEventsById),
    contextItemsByConversation: new Map(
      [...state.contextItemsByConversation.entries()].map(([conversationId, items]) => [
        conversationId,
        items.map((item) => cloneContextItem(item)),
      ]),
    ),
    contextVersionsByConversation: new Map(state.contextVersionsByConversation),
    summaryNodesById: new Map(state.summaryNodesById),
    summaryNodeIdsByConversation: new Map(
      [...state.summaryNodeIdsByConversation.entries()].map(([conversationId, summaryIds]) => [
        conversationId,
        [...summaryIds],
      ]),
    ),
    leafMessageEdgesBySummary: new Map(
      [...state.leafMessageEdgesBySummary.entries()].map(([summaryId, messageIds]) => [
        summaryId,
        [...messageIds],
      ]),
    ),
    condensedParentEdgesBySummary: new Map(
      [...state.condensedParentEdgesBySummary.entries()].map(([summaryId, parentSummaryIds]) => [
        summaryId,
        [...parentSummaryIds],
      ]),
    ),
    artifactsById: new Map(
      [...state.artifactsById.entries()].map(([artifactId, record]) => [
        artifactId,
        {
          artifact: record.artifact,
          content: cloneArtifactContent(record.content),
        },
      ]),
    ),
    operatorRunsById: new Map(
      [...state.operatorRunsById.entries()].map(([runId, run]) => [runId, cloneStoredOperatorRun(run)]),
    ),
    operatorTasksById: new Map(
      [...state.operatorTasksById.entries()].map(([taskId, task]) => [taskId, cloneStoredOperatorTask(task)]),
    ),
    operatorTaskIdsByRun: new Map(
      [...state.operatorTaskIdsByRun.entries()].map(([runId, taskIds]) => [runId, [...taskIds]]),
    ),
    operatorRunIdByConversationAndKey: new Map(state.operatorRunIdByConversationAndKey),
    operatorRunOrdinalsByConversation: new Map(state.operatorRunOrdinalsByConversation),
  };
};

export const applyInMemoryPersistenceState = (
  target: InMemoryPersistenceState,
  source: InMemoryPersistenceState,
): void => {
  target.nextConversationOrdinal = source.nextConversationOrdinal;

  target.conversations.clear();
  for (const [conversationId, conversation] of source.conversations.entries()) {
    target.conversations.set(conversationId, conversation);
  }

  target.ledgerEventsByConversation.clear();
  for (const [conversationId, events] of source.ledgerEventsByConversation.entries()) {
    target.ledgerEventsByConversation.set(conversationId, [...events]);
  }

  target.ledgerEventsById.clear();
  for (const [eventId, event] of source.ledgerEventsById.entries()) {
    target.ledgerEventsById.set(eventId, event);
  }

  target.contextItemsByConversation.clear();
  for (const [conversationId, items] of source.contextItemsByConversation.entries()) {
    target.contextItemsByConversation.set(
      conversationId,
      items.map((item) => cloneContextItem(item)),
    );
  }

  target.contextVersionsByConversation.clear();
  for (const [conversationId, version] of source.contextVersionsByConversation.entries()) {
    target.contextVersionsByConversation.set(conversationId, version);
  }

  target.summaryNodesById.clear();
  for (const [summaryId, summaryNode] of source.summaryNodesById.entries()) {
    target.summaryNodesById.set(summaryId, summaryNode);
  }

  target.summaryNodeIdsByConversation.clear();
  for (const [conversationId, summaryIds] of source.summaryNodeIdsByConversation.entries()) {
    target.summaryNodeIdsByConversation.set(conversationId, [...summaryIds]);
  }

  target.leafMessageEdgesBySummary.clear();
  for (const [summaryId, messageIds] of source.leafMessageEdgesBySummary.entries()) {
    target.leafMessageEdgesBySummary.set(summaryId, [...messageIds]);
  }

  target.condensedParentEdgesBySummary.clear();
  for (const [summaryId, parentSummaryIds] of source.condensedParentEdgesBySummary.entries()) {
    target.condensedParentEdgesBySummary.set(summaryId, [...parentSummaryIds]);
  }

  target.artifactsById.clear();
  for (const [artifactId, record] of source.artifactsById.entries()) {
    target.artifactsById.set(artifactId, {
      artifact: record.artifact,
      content: cloneArtifactContent(record.content),
    });
  }

  target.operatorRunsById.clear();
  for (const [runId, run] of source.operatorRunsById.entries()) {
    target.operatorRunsById.set(runId, cloneStoredOperatorRun(run));
  }

  target.operatorTasksById.clear();
  for (const [taskId, task] of source.operatorTasksById.entries()) {
    target.operatorTasksById.set(taskId, cloneStoredOperatorTask(task));
  }

  target.operatorTaskIdsByRun.clear();
  for (const [runId, taskIds] of source.operatorTaskIdsByRun.entries()) {
    target.operatorTaskIdsByRun.set(runId, [...taskIds]);
  }

  target.operatorRunIdByConversationAndKey.clear();
  for (const [lookupKey, runId] of source.operatorRunIdByConversationAndKey.entries()) {
    target.operatorRunIdByConversationAndKey.set(lookupKey, runId);
  }

  target.operatorRunOrdinalsByConversation.clear();
  for (const [conversationId, ordinal] of source.operatorRunOrdinalsByConversation.entries()) {
    target.operatorRunOrdinalsByConversation.set(conversationId, ordinal);
  }
};

export const getContextVersionOrDefault = (
  state: InMemoryPersistenceState,
  conversationId: ConversationId,
): ContextVersion => {
  return state.contextVersionsByConversation.get(conversationId) ?? createContextVersion(0);
};
