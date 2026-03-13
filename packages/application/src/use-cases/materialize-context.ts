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
  RetrievalCandidateDecisionDiagnostics,
  RetrievalHint,
  RetrievalHintDiagnostics,
  RetrievalStageLabel,
  RetrievalStageQueryDiagnostics,
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
      readonly contextItem: ContextItem;
      readonly recencyScore: number;
    }
  | {
      readonly kind: 'summary';
      readonly tokenCount: number;
      readonly modelMessage: ModelMessage;
      readonly summaryReference: SummaryReference;
      readonly artifactIds: readonly ArtifactId[];
      readonly contextItem: ContextItem;
      readonly recencyScore: number;
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

const resolveContextItem = async (input: {
  readonly materializeInput: MaterializeContextInput;
  readonly contextItem: ContextItem;
  readonly recencyScore: number;
  readonly eventsById: ReadonlyMap<LedgerEvent['id'], LedgerEvent>;
  readonly summaryDag: SummaryDagPort;
}): Promise<ResolvedContextItem> => {
  if (input.contextItem.ref.type === 'message') {
    const event = input.eventsById.get(input.contextItem.ref.messageId);
    if (event === undefined) {
      throw new InvariantViolationError(
        `Context item references unknown message: ${input.contextItem.ref.messageId}`,
      );
    }

    return {
      kind: 'message',
      tokenCount: event.tokenCount.value,
      modelMessage: {
        role: event.role,
        content: event.content,
      },
      contextItem: input.contextItem,
      recencyScore: input.recencyScore,
    };
  }

  const summaryNode = await input.summaryDag.getNode(input.contextItem.ref.summaryId);
  if (summaryNode === null || summaryNode.conversationId !== input.materializeInput.conversationId) {
    throw new InvalidReferenceError('summary', input.contextItem.ref.summaryId);
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
    contextItem: input.contextItem,
    recencyScore: input.recencyScore,
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

const toSearchTokens = (value: string): readonly string[] => {
  return value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
};

const toQueryOverlapCount = (query: string, content: string): number => {
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

const extractAnchorTokens = (query: string): readonly string[] => {
  return query
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9:_-]+$/g, ''))
    .filter((part) => part.length >= 3)
    .filter((part) => /\d/.test(part) || /[_:-]/.test(part) || /[A-Z]/.test(part));
};

const validateRetrievalScope = async (input: {
  readonly conversationId: MaterializeContextInput['conversationId'];
  readonly hint: RetrievalHint;
  readonly summaryDag: SummaryDagPort;
}): Promise<void> => {
  if (input.hint.scope === undefined) {
    return;
  }

  const scopedNode = await input.summaryDag.getNode(input.hint.scope);
  if (scopedNode === null || scopedNode.conversationId !== input.conversationId) {
    throw new InvalidReferenceError('summary_scope', input.hint.scope, `Unknown summary scope reference: ${input.hint.scope}`);
  }
};

const validateSearchScopeCoverage = (input: {
  readonly hint: RetrievalHint;
  readonly stageQueryDiagnostics: readonly RetrievalStageQueryDiagnostics[];
}): void => {
  if (input.hint.scope === undefined) {
    return;
  }

  const totalMatchCount = input.stageQueryDiagnostics.reduce((acc, stageQuery) => acc + stageQuery.matchCount, 0);
  if (totalMatchCount === 0) {
    throw new InvalidReferenceError(
      'summary_scope',
      input.hint.scope,
      `Summary scope ${input.hint.scope} did not match retrieval query: ${input.hint.query.trim()}`,
    );
  }
};

const expandRetrievalHintQueries = (
  hint: RetrievalHint,
): readonly { readonly stage: RetrievalStageLabel; readonly query: string }[] => {
  const normalized = hint.query.trim();
  if (normalized.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const entries: { stage: RetrievalStageLabel; query: string }[] = [];

  const push = (stage: RetrievalStageLabel, query: string): void => {
    const collapsed = query.trim().replace(/\s+/g, ' ');
    if (collapsed.length === 0 || seen.has(collapsed)) {
      return;
    }

    seen.add(collapsed);
    entries.push({ stage, query: collapsed });
  };

  push('primary', normalized);

  const keywordQuery = toSearchTokens(normalized)
    .filter((token) => token.length >= 3)
    .slice(0, 8)
    .join(' ');

  if (keywordQuery.length > 0 && keywordQuery !== normalized.toLocaleLowerCase()) {
    push('keywords', keywordQuery);
  }

  const anchors = extractAnchorTokens(normalized);
  if (anchors.length > 0) {
    push('anchors', anchors.join(' '));
  }

  return entries;
};

const trimResolvedItemsToBudget = (input: {
  readonly items: readonly ResolvedContextItem[];
  readonly tokenBudget: number;
  readonly pinRules: readonly PinRule[];
}): {
  readonly selectedItems: readonly ResolvedContextItem[];
  readonly budgetUsed: number;
  readonly trimmedToFit: boolean;
  readonly droppedMessageCount: number;
  readonly droppedSummaryCount: number;
} => {
  const totalTokens = input.items.reduce((acc, item) => acc + item.tokenCount, 0);
  if (totalTokens <= input.tokenBudget) {
    const selectedItems = [...input.items].sort((left, right) => left.contextItem.position - right.contextItem.position);

    return {
      selectedItems,
      budgetUsed: totalTokens,
      trimmedToFit: false,
      droppedMessageCount: 0,
      droppedSummaryCount: 0,
    };
  }

  const withPinned = input.items.map((item) => ({
    item,
    pinned: isItemPinned(item.contextItem, input.pinRules),
  }));

  const pinned = withPinned.filter((entry) => entry.pinned).map((entry) => entry.item);
  const pinnedTokens = pinned.reduce((acc, item) => acc + item.tokenCount, 0);

  if (pinnedTokens > input.tokenBudget) {
    throw new MaterializeContextBudgetExceededError(
      input.tokenBudget,
      pinnedTokens,
      'Pinned context items exceed available budget after overhead.',
    );
  }

  const unpinnedRanked = withPinned
    .filter((entry) => !entry.pinned)
    .map((entry) => entry.item)
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'message' ? -1 : 1;
      }

      if (right.recencyScore !== left.recencyScore) {
        return right.recencyScore - left.recencyScore;
      }

      if (right.contextItem.position !== left.contextItem.position) {
        return right.contextItem.position - left.contextItem.position;
      }

      return 0;
    });

  const selected: ResolvedContextItem[] = [...pinned];
  let used = pinnedTokens;

  for (const item of unpinnedRanked) {
    if (used + item.tokenCount > input.tokenBudget) {
      continue;
    }

    selected.push(item);
    used += item.tokenCount;
  }

  const selectedItems = [...selected].sort((left, right) => left.contextItem.position - right.contextItem.position);
  const selectedSet = new Set(selectedItems);
  const dropped = input.items.filter((item) => !selectedSet.has(item));

  return {
    selectedItems,
    budgetUsed: used,
    trimmedToFit: true,
    droppedMessageCount: dropped.filter((item) => item.kind === 'message').length,
    droppedSummaryCount: dropped.filter((item) => item.kind === 'summary').length,
  };
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

    let compactionTriggered = false;
    const needsFitCompaction = currentContextTokenCount.value > availableBudget;
    const exceedsHardThreshold = currentContextTokenCount.value > hardThreshold;

    if (needsFitCompaction || exceedsHardThreshold) {
      compactionTriggered = true;
      await this.deps.runCompaction({
        conversationId: input.conversationId,
        trigger: needsFitCompaction ? 'soft' : 'hard',
        targetTokens: createTokenCount(availableBudget),
      });
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
        await resolveContextItem({
          materializeInput: input,
          contextItem,
          recencyScore: contextItem.position,
          eventsById,
          summaryDag: this.deps.summaryDag,
        }),
      );
    }

    const pinRules = input.pinRules ?? [];
    const retrievalHints = input.retrievalHints ?? [];
    const retrievalHintCount = retrievalHints.length;
    const retrievalReserve = retrievalHintCount === 0 ? 0 : Math.min(256, Math.floor(availableBudget * 0.2));
    const baseBudget = Math.max(0, availableBudget - retrievalReserve);

    const trimmedBase = trimResolvedItemsToBudget({
      items: resolvedItems,
      tokenBudget: baseBudget,
      pinRules,
    });

    let budgetUsedValue = trimmedBase.budgetUsed;
    let trimmedToFit = trimmedBase.trimmedToFit;
    let droppedMessageCount = trimmedBase.droppedMessageCount;
    let droppedSummaryCount = trimmedBase.droppedSummaryCount;

    const modelMessages: ModelMessage[] = [];
    const summaryReferences: SummaryReference[] = [];
    const summaryArtifactIdsById = new Map<string, readonly ArtifactId[]>();

    for (const item of trimmedBase.selectedItems) {
      modelMessages.push(item.modelMessage);

      if (item.kind === 'summary') {
        summaryReferences.push(item.summaryReference);
        summaryArtifactIdsById.set(String(item.summaryReference.id), item.artifactIds);
      }
    }

    let retrievalMatchCount = 0;
    let retrievalAddedCount = 0;
    const retrievalDiagnostics: RetrievalHintDiagnostics[] = [];

    if (retrievalHints.length > 0) {
      for (const hint of retrievalHints) {
        await validateRetrievalScope({
          conversationId: input.conversationId,
          hint,
          summaryDag: this.deps.summaryDag,
        });

        const retrievalQuery = hint.query.trim();
        if (retrievalQuery.length === 0) {
          continue;
        }

        const limit = hint.limit ?? 3;
        const stageQueries = expandRetrievalHintQueries(hint);
        const stageQueryDiagnostics: RetrievalStageQueryDiagnostics[] = [];
        const candidateMap = new Map<string, {
          readonly summary: SummaryReference & {
            readonly content: string;
            readonly artifactIds: readonly ArtifactId[];
            readonly createdAt: Date;
          };
          stageHits: number;
          overlapCount: number;
          maxStageMatchCount: number;
        }>();

        for (const stageQuery of stageQueries) {
          const matchedSummaries = await this.deps.summaryDag.searchSummaries(
            input.conversationId,
            stageQuery.query,
            hint.scope,
          );

          retrievalMatchCount += matchedSummaries.length;
          stageQueryDiagnostics.push({
            stage: stageQuery.stage,
            query: stageQuery.query,
            matchCount: matchedSummaries.length,
          });

          for (const summary of matchedSummaries) {
            const key = String(summary.id);
            const overlapCount = toQueryOverlapCount(stageQuery.query, summary.content);
            const existing = candidateMap.get(key);
            if (existing === undefined) {
              candidateMap.set(key, {
                summary,
                stageHits: 1,
                overlapCount,
                maxStageMatchCount: matchedSummaries.length,
              });
              continue;
            }

            existing.stageHits += 1;
            if (overlapCount > existing.overlapCount) {
              existing.overlapCount = overlapCount;
            }
            if (matchedSummaries.length > existing.maxStageMatchCount) {
              existing.maxStageMatchCount = matchedSummaries.length;
            }
          }
        }

        validateSearchScopeCoverage({
          hint,
          stageQueryDiagnostics,
        });

        const rankedCandidates = [...candidateMap.values()]
          .map((entry) => {
            const score = entry.stageHits * 100 + entry.overlapCount * 10 + entry.maxStageMatchCount;
            return {
              ...entry,
              score,
            };
          })
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            const createdAtDiff = right.summary.createdAt.getTime() - left.summary.createdAt.getTime();
            if (createdAtDiff !== 0) {
              return createdAtDiff;
            }

            return String(left.summary.id).localeCompare(String(right.summary.id));
          });

        const candidateDecisions: RetrievalCandidateDecisionDiagnostics[] = [];
        const selectedSummaryIds: SummaryReference['id'][] = [];
        let addedForHint = 0;

        for (const candidate of rankedCandidates) {
          const summary = candidate.summary;
          const tokenCount = summary.tokenCount.value;
          const alreadyInContext = summaryReferences.some((ref) => ref.id === summary.id);

          if (alreadyInContext) {
            candidateDecisions.push({
              summaryId: summary.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount,
              selected: false,
              reason: 'already_in_context',
            });
            continue;
          }

          if (addedForHint >= limit) {
            candidateDecisions.push({
              summaryId: summary.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount,
              selected: false,
              reason: 'limit_reached',
            });
            continue;
          }

          if (budgetUsedValue + tokenCount > availableBudget) {
            candidateDecisions.push({
              summaryId: summary.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount,
              selected: false,
              reason: 'over_budget',
            });
            continue;
          }

          modelMessages.push({
            role: 'assistant',
            content: `[Summary ID: ${summary.id}]\n${summary.content}`,
          });
          summaryReferences.push({
            id: summary.id,
            kind: summary.kind,
            tokenCount: summary.tokenCount,
          });
          summaryArtifactIdsById.set(String(summary.id), summary.artifactIds);

          budgetUsedValue += tokenCount;
          addedForHint += 1;
          retrievalAddedCount += 1;
          selectedSummaryIds.push(summary.id);

          candidateDecisions.push({
            summaryId: summary.id,
            score: candidate.score,
            stageHits: candidate.stageHits,
            overlapCount: candidate.overlapCount,
            tokenCount,
            selected: true,
            reason: 'selected',
          });
        }

        retrievalDiagnostics.push({
          hintQuery: retrievalQuery,
          ...(hint.scope === undefined ? {} : { scopeSummaryId: hint.scope }),
          limit,
          stageQueries: stageQueryDiagnostics,
          candidateDecisions,
          selectedSummaryIds,
        });
      }
    }

    if (budgetUsedValue > availableBudget) {
      const summaryRefById = new Map(summaryReferences.map((reference) => [reference.id, reference] as const));
      const selectedWithMeta = modelMessages.map((message, index) => {
        const summaryIdMatch = message.content.match(/^\[Summary ID: ([^\]]+)\]/m);
        const summaryId = summaryIdMatch?.[1];
        const summaryReference = summaryId === undefined ? undefined : summaryRefById.get(summaryId as SummaryReference['id']);
        const tokenCount =
          summaryReference?.tokenCount.value ?? Math.max(1, Math.ceil(message.content.length / 4));
        return {
          message,
          tokenCount,
          summaryId,
          index,
        };
      });

      const prioritized = [...selectedWithMeta].sort((left, right) => {
        const leftKindPriority = left.summaryId === undefined ? 0 : 1;
        const rightKindPriority = right.summaryId === undefined ? 0 : 1;
        if (leftKindPriority !== rightKindPriority) {
          return leftKindPriority - rightKindPriority;
        }

        return left.index - right.index;
      });

      const keptSet = new Set<typeof selectedWithMeta[number]>();
      let used = 0;

      for (const item of prioritized) {
        if (used + item.tokenCount > availableBudget) {
          continue;
        }

        keptSet.add(item);
        used += item.tokenCount;
      }

      const kept = selectedWithMeta.filter((item) => keptSet.has(item));
      for (const item of selectedWithMeta) {
        if (keptSet.has(item)) {
          continue;
        }

        if (item.summaryId !== undefined) {
          droppedSummaryCount += 1;
        } else {
          droppedMessageCount += 1;
        }
      }

      if (kept.length < selectedWithMeta.length) {
        trimmedToFit = true;
      }

      modelMessages.splice(0, modelMessages.length, ...kept.map((item) => item.message));

      const keptSummaryIds = new Set(
        kept
          .map((item) => item.summaryId)
          .filter((summaryId): summaryId is string => summaryId !== undefined),
      );

      summaryReferences.splice(
        0,
        summaryReferences.length,
        ...summaryReferences.filter((reference) => keptSummaryIds.has(reference.id)),
      );

      budgetUsedValue = used;
    }

    const artifactIds = new Set<ArtifactId>();
    for (const summaryReference of summaryReferences) {
      for (const artifactId of summaryArtifactIdsById.get(String(summaryReference.id)) ?? []) {
        artifactIds.add(artifactId);
      }
    }

    const artifactReferences = await collectArtifactReferences(
      input.conversationId,
      artifactIds,
      this.deps.artifactStore,
    );

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
      retrievalMatchCount,
      retrievalAddedCount,
      ...(retrievalDiagnostics.length === 0 ? {} : { retrievalDiagnostics: Object.freeze(retrievalDiagnostics) }),
      compactionTriggered,
      trimmedToFit,
      droppedMessageCount,
      droppedSummaryCount,
    };
  }
}
