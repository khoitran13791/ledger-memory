import { InvariantViolationError, createTokenCount, type ArtifactId, type ContextItem, type LedgerEvent } from '@ledgermind/domain';

import { ConversationNotFoundError, InvalidReferenceError } from '../errors/application-errors';
import type { EventPublisherPort } from '../ports/driven/events/event-publisher.port';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../ports/driven/persistence/conversation.port';
import type { LedgerReadPort } from '../ports/driven/persistence/ledger-read.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import type {
  ArtifactReference,
  MaterializeContextInput,
  MaterializeContextOutput,
  ModelMessage,
  PinRule,
  RunCompactionInput,
  RunCompactionOutput,
  SummaryReference,
} from '../ports/driving/memory-engine.port';

export class MaterializeContextBudgetExceededError extends Error {
  readonly code = 'MATERIALIZE_CONTEXT_BUDGET_EXCEEDED';
  readonly availableBudget: number;
  readonly requiredBudget: number;

  constructor(availableBudget: number, requiredBudget: number, message?: string) {
    super(
      message ??
        `Materialized context exceeds available budget (required ${requiredBudget}, available ${availableBudget}).`,
    );
    this.name = 'MaterializeContextBudgetExceededError';
    this.availableBudget = availableBudget;
    this.requiredBudget = requiredBudget;
  }
}

export interface MaterializeContextUseCaseDeps {
  readonly conversations: ConversationPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly ledgerRead: LedgerReadPort;
  readonly artifactStore: ArtifactStorePort;
  readonly runCompaction: (input: RunCompactionInput) => Promise<RunCompactionOutput>;
  readonly eventPublisher?: EventPublisherPort;
}

type ResolvedContextItem =
  | {
      readonly kind: 'message';
      readonly tokenCount: number;
      readonly modelMessage: ModelMessage;
    }
  | {
      readonly kind: 'summary';
      readonly tokenCount: number;
      readonly modelMessage: ModelMessage;
      readonly summaryReference: SummaryReference;
      readonly artifactIds: readonly ArtifactId[];
    };

const assertValidBudgetInput = (input: MaterializeContextInput): void => {
  if (!Number.isSafeInteger(input.budgetTokens) || input.budgetTokens <= 0) {
    throw new InvariantViolationError('MaterializeContextInput.budgetTokens must be a positive safe integer.');
  }

  if (!Number.isSafeInteger(input.overheadTokens) || input.overheadTokens < 0) {
    throw new InvariantViolationError(
      'MaterializeContextInput.overheadTokens must be a non-negative safe integer.',
    );
  }
};

const resolveContextItem = async (
  input: MaterializeContextInput,
  contextItem: ContextItem,
  eventsById: ReadonlyMap<LedgerEvent['id'], LedgerEvent>,
  summaryDag: SummaryDagPort,
): Promise<ResolvedContextItem> => {
  if (contextItem.ref.type === 'message') {
    const event = eventsById.get(contextItem.ref.messageId);
    if (event === undefined) {
      throw new InvariantViolationError(
        `Context item references unknown message: ${contextItem.ref.messageId}`,
      );
    }

    return {
      kind: 'message',
      tokenCount: event.tokenCount.value,
      modelMessage: {
        role: event.role,
        content: event.content,
      },
    };
  }

  const summaryNode = await summaryDag.getNode(contextItem.ref.summaryId);
  if (summaryNode === null || summaryNode.conversationId !== input.conversationId) {
    throw new InvalidReferenceError('summary', contextItem.ref.summaryId);
  }

  return {
    kind: 'summary',
    tokenCount: summaryNode.tokenCount.value,
    modelMessage: {
      role: 'assistant',
      content: `[Summary ID: ${summaryNode.id}]\n${summaryNode.content}`,
    },
    summaryReference: {
      id: summaryNode.id,
      kind: summaryNode.kind,
      tokenCount: summaryNode.tokenCount,
    },
    artifactIds: summaryNode.artifactIds,
  };
};

const collectArtifactReferences = async (
  conversationId: MaterializeContextInput['conversationId'],
  artifactIds: ReadonlySet<ArtifactId>,
  artifactStore: ArtifactStorePort,
): Promise<readonly ArtifactReference[]> => {
  const artifactReferences: ArtifactReference[] = [];

  for (const artifactId of artifactIds) {
    const artifact = await artifactStore.getMetadata(artifactId);
    if (artifact === null || artifact.conversationId !== conversationId) {
      throw new InvalidReferenceError('artifact', artifactId);
    }

    artifactReferences.push({
      id: artifact.id,
      mimeType: artifact.mimeType,
      tokenCount: artifact.tokenCount,
    });
  }

  return artifactReferences;
};

const buildSystemPreamble = (
  summaryReferences: readonly SummaryReference[],
  artifactReferences: readonly ArtifactReference[],
): string => {
  if (summaryReferences.length === 0 && artifactReferences.length === 0) {
    return '';
  }

  const parts: string[] = ['You have access to memory tools (memory.grep, memory.expand, memory.describe).'];

  if (summaryReferences.length > 0) {
    const ids = summaryReferences.map((ref) => ref.id).join(', ');
    parts.push(`Available summaries: ${ids}.`);
  }

  if (artifactReferences.length > 0) {
    const ids = artifactReferences.map((ref) => ref.id).join(', ');
    parts.push(`Available artifacts: ${ids}.`);
  }

  return parts.join(' ');
};

const isItemPinned = (
  contextItem: ContextItem,
  pinRules: readonly PinRule[],
): boolean => {
  for (const rule of pinRules) {
    if (rule.type === 'position' && contextItem.position === rule.position) {
      return true;
    }
    if (rule.type === 'message' && contextItem.ref.type === 'message' && contextItem.ref.messageId === rule.messageId) {
      return true;
    }
    if (rule.type === 'summary' && contextItem.ref.type === 'summary' && contextItem.ref.summaryId === rule.summaryId) {
      return true;
    }
  }
  return false;
};

