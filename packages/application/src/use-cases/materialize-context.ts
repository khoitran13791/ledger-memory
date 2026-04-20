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
  RetrievalMessageDecisionDiagnostics,
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

type RankedRetrievalCandidate =
  | {
      readonly kind: 'message';
      readonly id: LedgerEvent['id'];
      readonly tokenCount: number;
      readonly score: number;
      readonly stageHits: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly rankTieBreaker: number;
      readonly modelMessage: ModelMessage;
    }
  | {
      readonly kind: 'summary';
      readonly id: SummaryReference['id'];
      readonly tokenCount: number;
      readonly score: number;
      readonly stageHits: number;
      readonly overlapCount: number;
      readonly rankTieBreaker: number;
      readonly summary: SummaryReference & {
        readonly content: string;
        readonly artifactIds: readonly ArtifactId[];
        readonly createdAt: Date;
      };
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
      ...(artifact.originalPath === null ? {} : { originalPath: artifact.originalPath }),
      ...(artifact.explorationSummary === null
        ? {}
        : { explorationSummary: artifact.explorationSummary }),
    });
  }

  return artifactReferences;
};

const MAX_ARTIFACT_IDS_IN_PREAMBLE = 4;
const MAX_ARTIFACT_SUMMARY_TEASER_CHARS = 140;