export class MaterializeContextUseCase {
  constructor(private readonly deps: MaterializeContextUseCaseDeps) {}

  async execute(input: MaterializeContextInput): Promise<MaterializeContextOutput> {
    assertValidBudgetInput(input);

    const conversation = await this.deps.conversations.get(input.conversationId);
    if (conversation === null) {
      throw new ConversationNotFoundError(input.conversationId);
    }

    const requestedWindow = Math.min(input.budgetTokens, conversation.config.contextWindow.value);
    const availableBudget = requestedWindow - input.overheadTokens;

    if (availableBudget < 0) {
      throw new MaterializeContextBudgetExceededError(
        availableBudget,
        input.overheadTokens,
        'Materialized context budget is negative after applying overhead.',
      );
    }

    const hardThreshold = Math.floor(
      conversation.config.contextWindow.value * conversation.config.thresholds.hard,
    );
    const currentContextTokenCount = await this.deps.contextProjection.getContextTokenCount(input.conversationId);

    if (currentContextTokenCount.value > hardThreshold) {
      const compactionResult = await this.deps.runCompaction({
        conversationId: input.conversationId,
        trigger: 'hard',
        targetTokens: createTokenCount(availableBudget),
      });

      if (!compactionResult.converged) {
        throw new MaterializeContextBudgetExceededError(
          availableBudget,
          currentContextTokenCount.value,
          'Hard-threshold compaction failed to converge before materialization.',
        );
      }
    }

    const [contextSnapshot, allEvents] = await Promise.all([
      this.deps.contextProjection.getCurrentContext(input.conversationId),
      this.deps.ledgerRead.getEvents(input.conversationId),
    ]);

    const orderedContextItems = [...contextSnapshot.items].sort((left, right) => left.position - right.position);
    const eventsById = new Map(allEvents.map((event) => [event.id, event] as const));

    const resolvedItems: ResolvedContextItem[] = [];

    for (const contextItem of orderedContextItems) {
      resolvedItems.push(
        await resolveContextItem(input, contextItem, eventsById, this.deps.summaryDag),
      );
    }

    let budgetUsedValue = resolvedItems.reduce((total, item) => total + item.tokenCount, 0);
    if (budgetUsedValue > availableBudget) {
      throw new MaterializeContextBudgetExceededError(availableBudget, budgetUsedValue);
    }

    // Separate pinned and unpinned items, maintaining their relative order
    const pinRules = input.pinRules ?? [];
    if (pinRules.length > 0) {
      const pinnedIndices = new Set<number>();
      for (let i = 0; i < orderedContextItems.length; i++) {
        const contextItem = orderedContextItems[i];
        if (contextItem !== undefined && isItemPinned(contextItem, pinRules)) {
          pinnedIndices.add(i);
        }
      }

      const reorderedResolved: ResolvedContextItem[] = [];
      for (let i = 0; i < resolvedItems.length; i++) {
        const item = resolvedItems[i];
        if (pinnedIndices.has(i) && item !== undefined) {
          reorderedResolved.push(item);
        }
      }
      for (let i = 0; i < resolvedItems.length; i++) {
        const item = resolvedItems[i];
        if (!pinnedIndices.has(i) && item !== undefined) {
          reorderedResolved.push(item);
        }
      }
      resolvedItems.splice(0, resolvedItems.length, ...reorderedResolved);
    }

    const modelMessages: ModelMessage[] = [];
    const summaryReferences: SummaryReference[] = [];
    const artifactIds = new Set<ArtifactId>();

    for (const item of resolvedItems) {
      modelMessages.push(item.modelMessage);

      if (item.kind === 'summary') {
        summaryReferences.push(item.summaryReference);
        for (const artifactId of item.artifactIds) {
          artifactIds.add(artifactId);
        }
      }
    }

    const artifactReferences = await collectArtifactReferences(
      input.conversationId,
      artifactIds,
      this.deps.artifactStore,
    );

    // Retrieve additional summaries based on retrieval hints
    if (input.retrievalHints && input.retrievalHints.length > 0) {
      let currentBudget = budgetUsedValue;
      for (const hint of input.retrievalHints) {
        const matchedSummaries = await this.deps.summaryDag.searchSummaries(
          input.conversationId,
          hint.query,
        );

        const limit = hint.limit ?? 3;
        let added = 0;

        for (const summary of matchedSummaries) {
          if (added >= limit) break;

          const alreadyInContext = summaryReferences.some((ref) => ref.id === summary.id);
          if (alreadyInContext) continue;

          if (currentBudget + summary.tokenCount.value > availableBudget) continue;

          modelMessages.push({
            role: 'assistant',
            content: `[Summary ID: ${summary.id}]\n${summary.content}`,
          });
          summaryReferences.push({
            id: summary.id,
            kind: summary.kind,
            tokenCount: summary.tokenCount,
          });
          for (const artId of summary.artifactIds) {
            artifactIds.add(artId);
          }
          currentBudget += summary.tokenCount.value;
          added++;
        }
      }
      budgetUsedValue = currentBudget;
    }

    this.deps.eventPublisher?.publish({
      type: 'ContextMaterialized',
      conversationId: input.conversationId,
      budgetUsed: createTokenCount(budgetUsedValue),
      budgetTotal: createTokenCount(availableBudget),
      itemCount: modelMessages.length,
    });

    return {
      systemPreamble: buildSystemPreamble(summaryReferences, artifactReferences),
      modelMessages,
      summaryReferences,
      artifactReferences,
      budgetUsed: createTokenCount(budgetUsedValue),
    };
  }
}