const createArtifactSummaryTeaser = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_ARTIFACT_SUMMARY_TEASER_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_ARTIFACT_SUMMARY_TEASER_CHARS - 3)}...`;
};

const formatArtifactReferenceForPreamble = (reference: ArtifactReference): string => {
  const withPath =
    reference.originalPath === undefined
      ? reference.id
      : `${reference.id} (${reference.originalPath})`;

  if (reference.explorationSummary === undefined) {
    return withPath;
  }

  const teaser = createArtifactSummaryTeaser(reference.explorationSummary);
  if (teaser.length === 0) {
    return withPath;
  }

  return `${withPath} - ${teaser}`;
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
    const visibleArtifacts = artifactReferences
      .slice(0, MAX_ARTIFACT_IDS_IN_PREAMBLE)
      .map((reference) => formatArtifactReferenceForPreamble(reference))
      .join(', ');
    const omittedCount = Math.max(0, artifactReferences.length - MAX_ARTIFACT_IDS_IN_PREAMBLE);
    parts.push(
      omittedCount === 0
        ? `Available artifacts: ${visibleArtifacts}.`
        : `Available artifacts: ${visibleArtifacts}, and ${omittedCount} more.`,
    );
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

const RETRIEVAL_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'did',
  'do',
  'does',
  'doing',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'out',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'would',
  'you',
  'your',
]);

const IRREGULAR_RETRIEVAL_TOKEN_NORMALIZATIONS = new Map<string, string>([
  ['ate', 'eat'],
  ['been', 'be'],
  ['being', 'be'],
  ['bought', 'buy'],
  ['did', 'do'],
  ['does', 'do'],
  ['doing', 'do'],
  ['done', 'do'],
  ['gave', 'give'],
  ['gone', 'go'],
  ['goes', 'go'],
  ['got', 'get'],
  ['had', 'have'],
  ['has', 'have'],
  ['is', 'be'],
  ['left', 'leave'],
  ['made', 'make'],
  ['met', 'meet'],
  ['ran', 'run'],
  ['saw', 'see'],
  ['spoken', 'speak'],
  ['spoke', 'speak'],
  ['taken', 'take'],
  ['taught', 'teach'],
  ['thought', 'think'],
  ['took', 'take'],
  ['was', 'be'],
  ['went', 'go'],
  ['were', 'be'],
  ['wrote', 'write'],
]);

const maybeCollapseRepeatedTrailingConsonant = (token: string): string => {
  if (token.length < 3) {
    return token;
  }

  const last = token.at(-1);
  const previous = token.at(-2);
  if (last === undefined || previous === undefined || last !== previous || /[aeiou]/.test(last)) {
    return token;
  }

  return token.slice(0, -1);
};

const toRetrievalTokenVariants = (token: string): readonly string[] => {
  const variants = new Set<string>([token]);
  const normalized = IRREGULAR_RETRIEVAL_TOKEN_NORMALIZATIONS.get(token);
  if (normalized !== undefined) {
    variants.add(normalized);
  }

  if (token.length > 4 && token.endsWith('ied')) {
    variants.add(`${token.slice(0, -3)}y`);
  }

  if (token.length > 4 && token.endsWith('ed')) {
    const stripped = maybeCollapseRepeatedTrailingConsonant(token.slice(0, -2));
    variants.add(stripped);
    variants.add(`${stripped}e`);
  }

  if (token.length > 5 && token.endsWith('ing')) {
    const stripped = maybeCollapseRepeatedTrailingConsonant(token.slice(0, -3));
    variants.add(stripped);
    variants.add(`${stripped}e`);
  }

  if (token.length > 4 && token.endsWith('es')) {
    variants.add(token.slice(0, -2));
  }

  if (token.length > 3 && token.endsWith('s')) {
    variants.add(token.slice(0, -1));
  }

  return [...variants].filter((variant) => variant.length > 1);
};

const toRetrievalSpecificTokenGroups = (value: string): readonly (readonly string[])[] => {
  return toSearchTokens(value)
    .map((token) =>
      [...new Set(toRetrievalTokenVariants(token))]
        .filter((variant) => variant.length > 1)
        .filter((variant) => !RETRIEVAL_STOPWORDS.has(variant)),
    )
    .filter((group) => group.length > 0);
};

const toRetrievalSpecificTokens = (value: string): readonly string[] => {
  return toRetrievalSpecificTokenGroups(value).flatMap((group) => group);
};

const toQuerySpecificityOverlapCount = (query: string, content: string): number => {
  const queryTokenGroups = toRetrievalSpecificTokenGroups(query);
  if (queryTokenGroups.length === 0) {
    return 0;
  }

  const contentTokens = new Set(toRetrievalSpecificTokens(content));
  let overlapCount = 0;

  for (const tokenGroup of queryTokenGroups) {
    if (tokenGroup.some((token) => contentTokens.has(token))) {
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
    const retrievalDiagnostics: RetrievalHintDiagnostics[] = [];
    const retrievedMessageIdsByIndex = new Map<number, LedgerEvent['id']>();
    const selectedRawEventIds = new Set(
      trimmedBase.selectedItems
        .filter((item): item is Extract<ResolvedContextItem, { kind: 'message' }> => item.kind === 'message')
        .map((item) => {
          const { ref } = item.contextItem;
          if (ref.type !== 'message') {
            throw new InvariantViolationError(
              'Expected selected raw context item to reference a message during retrieval ranking.',
            );
          }

          return String(ref.messageId);
        }),
    );

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
        }>();
        const eventCandidateMap = new Map<string, {
          readonly event: LedgerEvent;
          stageHits: number;
          overlapCount: number;
          specificityScore: number;
        }>();

        for (const stageQuery of stageQueries) {
          const matchedSummaries = await this.deps.summaryDag.searchSummaries(
            input.conversationId,
            stageQuery.query,
            hint.scope,
          );
          const matchedEvents = await this.deps.ledgerRead.searchEvents(
            input.conversationId,
            stageQuery.query,
            hint.scope,
          );
          const stageMatchCount = matchedSummaries.length + matchedEvents.length;

          retrievalMatchCount += stageMatchCount;
          stageQueryDiagnostics.push({
            stage: stageQuery.stage,
            query: stageQuery.query,
            matchCount: stageMatchCount,
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
              });
              continue;
            }

            existing.stageHits += 1;
            if (overlapCount > existing.overlapCount) {
              existing.overlapCount = overlapCount;
            }
          }

          for (const event of matchedEvents) {
            const key = String(event.id);
            const overlapCount = toQueryOverlapCount(stageQuery.query, event.content);
            const specificityScore = toQuerySpecificityOverlapCount(stageQuery.query, event.content);
            const existing = eventCandidateMap.get(key);
            if (existing === undefined) {
              eventCandidateMap.set(key, {
                event,
                stageHits: 1,
                overlapCount,
                specificityScore,
              });
              continue;
            }

            existing.stageHits += 1;
            if (overlapCount > existing.overlapCount) {
              existing.overlapCount = overlapCount;
            }
            if (specificityScore > existing.specificityScore) {
              existing.specificityScore = specificityScore;
            }
          }
        }

        validateSearchScopeCoverage({
          hint,
          stageQueryDiagnostics,
        });

        const rankedEventCandidates = Array.from(eventCandidateMap.values()).map((entry) => {
          const score = entry.specificityScore * 100 + entry.stageHits * 10 + entry.overlapCount;
          return {
            kind: 'message' as const,
            id: entry.event.id,
            tokenCount: entry.event.tokenCount.value,
            score,
            stageHits: entry.stageHits,
            overlapCount: entry.overlapCount,
            specificityScore: entry.specificityScore,
            rankTieBreaker: entry.event.sequence,
            modelMessage: {
              role: entry.event.role,
              content: entry.event.content,
            },
          };
        });
        const rankedSummaryCandidates = Array.from(candidateMap.values()).map((entry) => {
          const score = entry.stageHits * 100 + entry.overlapCount * 10;
          return {
            kind: 'summary' as const,
            id: entry.summary.id,
            tokenCount: entry.summary.tokenCount.value,
            score,
            stageHits: entry.stageHits,
            overlapCount: entry.overlapCount,
            rankTieBreaker: -entry.summary.createdAt.getTime(),
            summary: entry.summary,
          };
        });
        const rankedCandidates: RankedRetrievalCandidate[] = [
          ...rankedEventCandidates,
          ...rankedSummaryCandidates,
        ].sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }

          if (left.kind !== right.kind) {
            return left.kind === 'message' ? -1 : 1;
          }

          if (left.rankTieBreaker !== right.rankTieBreaker) {
            return left.rankTieBreaker - right.rankTieBreaker;
          }

          return String(left.id).localeCompare(String(right.id));
        });

        const candidateDecisions: RetrievalCandidateDecisionDiagnostics[] = [];
        const messageDecisions: RetrievalMessageDecisionDiagnostics[] = [];
        const selectedSummaryIds: SummaryReference['id'][] = [];
        const selectedMessageIds: LedgerEvent['id'][] = [];
        let addedForHint = 0;

        for (const candidate of rankedCandidates) {
          if (candidate.kind === 'message') {
            const eventId = String(candidate.id);

            if (selectedRawEventIds.has(eventId)) {
              messageDecisions.push({
                messageId: candidate.id,
                score: candidate.score,
                stageHits: candidate.stageHits,
                overlapCount: candidate.overlapCount,
                specificityScore: candidate.specificityScore,
                tokenCount: candidate.tokenCount,
                selected: false,
                reason: 'already_in_context',
              });
              continue;
            }
            if (addedForHint >= limit) {
              messageDecisions.push({
                messageId: candidate.id,
                score: candidate.score,
                stageHits: candidate.stageHits,
                overlapCount: candidate.overlapCount,
                specificityScore: candidate.specificityScore,
                tokenCount: candidate.tokenCount,
                selected: false,
                reason: 'limit_reached',
              });
              continue;
            }
            if (budgetUsedValue + candidate.tokenCount > availableBudget) {
              messageDecisions.push({
                messageId: candidate.id,
                score: candidate.score,
                stageHits: candidate.stageHits,
                overlapCount: candidate.overlapCount,
                specificityScore: candidate.specificityScore,
                tokenCount: candidate.tokenCount,
                selected: false,
                reason: 'over_budget',
              });
              continue;
            }

            modelMessages.push(candidate.modelMessage);
            retrievedMessageIdsByIndex.set(modelMessages.length - 1, candidate.id);
            selectedRawEventIds.add(eventId);
            budgetUsedValue += candidate.tokenCount;
            addedForHint += 1;
            selectedMessageIds.push(candidate.id);
            messageDecisions.push({
              messageId: candidate.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              specificityScore: candidate.specificityScore,
              tokenCount: candidate.tokenCount,
              selected: true,
              reason: 'selected',
            });
            continue;
          }

          const summary = candidate.summary;
          const alreadyInContext = summaryReferences.some((ref) => ref.id === summary.id);

          if (alreadyInContext) {
            candidateDecisions.push({
              summaryId: summary.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount: candidate.tokenCount,
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
              tokenCount: candidate.tokenCount,
              selected: false,
              reason: 'limit_reached',
            });
            continue;
          }

          if (budgetUsedValue + candidate.tokenCount > availableBudget) {
            candidateDecisions.push({
              summaryId: summary.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount: candidate.tokenCount,
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

          budgetUsedValue += candidate.tokenCount;
          addedForHint += 1;
          selectedSummaryIds.push(summary.id);

          candidateDecisions.push({
            summaryId: summary.id,
            score: candidate.score,
            stageHits: candidate.stageHits,
            overlapCount: candidate.overlapCount,
            tokenCount: candidate.tokenCount,
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
          messageDecisions,
          selectedSummaryIds,
          selectedMessageIds,
        });
      }
    }

    let finalSelectedMessageIdStrings: ReadonlySet<string> | undefined;
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
          retrievedMessageId: retrievedMessageIdsByIndex.get(index),
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
      finalSelectedMessageIdStrings = new Set(
        kept
          .map((item) => item.retrievedMessageId)
          .filter((messageId): messageId is LedgerEvent['id'] => messageId !== undefined)
          .map((messageId) => String(messageId)),
      );

      summaryReferences.splice(
        0,
        summaryReferences.length,
        ...summaryReferences.filter((reference) => keptSummaryIds.has(reference.id)),
      );

      budgetUsedValue = used;
    }

    const keptSummaryIdStrings = new Set(summaryReferences.map((reference) => String(reference.id)));
    const keptMessageIdStrings =
      finalSelectedMessageIdStrings ??
      new Set(retrievalDiagnostics.flatMap((hint) => hint.selectedMessageIds.map((messageId) => String(messageId))));
    const finalizedRetrievalDiagnostics = retrievalDiagnostics.map((hint) => {
      const selectedSummaryIds = hint.selectedSummaryIds.filter((summaryId) =>
        keptSummaryIdStrings.has(String(summaryId)),
      );
      const selectedMessageIds = hint.selectedMessageIds.filter((messageId) =>
        keptMessageIdStrings.has(String(messageId)),
      );
      const finalizedSummaryIdStrings = new Set(selectedSummaryIds.map((summaryId) => String(summaryId)));
      const finalizedMessageIdStrings = new Set(selectedMessageIds.map((messageId) => String(messageId)));

      return {
        ...hint,
        candidateDecisions: hint.candidateDecisions.map((candidate) => {
          if (!candidate.selected || finalizedSummaryIdStrings.has(String(candidate.summaryId))) {
            return candidate;
          }

          return {
            ...candidate,
            selected: false,
            reason: 'over_budget' as const,
          };
        }),
        messageDecisions: hint.messageDecisions.map((candidate) => {
          if (!candidate.selected || finalizedMessageIdStrings.has(String(candidate.messageId))) {
            return candidate;
          }

          return {
            ...candidate,
            selected: false,
            reason: 'over_budget' as const,
          };
        }),
        selectedSummaryIds,
        selectedMessageIds,
      };
    });
    const finalizedRetrievalAddedCount = finalizedRetrievalDiagnostics.reduce(
      (count, hint) => count + hint.selectedSummaryIds.length + hint.selectedMessageIds.length,
      0,
    );
    const finalizedRetrievalAddedMessageCount = finalizedRetrievalDiagnostics.reduce(
      (count, hint) => count + hint.selectedMessageIds.length,
      0,
    );
    const finalizedRetrievalAddedSummaryCount = finalizedRetrievalDiagnostics.reduce(
      (count, hint) => count + hint.selectedSummaryIds.length,
      0,
    );

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
      retrievalAddedCount: finalizedRetrievalAddedCount,
      retrievalAddedMessageCount: finalizedRetrievalAddedMessageCount,
      retrievalAddedSummaryCount: finalizedRetrievalAddedSummaryCount,
      ...(finalizedRetrievalDiagnostics.length === 0
        ? {}
        : { retrievalDiagnostics: Object.freeze(finalizedRetrievalDiagnostics) }),
      compactionTriggered,
      trimmedToFit,
      droppedMessageCount,
      droppedSummaryCount,
    };
  }
}
