import { InvariantViolationError, createTokenCount, type ArtifactId, type ContextItem, type LedgerEvent } from '@ledgermind/domain';

import { ConversationNotFoundError, InvalidReferenceError } from '../errors/application-errors';
import type { EventPublisherPort } from '../ports/driven/events/event-publisher.port';
import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
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
  readonly tokenizer: TokenizerPort;
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
      readonly specificityScore: number;
      readonly anchorCount: number;
      readonly rankTieBreaker: number;
      readonly summary: SummaryReference & {
        readonly content: string;
        readonly retrievalText: string;
        readonly artifactIds: readonly ArtifactId[];
        readonly createdAt: Date;
      };
    };

type RetrievalContender =
  | {
      readonly kind: 'bridge_summary';
      readonly hintIndex: number;
      readonly limit: number;
      readonly selectionOrder: number;
      readonly score: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly evidenceScore: number;
      readonly concreteCueCount: number;
      readonly tokenCount: number;
      readonly candidate: RankedSummaryRetrievalCandidate;
      readonly query: string;
      readonly summaryReference: SummaryReference;
      readonly artifactIds: readonly ArtifactId[];
      readonly modelMessage: ModelMessage;
    }
  | {
      readonly kind: 'raw_bundle';
      readonly hintIndex: number;
      readonly limit: number;
      readonly selectionOrder: number;
      readonly score: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly tokenCount: number;
      readonly seedId: LedgerEvent['id'];
      readonly source: 'generic' | 'bridge_scoped';
      readonly anchorCoverageCount: number;
      readonly windowStartSequence: number;
      readonly windowEndSequence: number;
      readonly events: readonly LedgerEvent[];
    };

type PackableUnit =
  | {
      readonly kind: 'base_message';
      readonly tokenCount: number;
      readonly order: number;
      readonly pinned: boolean;
      readonly modelMessages: readonly ModelMessage[];
    }
  | {
      readonly kind: 'base_summary';
      readonly tokenCount: number;
      readonly order: number;
      readonly pinned: boolean;
      readonly modelMessages: readonly ModelMessage[];
      readonly summaryReferences: readonly SummaryReference[];
    }
  | {
      readonly kind: 'retrieval_bridge_summary';
      readonly hintIndex: number;
      readonly limit: number;
      readonly score: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly evidenceScore: number;
      readonly concreteCueCount: number;
      readonly tokenCount: number;
      readonly order: number;
      readonly selectionOrder: number;
      readonly candidate: RankedSummaryRetrievalCandidate;
      readonly query: string;
      readonly modelMessages: readonly ModelMessage[];
      readonly summaryReferences: readonly SummaryReference[];
      readonly artifactIds: readonly ArtifactId[];
    }
  | {
      readonly kind: 'retrieval_raw_bundle';
      readonly hintIndex: number;
      readonly limit: number;
      readonly score: number;
      readonly overlapCount: number;
      readonly specificityScore: number;
      readonly tokenCount: number;
      readonly order: number;
      readonly selectionOrder: number;
      readonly seedId: LedgerEvent['id'];
      readonly source: 'generic' | 'bridge_scoped';
      readonly anchorCoverageCount: number;
      readonly windowStartSequence: number;
      readonly windowEndSequence: number;
      readonly messageIds: readonly LedgerEvent['id'][];
      readonly modelMessages: readonly ModelMessage[];
    };

type RetrievalBridgeSummaryUnit = Extract<PackableUnit, { kind: 'retrieval_bridge_summary' }>;
type RetrievalRawBundleUnit = Extract<PackableUnit, { kind: 'retrieval_raw_bundle' }>;
type RankedSummaryRetrievalCandidate = Extract<RankedRetrievalCandidate, { kind: 'summary' }>;
type BasePackableUnit = Extract<PackableUnit, { kind: 'base_message' | 'base_summary' }>;
const MIN_ANSWER_BEARING_BRIDGE_EVIDENCE_SCORE = 120;
type MaterializedBridgeSummarySelection = {
  readonly candidate: RankedSummaryRetrievalCandidate;
  readonly tokenCount: number;
  readonly content: string;
  readonly evidenceScore: number;
  readonly evidenceDirectRelevance: number;
  readonly concreteCueCount: number;
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

const buildRetrievedEventWindow = (input: {
  readonly seed: LedgerEvent;
  readonly eventsBySequence: ReadonlyMap<number, LedgerEvent>;
}): readonly LedgerEvent[] => {
  const previous = input.eventsBySequence.get(input.seed.sequence - 1);
  const next = input.eventsBySequence.get(input.seed.sequence + 1);

  return [previous, input.seed, next].filter((event): event is LedgerEvent => event !== undefined);
};

const countAnchorCoverage = (query: string, content: string): number => {
  const anchors = extractAnchorTokens(query);
  if (anchors.length === 0) {
    return 0;
  }

  const normalizedContent = content.toLocaleLowerCase();
  return anchors.filter((anchor) => normalizedContent.includes(anchor.toLocaleLowerCase())).length;
};

const buildSummaryModelMessage = (summaryId: SummaryReference['id'], content: string): ModelMessage => ({
  role: 'assistant',
  content: `[Summary ID: ${summaryId}]\n${content}`,
});

const SUMMARY_FACT_PREFIX = '[summary_fact]';

const normalizeBridgeFactAnchors = (value: string): string =>
  value
    .replace(/\|\s*shared:([^\s|]+)/gi, ' | [shared $1]')
    .replace(/\|\s*shared_caption:([^\s|]+)/gi, ' | [shared_caption $1]');

const parseBridgeFactParts = (
  line: string,
): {
  readonly date?: string;
  readonly id: string;
  readonly speaker: string;
  readonly fact: string;
  readonly sharedId?: string;
  readonly sharedCaptionId?: string;
} | undefined => {
  const sharedMatch = line.match(/\[shared\s+([^\]]+)\]/i);
  const sharedCaptionMatch = line.match(/\[shared_caption\s+([^\]]+)\]/i);
  const lineWithoutAnchors = line
    .replace(/\s*\|\s*\[shared\s+[^\]]+\]/gi, '')
    .replace(/\s*\|\s*\[shared_caption\s+[^\]]+\]/gi, '');
  const segments = lineWithoutAnchors
    .split('|')
    .map((segment) => segment.trim())
    .map((segment) => segment.replace(/^\[summary_fact\]\s*/iu, '').trim())
    .filter((segment) => segment.length > 0);
  const idIndex = segments.findIndex((segment) => /^ID:/i.test(segment));

  if (idIndex < 0) {
    return undefined;
  }

  const id = segments[idIndex]?.replace(/^ID:\s*/i, '').trim();
  const date = segments.find((segment) => /^DATE:/i.test(segment))?.replace(/^DATE:\s*/i, '').trim();
  const factSegments = segments.slice(idIndex + 1);
  const firstFactSegment = factSegments[0];

  if (id === undefined || id.length === 0 || firstFactSegment === undefined) {
    return undefined;
  }

  const separatorIndex = firstFactSegment.indexOf(':');
  let speaker: string;
  let fact: string;

  if (separatorIndex > 0) {
    speaker = firstFactSegment.slice(0, separatorIndex).trim();
    fact = [firstFactSegment.slice(separatorIndex + 1).trim(), ...factSegments.slice(1)]
      .filter((segment) => segment.length > 0)
      .join(' | ')
      .trim();
  } else {
    speaker = firstFactSegment.replace(/:\s*$/u, '').trim();
    fact = factSegments.slice(1).join(' | ').trim();
  }

  if (speaker.length === 0 || fact.length === 0) {
    return undefined;
  }

  return {
    ...(date === undefined || date.length === 0 ? {} : { date }),
    id,
    speaker,
    fact,
    ...(sharedMatch?.[1] === undefined ? {} : { sharedId: sharedMatch[1].trim() }),
    ...(sharedCaptionMatch?.[1] === undefined ? {} : { sharedCaptionId: sharedCaptionMatch[1].trim() }),
  };
};

type BridgeFact = {
  readonly index: number;
  readonly date?: string;
  readonly id: string;
  readonly speaker: string;
  readonly fact: string;
  readonly sharedId?: string;
  readonly sharedCaptionId?: string;
};

type BridgeFactVariant = {
  readonly text: string;
  readonly tokenCount: number;
};

const toBridgeFactLine = (
  fact: BridgeFact,
  options: {
    readonly includePrefix: boolean;
    readonly includeDate: boolean;
    readonly includeAnchors: boolean;
    readonly minimal: boolean;
  },
): string => {
  if (options.minimal) {
    return `ID:${fact.id} | ${fact.speaker}: ${fact.fact}`;
  }

  return [
    options.includePrefix ? SUMMARY_FACT_PREFIX : undefined,
    options.includeDate && fact.date !== undefined ? `DATE:${fact.date}` : undefined,
    `ID:${fact.id}`,
    fact.speaker,
    fact.fact,
    options.includeAnchors && fact.sharedId !== undefined ? `[shared ${fact.sharedId}]` : undefined,
    options.includeAnchors && fact.sharedCaptionId !== undefined
      ? `[shared_caption ${fact.sharedCaptionId}]`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' | ');
};

const extractBridgeFacts = (text: string): readonly BridgeFact[] => {
  const facts: BridgeFact[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split('\n')) {
    const line = normalizeBridgeFactAnchors(rawLine.trim());
    if (line.length === 0 || !line.includes('ID:')) {
      continue;
    }

    const parsed = parseBridgeFactParts(line);
    if (parsed === undefined) {
      continue;
    }

    const key = [
      parsed.date ?? '',
      parsed.id,
      parsed.speaker,
      parsed.fact,
      parsed.sharedId ?? '',
      parsed.sharedCaptionId ?? '',
    ].join('\u0000');

    if (!seen.has(key)) {
      seen.add(key);
      facts.push({
        index: facts.length,
        ...parsed,
      });
    }
  }

  return facts;
};

const truncateTextToTokenBudget = (
  text: string,
  maxTokens: number,
  tokenizer: TokenizerPort,
): string => {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return normalized;
  }

  if (tokenizer.countTokens(normalized).value <= maxTokens) {
    return normalized;
  }

  let cutoff = Math.max(1, Math.floor((normalized.length * maxTokens) / Math.max(1, tokenizer.countTokens(normalized).value)));
  let truncated = normalized.slice(0, cutoff).trim();

  while (truncated.length > 1 && tokenizer.countTokens(truncated).value > maxTokens) {
    cutoff = Math.max(1, Math.floor(cutoff * 0.9));
    truncated = normalized.slice(0, cutoff).trim();
    const boundary = truncated.lastIndexOf(' ');
    if (boundary > 0) {
      truncated = truncated.slice(0, boundary).trim();
    }
  }

  return truncated;
};

const CONCRETE_ANSWER_CUE_STOPWORDS = new Set([
  ...RETRIEVAL_STOPWORDS,
  'bye',
  'cheers',
  'cool',
  'hello',
  'haven',
  "haven't",
  'havent',
  'hey',
  'hi',
  'nice',
  'okay',
  'thanks',
  'thank',
  'ttyl',
  'wow',
  'yeah',
]);

const isQueryToken = (candidate: string, queryTokens: ReadonlySet<string>): boolean =>
  toRetrievalTokenVariants(candidate.toLocaleLowerCase()).some((variant) => queryTokens.has(variant));

const toConcreteAnswerCueCount = (value: string, query: string): number => {
  const queryTokens = new Set(toRetrievalSpecificTokens(query));
  const symbolMatches = value.match(/\b[A-Za-z]*\+\+|\b[A-Za-z]#|\b[A-Z]{2,}\b|\b\d+(?::\d+)?\b/g) ?? [];
  const properNounMatches =
    value.match(/\b[A-Z][a-z]{2,}(?:[-'][A-Z]?[a-z]+)?\b/g)?.filter((token) => {
      const normalized = token.toLocaleLowerCase();
      return !CONCRETE_ANSWER_CUE_STOPWORDS.has(normalized) && !isQueryToken(normalized, queryTokens);
    }) ??
    [];

  return new Set([...symbolMatches.filter((token) => !isQueryToken(token, queryTokens)), ...properNounMatches]).size;
};

const toBridgeFactDirectRelevance = (query: string, text: string): number =>
  toQuerySpecificityOverlapCount(query, text) * 30 +
  toQueryOverlapCount(query, text) * 10 +
  countAnchorCoverage(query, text) * 5;

const toBridgeFactEvidenceRelevanceText = (fact: BridgeFact): string => `${fact.speaker} ${fact.fact}`;

const toBridgeFactEvidenceScore = (input: {
  readonly query: string;
  readonly facts: readonly BridgeFact[];
  readonly fact: BridgeFact;
}): {
  readonly score: number;
  readonly directRelevance: number;
  readonly adjacentRelevance: number;
  readonly concreteCueCount: number;
} => {
  const relevanceByIndex = new Map(
    input.facts.map((fact) => {
      return [
        fact.index,
        toBridgeFactDirectRelevance(input.query, toBridgeFactEvidenceRelevanceText(fact)),
      ] as const;
    }),
  );
  const directRelevance =
    relevanceByIndex.get(input.fact.index) ??
    toBridgeFactDirectRelevance(input.query, toBridgeFactEvidenceRelevanceText(input.fact));
  const adjacentRelevance = Math.max(
    relevanceByIndex.get(input.fact.index - 1) ?? 0,
    relevanceByIndex.get(input.fact.index + 1) ?? 0,
  );
  const concreteCueCount = toConcreteAnswerCueCount(input.fact.fact, input.query);
  const factDirectRelevance = toBridgeFactDirectRelevance(input.query, input.fact.fact);
  const answerBearingBoost =
    concreteCueCount > 0 && (factDirectRelevance > 0 || adjacentRelevance > 0)
      ? 120 + adjacentRelevance
      : 0;
  const supportedRelevance = factDirectRelevance + adjacentRelevance;
  const unsupportedConcreteCuePenalty = concreteCueCount > 0 && supportedRelevance === 0 ? -60 : 0;

  return {
    score: directRelevance + answerBearingBoost + unsupportedConcreteCuePenalty,
    directRelevance,
    adjacentRelevance,
    concreteCueCount,
  };
};

const toBridgeSummaryEvidenceScore = (input: {
  readonly query: string;
  readonly text: string;
}): {
  readonly score: number;
  readonly directRelevance: number;
  readonly concreteCueCount: number;
} => {
  const facts = extractBridgeFacts(input.text);
  const ranked = facts
    .map((fact) => toBridgeFactEvidenceScore({ query: input.query, facts, fact }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.concreteCueCount !== left.concreteCueCount) {
        return right.concreteCueCount - left.concreteCueCount;
      }
      return right.directRelevance - left.directRelevance;
    });
  const top = ranked[0];

  return top === undefined
    ? { score: 0, directRelevance: 0, concreteCueCount: 0 }
    : { score: top.score, directRelevance: top.directRelevance, concreteCueCount: top.concreteCueCount };
};

const shouldMaterializeBridgeFromRetrievalText = (input: {
  readonly query: string;
  readonly content: string;
  readonly retrievalText: string;
}): boolean => {
  if (input.retrievalText === input.content) {
    return false;
  }

  const contentEvidence = toBridgeSummaryEvidenceScore({
    query: input.query,
    text: input.content,
  });
  const retrievalEvidence = toBridgeSummaryEvidenceScore({
    query: input.query,
    text: input.retrievalText,
  });

  return (
    retrievalEvidence.score >= MIN_ANSWER_BEARING_BRIDGE_EVIDENCE_SCORE &&
    retrievalEvidence.concreteCueCount > 0 &&
    retrievalEvidence.score > contentEvidence.score
  );
};

const toBridgeFactVariants = (fact: BridgeFact, tokenizer: TokenizerPort): readonly BridgeFactVariant[] => {
  const seen = new Set<string>();
  const variants: BridgeFactVariant[] = [];

  const push = (text: string): void => {
    if (seen.has(text)) {
      return;
    }

    seen.add(text);
    variants.push({
      text,
      tokenCount: tokenizer.countTokens(text).value,
    });
  };

  push(toBridgeFactLine(fact, { includePrefix: true, includeDate: true, includeAnchors: true, minimal: false }));
  push(toBridgeFactLine(fact, { includePrefix: true, includeDate: false, includeAnchors: true, minimal: false }));
  push(toBridgeFactLine(fact, { includePrefix: true, includeDate: false, includeAnchors: false, minimal: false }));
  push(toBridgeFactLine(fact, { includePrefix: false, includeDate: false, includeAnchors: false, minimal: true }));

  return variants;
};

const composeCompressedBridgeContent = (
  baseLine: string | undefined,
  variants: readonly { readonly fact: BridgeFact; readonly variant: BridgeFactVariant }[],
): string =>
  [
    baseLine,
    ...[...variants]
      .sort((left, right) => left.fact.index - right.fact.index)
      .map((entry) => entry.variant.text),
  ]
    .filter((line): line is string => line !== undefined && line.trim().length > 0)
    .join('\n');

const compressBridgeSummaryContent = (input: {
  readonly candidate: RankedSummaryRetrievalCandidate;
  readonly query: string;
  readonly maxTokens: number;
  readonly tokenizer: TokenizerPort;
  readonly forceEvidenceSlice?: boolean;
}): {
  readonly content: string;
  readonly tokenCount: number;
  readonly evidenceScore: number;
  readonly evidenceDirectRelevance: number;
  readonly concreteCueCount: number;
} | undefined => {
  if (input.maxTokens <= 0) {
    return undefined;
  }

  if (input.forceEvidenceSlice !== true && input.candidate.tokenCount <= input.maxTokens) {
    const evidence = toBridgeSummaryEvidenceScore({
      query: input.query,
      text: input.candidate.summary.retrievalText ?? input.candidate.summary.content,
    });

    return {
      content: input.candidate.summary.content,
      tokenCount: input.candidate.tokenCount,
      evidenceScore: evidence.score,
      evidenceDirectRelevance: evidence.directRelevance,
      concreteCueCount: evidence.concreteCueCount,
    };
  }

  const prefix = input.candidate.summary.content.startsWith('[Aggressive Summary]')
    ? '[Aggressive Summary]'
    : '[Summary]';
  const synopsis = input.candidate.summary.content
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        line !== '[Summary]' &&
        line !== '[Aggressive Summary]' &&
        !line.startsWith('summary_call:') &&
        !line.includes('ID:'),
    );
  const baseLine = synopsis === undefined ? prefix : `${prefix} ${synopsis.replace(/^\[(?:Aggressive )?Summary\]\s*/u, '')}`.trim();
  const facts = extractBridgeFacts(input.candidate.summary.retrievalText ?? input.candidate.summary.content);
  const factsByIndex = new Map(facts.map((fact) => [fact.index, fact] as const));
  const factRelevance = new Map(
    facts.map((fact) => {
      return [
        fact.index,
        toBridgeFactDirectRelevance(input.query, toBridgeFactEvidenceRelevanceText(fact)),
      ] as const;
    }),
  );
  const rankedFacts = facts
    .map((fact) => {
      const fullLine = toBridgeFactLine(fact, {
        includePrefix: true,
        includeDate: true,
        includeAnchors: true,
        minimal: false,
      });
      const directRelevance = factRelevance.get(fact.index) ?? 0;
      const adjacentRelevance = Math.max(
        factRelevance.get(fact.index - 1) ?? 0,
        factRelevance.get(fact.index + 1) ?? 0,
      );
      const concreteCueCount = toConcreteAnswerCueCount(fact.fact, input.query);
      const factDirectRelevance = toBridgeFactDirectRelevance(input.query, fact.fact);
      const answerBearingBoost =
        concreteCueCount > 0 && (factDirectRelevance > 0 || adjacentRelevance > 0)
          ? 120 + adjacentRelevance
          : 0;
      const supportedRelevance = factDirectRelevance + adjacentRelevance;
      const unsupportedConcreteCuePenalty = concreteCueCount > 0 && supportedRelevance === 0 ? -60 : 0;

      return {
        fact,
        directRelevance,
        adjacentRelevance,
        concreteCueCount,
        score: directRelevance + answerBearingBoost + unsupportedConcreteCuePenalty,
        variants: toBridgeFactVariants(fact, input.tokenizer),
        fullLine,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.concreteCueCount !== left.concreteCueCount) {
        return right.concreteCueCount - left.concreteCueCount;
      }
      if (right.directRelevance !== left.directRelevance) {
        return right.directRelevance - left.directRelevance;
      }
      return left.fact.index - right.fact.index;
    });

  if (rankedFacts.length === 0 && input.tokenizer.countTokens(baseLine).value > input.maxTokens) {
    const truncatedBase = truncateTextToTokenBudget(baseLine, input.maxTokens, input.tokenizer);
    if (truncatedBase.length > 0) {
      const tokenCount = input.tokenizer.countTokens(truncatedBase).value;
      return tokenCount > input.maxTokens
        ? undefined
        : { content: truncatedBase, tokenCount, evidenceScore: 0, evidenceDirectRelevance: 0, concreteCueCount: 0 };
    }
  }

  if (rankedFacts.length === 0) {
    const tokenCount = input.tokenizer.countTokens(baseLine).value;
    return tokenCount > input.maxTokens
      ? undefined
      : { content: baseLine, tokenCount, evidenceScore: 0, evidenceDirectRelevance: 0, concreteCueCount: 0 };
  }

  const bestFact = rankedFacts[0];
  if (bestFact === undefined) {
    return undefined;
  }

  const bestVariantCandidates = bestFact.variants;
  let selected: Array<{ readonly fact: BridgeFact; readonly variant: BridgeFactVariant }> = [];
  let includeHeader = false;
  let foundBestFactVariant = false;

  for (const variant of bestVariantCandidates) {
    const withHeader = composeCompressedBridgeContent(baseLine, [{ fact: bestFact.fact, variant }]);
    if (input.tokenizer.countTokens(withHeader).value <= input.maxTokens) {
      selected = [{ fact: bestFact.fact, variant }];
      includeHeader = true;
      foundBestFactVariant = true;
      break;
    }

    if (variant.tokenCount <= input.maxTokens) {
      selected = [{ fact: bestFact.fact, variant }];
      includeHeader = false;
      foundBestFactVariant = true;
      break;
    }
  }

  if (!foundBestFactVariant) {
    return undefined;
  }

  const supportFactIndexes = [
    bestFact.fact.index - 1,
    bestFact.fact.index + 1,
    ...rankedFacts.map((entry) => entry.fact.index),
  ];
  const seenSupportIndexes = new Set(selected.map((entry) => entry.fact.index));

  for (const factIndex of supportFactIndexes) {
    if (seenSupportIndexes.has(factIndex)) {
      continue;
    }

    const fact = factsByIndex.get(factIndex);
    if (fact === undefined) {
      continue;
    }

    for (const variant of toBridgeFactVariants(fact, input.tokenizer)) {
      const nextSelected = [...selected, { fact, variant }];
      const content = composeCompressedBridgeContent(includeHeader ? baseLine : undefined, nextSelected);
      if (input.tokenizer.countTokens(content).value <= input.maxTokens) {
        selected = nextSelected;
        seenSupportIndexes.add(factIndex);
        break;
      }
    }
  }

  const content = composeCompressedBridgeContent(includeHeader ? baseLine : undefined, selected);
  const tokenCount = input.tokenizer.countTokens(content).value;
  return tokenCount > input.maxTokens
    ? undefined
    : {
        content,
        tokenCount,
        evidenceScore: bestFact.score,
        evidenceDirectRelevance: bestFact.directRelevance,
        concreteCueCount: bestFact.concreteCueCount,
      };
};

const getEventBundleTokenCount = (events: readonly LedgerEvent[]): number =>
  events.reduce((total, event) => total + event.tokenCount.value, 0);

type RawBundleAccumulator = {
  hintIndex: number;
  limit: number;
  selectionOrder: number;
  score: number;
  overlapCount: number;
  specificityScore: number;
  seedId: LedgerEvent['id'];
  source: 'generic' | 'bridge_scoped';
  anchorCoverageCount: number;
  windowStartSequence: number;
  windowEndSequence: number;
  eventsById: Map<string, LedgerEvent>;
};

const sortEventsBySequence = (events: readonly LedgerEvent[]): readonly LedgerEvent[] =>
  [...events].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    return String(left.id).localeCompare(String(right.id));
  });

const toRawBundleAccumulator = (
  contender: Extract<RetrievalContender, { kind: 'raw_bundle' }>,
): RawBundleAccumulator => ({
  hintIndex: contender.hintIndex,
  limit: contender.limit,
  selectionOrder: contender.selectionOrder,
  score: contender.score,
  overlapCount: contender.overlapCount,
  specificityScore: contender.specificityScore,
  seedId: contender.seedId,
  source: contender.source,
  anchorCoverageCount: contender.anchorCoverageCount,
  windowStartSequence: contender.windowStartSequence,
  windowEndSequence: contender.windowEndSequence,
  eventsById: new Map(contender.events.map((event) => [String(event.id), event] as const)),
});

const finalizeRawBundleAccumulator = (
  accumulator: RawBundleAccumulator,
): Extract<RetrievalContender, { kind: 'raw_bundle' }> => {
  const events = sortEventsBySequence([...accumulator.eventsById.values()]);

  return {
    kind: 'raw_bundle',
    hintIndex: accumulator.hintIndex,
    limit: accumulator.limit,
    selectionOrder: accumulator.selectionOrder,
    score: accumulator.score,
    overlapCount: accumulator.overlapCount,
    specificityScore: accumulator.specificityScore,
    tokenCount: getEventBundleTokenCount(events),
    seedId: accumulator.seedId,
    source: accumulator.source,
    anchorCoverageCount: accumulator.anchorCoverageCount,
    windowStartSequence: accumulator.windowStartSequence,
    windowEndSequence: accumulator.windowEndSequence,
    events,
  };
};

const coalesceRawRetrievalContenders = (contenders: readonly RetrievalContender[]): readonly RetrievalContender[] => {
  const bridgeContenders = contenders.filter(
    (contender): contender is Extract<RetrievalContender, { kind: 'bridge_summary' }> =>
      contender.kind === 'bridge_summary',
  );
  const rawContendersByHint = new Map<number, Array<Extract<RetrievalContender, { kind: 'raw_bundle' }>>>();

  for (const contender of contenders) {
    if (contender.kind !== 'raw_bundle') {
      continue;
    }

    const existing = rawContendersByHint.get(contender.hintIndex);
    if (existing === undefined) {
      rawContendersByHint.set(contender.hintIndex, [contender]);
      continue;
    }

    existing.push(contender);
  }

  const mergedRawContenders = [...rawContendersByHint.values()].flatMap((rawContenders) => {
    const sorted = [...rawContenders].sort((left, right) => {
      if (left.windowStartSequence !== right.windowStartSequence) {
        return left.windowStartSequence - right.windowStartSequence;
      }
      if (left.windowEndSequence !== right.windowEndSequence) {
        return left.windowEndSequence - right.windowEndSequence;
      }

      return left.selectionOrder - right.selectionOrder;
    });

    const accumulators: RawBundleAccumulator[] = [];
    let current: RawBundleAccumulator | undefined;

    for (const contender of sorted) {
      const next = toRawBundleAccumulator(contender);
      if (current === undefined) {
        current = next;
        continue;
      }

      if (next.windowStartSequence <= current.windowEndSequence + 1) {
        current.windowStartSequence = Math.min(current.windowStartSequence, next.windowStartSequence);
        current.windowEndSequence = Math.max(current.windowEndSequence, next.windowEndSequence);
        current.score = Math.max(current.score, next.score);
        current.overlapCount = Math.max(current.overlapCount, next.overlapCount);
        current.specificityScore = Math.max(current.specificityScore, next.specificityScore);
        current.anchorCoverageCount = Math.max(current.anchorCoverageCount, next.anchorCoverageCount);
        if (current.source !== 'bridge_scoped' && next.source === 'bridge_scoped') {
          current.source = next.source;
        }
        if (next.selectionOrder < current.selectionOrder) {
          current.selectionOrder = next.selectionOrder;
          current.seedId = next.seedId;
        }

        for (const [eventId, event] of next.eventsById) {
          current.eventsById.set(eventId, event);
        }
        continue;
      }

      accumulators.push(current);
      current = next;
    }

    if (current !== undefined) {
      accumulators.push(current);
    }

    return accumulators.map((accumulator) => finalizeRawBundleAccumulator(accumulator));
  });

  return [...bridgeContenders, ...mergedRawContenders].sort(
    (left, right) => left.selectionOrder - right.selectionOrder,
  );
};

const toSummaryAnchorCount = (content: string): number => content.match(/(?:^|\|)\s*(?:\[summary_fact\]\s*)?ID:/gm)?.length ?? 0;

const toSummaryBridgeScore = (input: {
  readonly stageHits: number;
  readonly overlapCount: number;
  readonly specificityScore: number;
  readonly anchorCount: number;
}): number =>
  input.stageHits * 100 +
  input.overlapCount * 10 +
  input.specificityScore * 5 +
  Math.min(input.anchorCount, 8) * 5;

const compareRankedSummaryCandidates = (
  left: RankedSummaryRetrievalCandidate,
  right: RankedSummaryRetrievalCandidate,
): number => {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if (left.rankTieBreaker !== right.rankTieBreaker) {
    return left.rankTieBreaker - right.rankTieBreaker;
  }

  return String(left.id).localeCompare(String(right.id));
};

const compareFitAwareSummaryCandidates = (
  left: RankedSummaryRetrievalCandidate,
  right: RankedSummaryRetrievalCandidate,
): number => {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if (left.tokenCount !== right.tokenCount) {
    return left.tokenCount - right.tokenCount;
  }

  if (left.rankTieBreaker !== right.rankTieBreaker) {
    return left.rankTieBreaker - right.rankTieBreaker;
  }

  return String(left.id).localeCompare(String(right.id));
};

const MAX_BRIDGE_BASE_SLACK_TOKENS = 128;
const MAX_BRIDGE_BASE_SLACK_UNITS = 2;

type BridgeBaseSlackCandidate = {
  readonly kind: ResolvedContextItem['kind'];
  readonly tokenCount: number;
  readonly recencyScore: number;
};

const compareBridgeBaseSlackCandidates = (
  left: BridgeBaseSlackCandidate,
  right: BridgeBaseSlackCandidate,
): number => {
  if (left.kind !== right.kind) {
    return left.kind === 'message' ? -1 : 1;
  }

  if (right.recencyScore !== left.recencyScore) {
    return right.recencyScore - left.recencyScore;
  }

  if (right.tokenCount !== left.tokenCount) {
    return right.tokenCount - left.tokenCount;
  }

  return 0;
};

const compareBridgeBaseReclaimCandidates = (
  left: BridgeBaseSlackCandidate,
  right: BridgeBaseSlackCandidate,
): number => {
  if (left.kind !== right.kind) {
    return left.kind === 'summary' ? -1 : 1;
  }

  if (left.recencyScore !== right.recencyScore) {
    return left.recencyScore - right.recencyScore;
  }

  if (left.tokenCount !== right.tokenCount) {
    return left.tokenCount - right.tokenCount;
  }

  return 0;
};

const getDroppableBridgeBaseCandidates = (input: {
  readonly selectedBaseItems: readonly ResolvedContextItem[];
  readonly pinRules: readonly PinRule[];
}): readonly BridgeBaseSlackCandidate[] =>
  input.selectedBaseItems
    .filter((item) => !isItemPinned(item.contextItem, input.pinRules))
    .map((item) => ({
      kind: item.kind,
      tokenCount: item.tokenCount,
      recencyScore: item.recencyScore,
    }))
    .sort(compareBridgeBaseReclaimCandidates);

const getBridgeSelectionBudget = (input: {
  readonly retrievalReserve: number;
  readonly selectedBaseItems: readonly ResolvedContextItem[];
  readonly pinRules: readonly PinRule[];
}): {
  readonly bridgeSelectionBudget: number;
} => {
  let extraSlack = 0;
  let usedUnits = 0;
  const candidates = input.selectedBaseItems
    .filter((item) => !isItemPinned(item.contextItem, input.pinRules))
    .map((item) => ({
      kind: item.kind,
      tokenCount: item.tokenCount,
      recencyScore: item.recencyScore,
    }))
    .sort(compareBridgeBaseSlackCandidates);

  for (const candidate of candidates) {
    if (usedUnits >= MAX_BRIDGE_BASE_SLACK_UNITS) {
      break;
    }

    if (extraSlack + candidate.tokenCount > MAX_BRIDGE_BASE_SLACK_TOKENS) {
      continue;
    }

    extraSlack += candidate.tokenCount;
    usedUnits += 1;
  }

  return {
    bridgeSelectionBudget: input.retrievalReserve + extraSlack,
  };
};

const canBridgeSummaryCoexistWithPinnedBase = (input: {
  readonly candidateTokenCount: number;
  readonly pinnedBaseTokenCount: number;
  readonly availableBudget: number;
}): boolean => input.candidateTokenCount + input.pinnedBaseTokenCount <= input.availableBudget;

const getBridgeFitBudgets = (input: {
  readonly selectedBaseItems: readonly ResolvedContextItem[];
  readonly pinRules: readonly PinRule[];
  readonly availableBudget: number;
}): readonly number[] => {
  let retainedBaseTokenCount = input.selectedBaseItems.reduce((total, item) => total + item.tokenCount, 0);
  const budgets: number[] = [];
  const seen = new Set<number>();

  const pushBudget = (tokenBudget: number): void => {
    if (tokenBudget <= 0 || seen.has(tokenBudget)) {
      return;
    }

    seen.add(tokenBudget);
    budgets.push(tokenBudget);
  };

  pushBudget(input.availableBudget - retainedBaseTokenCount);

  for (const candidate of getDroppableBridgeBaseCandidates({
    selectedBaseItems: input.selectedBaseItems,
    pinRules: input.pinRules,
  })) {
    retainedBaseTokenCount -= candidate.tokenCount;
    pushBudget(input.availableBudget - retainedBaseTokenCount);
  }

  return budgets;
};

const materializeBridgeSummarySelection = (input: {
  readonly candidate: RankedSummaryRetrievalCandidate;
  readonly selectedBaseItems: readonly ResolvedContextItem[];
  readonly pinRules: readonly PinRule[];
  readonly availableBudget: number;
  readonly preferredFitBudget: number;
  readonly query: string;
  readonly tokenizer: TokenizerPort;
}): MaterializedBridgeSummarySelection | undefined => {
  const fitBudgets = getBridgeFitBudgets({
    selectedBaseItems: input.selectedBaseItems,
    pinRules: input.pinRules,
    availableBudget: input.availableBudget,
  });
  const maxFitBudget = fitBudgets[fitBudgets.length - 1];

  if (maxFitBudget === undefined) {
    return undefined;
  }

  const retrievalText = input.candidate.summary.retrievalText ?? input.candidate.summary.content;
  const shouldUseRetrievalEvidence = shouldMaterializeBridgeFromRetrievalText({
    query: input.query,
    content: input.candidate.summary.content,
    retrievalText,
  });

  if (shouldUseRetrievalEvidence) {
    const compressed = compressBridgeSummaryContent({
      candidate: input.candidate,
      query: input.query,
      maxTokens: Math.min(maxFitBudget, Math.max(input.preferredFitBudget, 1)),
      tokenizer: input.tokenizer,
      forceEvidenceSlice: true,
    });

    if (compressed !== undefined) {
      return {
        candidate: input.candidate,
        tokenCount: compressed.tokenCount,
        content: compressed.content,
        evidenceScore: compressed.evidenceScore,
        evidenceDirectRelevance: compressed.evidenceDirectRelevance,
        concreteCueCount: compressed.concreteCueCount,
      };
    }
  }

  if (input.candidate.tokenCount <= Math.min(maxFitBudget, input.preferredFitBudget)) {
    const evidence = toBridgeSummaryEvidenceScore({
      query: input.query,
      text: retrievalText,
    });

    return {
      candidate: input.candidate,
      tokenCount: input.candidate.tokenCount,
      content: input.candidate.summary.content,
      evidenceScore: evidence.score,
      evidenceDirectRelevance: evidence.directRelevance,
      concreteCueCount: evidence.concreteCueCount,
    };
  }

  const compressionFitBudgets = [
    Math.min(maxFitBudget, input.preferredFitBudget),
    ...[...fitBudgets].sort((left, right) => right - left),
  ];
  const seenFitBudgets = new Set<number>();

  for (const fitBudget of compressionFitBudgets
    .filter(
      (budget) =>
        budget > 0 &&
        budget < input.candidate.tokenCount &&
        !seenFitBudgets.has(budget) &&
        seenFitBudgets.add(budget),
    )) {
    const compressed = compressBridgeSummaryContent({
      candidate: input.candidate,
      query: input.query,
      maxTokens: fitBudget,
      tokenizer: input.tokenizer,
    });

    if (compressed !== undefined) {
      return {
        candidate: input.candidate,
        tokenCount: compressed.tokenCount,
        content: compressed.content,
        evidenceScore: compressed.evidenceScore,
        evidenceDirectRelevance: compressed.evidenceDirectRelevance,
        concreteCueCount: compressed.concreteCueCount,
      };
    }
  }

  if (input.candidate.tokenCount <= maxFitBudget) {
    const evidence = toBridgeSummaryEvidenceScore({
      query: input.query,
      text: retrievalText,
    });

    return {
      candidate: input.candidate,
      tokenCount: input.candidate.tokenCount,
      content: input.candidate.summary.content,
      evidenceScore: evidence.score,
      evidenceDirectRelevance: evidence.directRelevance,
      concreteCueCount: evidence.concreteCueCount,
    };
  }

  return undefined;
};

const chooseBridgeSummaryCandidate = (input: {
  readonly rankedSummaryCandidates: readonly RankedSummaryRetrievalCandidate[];
  readonly selectedSummaryIdStrings: ReadonlySet<string>;
  readonly availableBudget: number;
  readonly bridgeSelectionBudget: number;
  readonly pinnedBaseTokenCount: number;
  readonly selectedBaseItems: readonly ResolvedContextItem[];
  readonly pinRules: readonly PinRule[];
  readonly query: string;
  readonly tokenizer: TokenizerPort;
}): MaterializedBridgeSummarySelection | undefined => {
  const viableCandidates = input.rankedSummaryCandidates.filter(
    (candidate) =>
      !input.selectedSummaryIdStrings.has(String(candidate.id)) &&
      (canBridgeSummaryCoexistWithPinnedBase({
        candidateTokenCount: candidate.tokenCount,
        pinnedBaseTokenCount: input.pinnedBaseTokenCount,
        availableBudget: input.availableBudget,
      }) ||
        input.pinnedBaseTokenCount === 0 ||
        extractBridgeFacts(candidate.summary.retrievalText ?? candidate.summary.content).length > 0),
  );

  const topCandidate = viableCandidates[0];
  if (topCandidate === undefined) {
    return undefined;
  }

  const preferredCandidate =
    topCandidate.tokenCount <= input.bridgeSelectionBudget
      ? topCandidate
      : viableCandidates
          .filter(
            (candidate) =>
              candidate.tokenCount <= input.bridgeSelectionBudget && candidate.score >= topCandidate.score - 10,
          )
          .sort(compareFitAwareSummaryCandidates)[0];

  const triedCandidateIds = new Set<string>();
  const materializeCandidate = (candidate: RankedSummaryRetrievalCandidate): MaterializedBridgeSummarySelection | undefined => {
    triedCandidateIds.add(String(candidate.id));
    return materializeBridgeSummarySelection({
      candidate,
      selectedBaseItems: input.selectedBaseItems,
      pinRules: input.pinRules,
      availableBudget: input.availableBudget,
      preferredFitBudget: input.bridgeSelectionBudget,
      query: input.query,
      tokenizer: input.tokenizer,
    });
  };

  const primaryCandidate = preferredCandidate ?? topCandidate;
  const primaryMaterialized = materializeCandidate(primaryCandidate);
  const primaryIsAnswerBearing =
    primaryMaterialized !== undefined &&
    primaryMaterialized.evidenceScore >= MIN_ANSWER_BEARING_BRIDGE_EVIDENCE_SCORE &&
    primaryMaterialized.evidenceDirectRelevance > 0 &&
    primaryMaterialized.concreteCueCount > 0;

  if (primaryIsAnswerBearing) {
    return primaryMaterialized;
  }

  const answerBearingFallback = viableCandidates
    .filter((candidate) => candidate.score >= topCandidate.score - 30)
    .filter((candidate) => !triedCandidateIds.has(String(candidate.id)))
    .map((candidate) => materializeCandidate(candidate))
    .filter(
      (option): option is MaterializedBridgeSummarySelection =>
        option !== undefined &&
        option.evidenceScore >= MIN_ANSWER_BEARING_BRIDGE_EVIDENCE_SCORE &&
        option.concreteCueCount > 0,
    )
    .sort((left, right) => {
      if (right.evidenceScore !== left.evidenceScore) {
        return right.evidenceScore - left.evidenceScore;
      }
      if (right.concreteCueCount !== left.concreteCueCount) {
        return right.concreteCueCount - left.concreteCueCount;
      }
      if (right.candidate.score !== left.candidate.score) {
        return right.candidate.score - left.candidate.score;
      }
      if (left.tokenCount !== right.tokenCount) {
        return left.tokenCount - right.tokenCount;
      }
      return compareRankedSummaryCandidates(left.candidate, right.candidate);
    })[0];

  if (answerBearingFallback !== undefined) {
    return answerBearingFallback;
  }

  if (primaryMaterialized !== undefined) {
    return primaryMaterialized;
  }

  for (const candidate of viableCandidates) {
    if (triedCandidateIds.has(String(candidate.id))) {
      continue;
    }

    const materialized = materializeCandidate(candidate);

    if (materialized !== undefined) {
      return materialized;
    }
  }

  return undefined;
};

const buildBridgeScopedRawContender = (input: {
  readonly hintIndex: number;
  readonly limit: number;
  readonly query: string;
  readonly stageQueries: readonly { readonly stage: RetrievalStageLabel; readonly query: string }[];
  readonly selectionOrder: number;
  readonly bridgeCandidate: RankedSummaryRetrievalCandidate;
  readonly scopedEventsBySequence: ReadonlyMap<number, LedgerEvent>;
  readonly selectedRawEventIds: ReadonlySet<string>;
  readonly availableBudget: number;
}): Extract<RetrievalContender, { kind: 'raw_bundle' }> | undefined => {
  const scopedCandidates = [...input.scopedEventsBySequence.values()]
    .filter((event) => !input.selectedRawEventIds.has(String(event.id)))
    .map((event) => {
      let stageHits = 0;
      let overlapCount = 0;
      let specificityScore = 0;

      for (const stageQuery of input.stageQueries) {
        const stageOverlap = toQueryOverlapCount(stageQuery.query, event.content);
        const stageSpecificity = toQuerySpecificityOverlapCount(stageQuery.query, event.content);
        if (stageOverlap > 0 || stageSpecificity > 0) {
          stageHits += 1;
        }
        if (stageOverlap > overlapCount) {
          overlapCount = stageOverlap;
        }
        if (stageSpecificity > specificityScore) {
          specificityScore = stageSpecificity;
        }
      }

      const anchorCoverageCount = countAnchorCoverage(input.query, event.content);
      const score =
        specificityScore * 180 +
        stageHits * 10 +
        overlapCount +
        anchorCoverageCount * 5;

      return {
        event,
        stageHits,
        overlapCount,
        specificityScore,
        anchorCoverageCount,
        score,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.specificityScore !== left.specificityScore) {
        return right.specificityScore - left.specificityScore;
      }
      return left.event.sequence - right.event.sequence;
    });

  const topCandidate = scopedCandidates[0];
  if (topCandidate === undefined) {
    return undefined;
  }

  const bundle = buildRetrievedEventWindow({
    seed: topCandidate.event,
    eventsBySequence: input.scopedEventsBySequence,
  }).filter((event) => !input.selectedRawEventIds.has(String(event.id)));
  const bundleTokenCount = getEventBundleTokenCount(bundle);

  if (bundle.length === 0 || bundleTokenCount > input.availableBudget) {
    return undefined;
  }

  return {
    kind: 'raw_bundle',
    hintIndex: input.hintIndex,
    limit: input.limit,
    selectionOrder: input.selectionOrder,
    score: Math.max(topCandidate.score, input.bridgeCandidate.score),
    overlapCount: Math.max(topCandidate.overlapCount, input.bridgeCandidate.overlapCount),
    specificityScore: Math.max(topCandidate.specificityScore, input.bridgeCandidate.specificityScore),
    tokenCount: bundleTokenCount,
    seedId: topCandidate.event.id,
    source: 'bridge_scoped',
    anchorCoverageCount: Math.max(topCandidate.anchorCoverageCount, input.bridgeCandidate.anchorCount),
    windowStartSequence: topCandidate.event.sequence - 1,
    windowEndSequence: topCandidate.event.sequence + 1,
    events: bundle,
  };
};

const compareScoreDensity = (
  leftScore: number,
  leftTokens: number,
  rightScore: number,
  rightTokens: number,
): number => {
  const left = leftScore * rightTokens;
  const right = rightScore * leftTokens;

  if (left !== right) {
    return right - left;
  }

  return 0;
};

const compareRetrievalUnits = (
  left: Extract<PackableUnit, { kind: 'retrieval_bridge_summary' | 'retrieval_raw_bundle' }>,
  right: Extract<PackableUnit, { kind: 'retrieval_bridge_summary' | 'retrieval_raw_bundle' }>,
): number => {
  if (left.kind === 'retrieval_raw_bundle' && right.kind === 'retrieval_raw_bundle') {
    if (
      left.source === 'bridge_scoped' &&
      right.source !== 'bridge_scoped' &&
      (left.specificityScore > right.specificityScore ||
        (left.specificityScore === right.specificityScore && left.anchorCoverageCount > right.anchorCoverageCount))
    ) {
      return -1;
    }

    if (
      right.source === 'bridge_scoped' &&
      left.source !== 'bridge_scoped' &&
      (right.specificityScore > left.specificityScore ||
        (right.specificityScore === left.specificityScore && right.anchorCoverageCount > left.anchorCoverageCount))
    ) {
      return 1;
    }
  }

  const density = compareScoreDensity(left.score, left.tokenCount, right.score, right.tokenCount);
  if (density !== 0) {
    return density;
  }

  if (left.kind !== right.kind) {
    return left.kind === 'retrieval_bridge_summary' ? -1 : 1;
  }

  return left.selectionOrder - right.selectionOrder;
};

const compareWeakestRawRetrievalUnits = (left: RetrievalRawBundleUnit, right: RetrievalRawBundleUnit): number => {
  if (left.specificityScore !== right.specificityScore) {
    return left.specificityScore - right.specificityScore;
  }
  if (left.anchorCoverageCount !== right.anchorCoverageCount) {
    return left.anchorCoverageCount - right.anchorCoverageCount;
  }
  if (left.overlapCount !== right.overlapCount) {
    return left.overlapCount - right.overlapCount;
  }

  const density = compareScoreDensity(left.score, left.tokenCount, right.score, right.tokenCount);
  if (density !== 0) {
    return -density;
  }

  return right.selectionOrder - left.selectionOrder;
};

const isBridgeLexicallyStrongerThanRaw = (
  bridge: RetrievalBridgeSummaryUnit,
  raw: RetrievalRawBundleUnit,
): boolean =>
  bridge.specificityScore > raw.specificityScore ||
  (bridge.specificityScore === raw.specificityScore && bridge.overlapCount >= raw.overlapCount);

const canBridgeReplaceRawRegion = (bridge: RetrievalBridgeSummaryUnit, raw: RetrievalRawBundleUnit): boolean =>
  raw.messageIds.length > 1 && isBridgeLexicallyStrongerThanRaw(bridge, raw);

const canCompressedBridgeReplaceRawRegion = (
  bridge: RetrievalBridgeSummaryUnit,
  raw: RetrievalRawBundleUnit,
): boolean =>
  canBridgeReplaceRawRegion(bridge, raw) ||
  (raw.messageIds.length > 1 &&
    bridge.evidenceScore >= MIN_ANSWER_BEARING_BRIDGE_EVIDENCE_SCORE &&
    bridge.concreteCueCount > 0 &&
    raw.overlapCount <= bridge.overlapCount &&
    raw.specificityScore <= bridge.specificityScore + 1);

const compressBridgeUnitInPlace = (input: {
  readonly bridgeUnit: RetrievalBridgeSummaryUnit;
  readonly maxTokens: number;
  readonly tokenizer: TokenizerPort;
}): boolean => {
  const compressed = compressBridgeSummaryContent({
    candidate: input.bridgeUnit.candidate,
    query: input.bridgeUnit.query,
    maxTokens: input.maxTokens,
    tokenizer: input.tokenizer,
  });

  if (compressed === undefined || compressed.tokenCount > input.maxTokens) {
    return false;
  }

  const summaryReference = input.bridgeUnit.summaryReferences[0];
  if (summaryReference === undefined) {
    return false;
  }

  Object.assign(input.bridgeUnit, {
    tokenCount: compressed.tokenCount,
    modelMessages: [
      buildSummaryModelMessage(summaryReference.id, compressed.content),
    ],
  });

  return true;
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
    const eventsBySequence = new Map(allEvents.map((event) => [event.sequence, event] as const));

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
    const { bridgeSelectionBudget } = getBridgeSelectionBudget({
      retrievalReserve,
      selectedBaseItems: trimmedBase.selectedItems,
      pinRules,
    });
    const pinnedBaseItems = trimmedBase.selectedItems.filter((item) => isItemPinned(item.contextItem, pinRules));
    const pinnedBaseTokenCount = pinnedBaseItems.reduce((total, item) => total + item.tokenCount, 0);

    let budgetUsedValue = trimmedBase.budgetUsed;
    let trimmedToFit = trimmedBase.trimmedToFit;
    let droppedMessageCount = trimmedBase.droppedMessageCount;
    let droppedSummaryCount = trimmedBase.droppedSummaryCount;

    const modelMessages: ModelMessage[] = [];
    const summaryReferences: SummaryReference[] = [];
    const summaryArtifactIdsById = new Map<string, readonly ArtifactId[]>();
    const selectedSummaryIdStrings = new Set(
      trimmedBase.selectedItems
        .filter((item): item is Extract<ResolvedContextItem, { kind: 'summary' }> => item.kind === 'summary')
        .map((item) => {
          summaryArtifactIdsById.set(String(item.summaryReference.id), item.artifactIds);
          return String(item.summaryReference.id);
        }),
    );
    const pendingRetrievalContenders: RetrievalContender[] = [];
    let retrievalSelectionOrder = 0;

    let retrievalMatchCount = 0;
    const retrievalDiagnostics: RetrievalHintDiagnostics[] = [];
    const scopedEventsBySequenceCache = new Map<string, ReadonlyMap<number, LedgerEvent>>();
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
    const getWindowEventsBySequence = async (
      scope?: SummaryReference['id'],
    ): Promise<ReadonlyMap<number, LedgerEvent>> => {
      if (scope === undefined) {
        return eventsBySequence;
      }

      const cacheKey = String(scope);
      const cached = scopedEventsBySequenceCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const scopedEvents = await this.deps.summaryDag.expandToMessages(scope);
      const scopedMap = new Map(scopedEvents.map((event) => [event.sequence, event] as const));
      scopedEventsBySequenceCache.set(cacheKey, scopedMap);
      return scopedMap;
    };

    if (retrievalHints.length > 0) {
      for (const [hintIndex, hint] of retrievalHints.entries()) {
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
            readonly retrievalText: string;
            readonly artifactIds: readonly ArtifactId[];
            readonly createdAt: Date;
          };
          stageHits: number;
          overlapCount: number;
          specificityScore: number;
          anchorCount: number;
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
            const retrievalText = summary.retrievalText ?? summary.content;
            const overlapCount = toQueryOverlapCount(stageQuery.query, retrievalText);
            const specificityScore = toQuerySpecificityOverlapCount(stageQuery.query, retrievalText);
            const anchorCount = toSummaryAnchorCount(retrievalText);
            const existing = candidateMap.get(key);
            if (existing === undefined) {
              candidateMap.set(key, {
                summary,
                stageHits: 1,
                overlapCount,
                specificityScore,
                anchorCount,
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
          const score =
            entry.specificityScore * 180 +
            entry.stageHits * 10 +
            entry.overlapCount;
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
        const rankedSummaryCandidates = Array.from(candidateMap.values())
          .map((entry) => {
            const score = toSummaryBridgeScore({
              stageHits: entry.stageHits,
              overlapCount: entry.overlapCount,
              specificityScore: entry.specificityScore,
              anchorCount: entry.anchorCount,
            });
            return {
              kind: 'summary' as const,
              id: entry.summary.id,
              tokenCount: entry.summary.tokenCount.value,
              score,
              stageHits: entry.stageHits,
              overlapCount: entry.overlapCount,
              specificityScore: entry.specificityScore,
              anchorCount: entry.anchorCount,
              rankTieBreaker: -entry.summary.createdAt.getTime(),
              summary: entry.summary,
            };
          })
          .sort(compareRankedSummaryCandidates);
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
        const rawContenders: RetrievalContender[] = [];
        let bridgeSummaryContender: RetrievalContender | undefined;
        const selectedBridgeSummaryCandidate = chooseBridgeSummaryCandidate({
          rankedSummaryCandidates,
          selectedSummaryIdStrings,
          availableBudget,
          bridgeSelectionBudget,
          pinnedBaseTokenCount,
          selectedBaseItems: trimmedBase.selectedItems,
          pinRules,
          query: retrievalQuery,
          tokenizer: this.deps.tokenizer,
        });

        if (selectedBridgeSummaryCandidate !== undefined && rawContenders.length < limit) {
          const bridgeScopedEventsBySequence = await getWindowEventsBySequence(
            selectedBridgeSummaryCandidate.candidate.summary.id,
          );
          const bridgeScopedRawContender = buildBridgeScopedRawContender({
            hintIndex,
            limit,
            query: retrievalQuery,
            stageQueries,
            selectionOrder: retrievalSelectionOrder,
            bridgeCandidate: selectedBridgeSummaryCandidate.candidate,
            scopedEventsBySequence: bridgeScopedEventsBySequence,
            selectedRawEventIds,
            availableBudget,
          });

          if (bridgeScopedRawContender !== undefined) {
            retrievalSelectionOrder += 1;
            rawContenders.push(bridgeScopedRawContender);
            for (const event of bridgeScopedRawContender.events) {
              selectedRawEventIds.add(String(event.id));
            }
            selectedMessageIds.push(...bridgeScopedRawContender.events.map((event) => event.id));
          }
        }

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
            if (rawContenders.length >= limit) {
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
            const seedEvent = eventsById.get(candidate.id);
            if (seedEvent === undefined) {
              throw new InvariantViolationError(`Retrieval selected unknown event: ${candidate.id}`);
            }
            const windowEventsBySequence = await getWindowEventsBySequence(hint.scope);
            const scopedSeedEvent = windowEventsBySequence.get(seedEvent.sequence) ?? seedEvent;
            const bundle = buildRetrievedEventWindow({
              seed: scopedSeedEvent,
              eventsBySequence: windowEventsBySequence,
            }).filter((event) => !selectedRawEventIds.has(String(event.id)));
            const bundleTokenCount = getEventBundleTokenCount(bundle);

            if (bundle.length === 0) {
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
            if (bundleTokenCount > availableBudget) {
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
            if (rawContenders.length >= limit) {
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

            rawContenders.push({
              kind: 'raw_bundle',
              hintIndex,
              limit,
              selectionOrder: retrievalSelectionOrder++,
              score: candidate.score,
              overlapCount: candidate.overlapCount,
              specificityScore: candidate.specificityScore,
              tokenCount: bundleTokenCount,
              seedId: candidate.id,
              source: 'generic',
              anchorCoverageCount: countAnchorCoverage(retrievalQuery, bundle.map((event) => event.content).join('\n')),
              windowStartSequence: scopedSeedEvent.sequence - 1,
              windowEndSequence: scopedSeedEvent.sequence + 1,
              events: bundle,
            });
            for (const event of bundle) {
              selectedRawEventIds.add(String(event.id));
            }
            selectedMessageIds.push(...bundle.map((event) => event.id));
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
          const alreadyInContext = selectedSummaryIdStrings.has(String(summary.id));
          const isSelectedBridgeSummary = selectedBridgeSummaryCandidate?.candidate.id === summary.id;

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

          if (!isSelectedBridgeSummary) {
            const exceedsPinnedCoexistenceBudget = !canBridgeSummaryCoexistWithPinnedBase({
              candidateTokenCount: candidate.tokenCount,
              pinnedBaseTokenCount,
              availableBudget,
            });
            candidateDecisions.push({
              summaryId: summary.id,
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount: candidate.tokenCount,
              selected: false,
              reason:
                candidate.tokenCount > availableBudget || exceedsPinnedCoexistenceBudget
                  ? 'over_budget'
                  : 'limit_reached',
            });
            continue;
          }

          if (bridgeSummaryContender !== undefined) {
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

          const summaryReference = {
            id: summary.id,
            kind: summary.kind,
            tokenCount: summary.tokenCount,
          } satisfies SummaryReference;
          bridgeSummaryContender = {
            kind: 'bridge_summary',
            hintIndex,
            limit,
            selectionOrder: retrievalSelectionOrder++,
            score: candidate.score,
            overlapCount: candidate.overlapCount,
            specificityScore: candidate.specificityScore,
            evidenceScore: selectedBridgeSummaryCandidate.evidenceScore,
            concreteCueCount: selectedBridgeSummaryCandidate.concreteCueCount,
            tokenCount: selectedBridgeSummaryCandidate.tokenCount,
            candidate: selectedBridgeSummaryCandidate.candidate,
            query: retrievalQuery,
            summaryReference,
            artifactIds: summary.artifactIds,
            modelMessage: buildSummaryModelMessage(summary.id, selectedBridgeSummaryCandidate.content),
          };
          selectedSummaryIdStrings.add(String(summary.id));
          summaryArtifactIdsById.set(String(summary.id), summary.artifactIds);
          selectedSummaryIds.push(summaryReference.id);

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

        const contendersForHint =
          bridgeSummaryContender === undefined ? rawContenders : [bridgeSummaryContender, ...rawContenders];
        pendingRetrievalContenders.push(...contendersForHint);

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

    let order = 0;
    const baseUnits: BasePackableUnit[] = trimmedBase.selectedItems.map((item) => {
      const pinned = isItemPinned(item.contextItem, pinRules);

      return item.kind === 'summary'
        ? {
            kind: 'base_summary',
            tokenCount: item.tokenCount,
            order: order++,
            pinned,
            modelMessages: [item.modelMessage],
            summaryReferences: [item.summaryReference],
          }
        : {
            kind: 'base_message',
            tokenCount: item.tokenCount,
            order: order++,
            pinned,
            modelMessages: [item.modelMessage],
          };
    });
    const retrievalUnits: Array<Extract<PackableUnit, { kind: 'retrieval_bridge_summary' | 'retrieval_raw_bundle' }>> =
      [...coalesceRawRetrievalContenders(pendingRetrievalContenders)]
        .sort((left, right) => left.selectionOrder - right.selectionOrder)
        .map((contender) =>
          contender.kind === 'bridge_summary'
            ? {
                kind: 'retrieval_bridge_summary',
                hintIndex: contender.hintIndex,
                limit: contender.limit,
                score: contender.score,
                overlapCount: contender.overlapCount,
                specificityScore: contender.specificityScore,
                evidenceScore: contender.evidenceScore,
                concreteCueCount: contender.concreteCueCount,
                tokenCount: contender.tokenCount,
                order: order++,
                selectionOrder: contender.selectionOrder,
                candidate: contender.candidate,
                query: contender.query,
                modelMessages: [contender.modelMessage],
                summaryReferences: [contender.summaryReference],
                artifactIds: contender.artifactIds,
              }
            : {
                kind: 'retrieval_raw_bundle',
                hintIndex: contender.hintIndex,
                limit: contender.limit,
                score: contender.score,
                overlapCount: contender.overlapCount,
                specificityScore: contender.specificityScore,
                tokenCount: contender.tokenCount,
                order: order++,
                selectionOrder: contender.selectionOrder,
                seedId: contender.seedId,
                source: contender.source,
                anchorCoverageCount: contender.anchorCoverageCount,
                windowStartSequence: contender.windowStartSequence,
                windowEndSequence: contender.windowEndSequence,
                messageIds: contender.events.map((event) => event.id),
                modelMessages: contender.events.map((event) => ({
                  role: event.role,
                  content: event.content,
                })),
              },
        );

    const pinnedBaseUnits = [...baseUnits]
      .filter((unit) => unit.pinned)
      .sort((left, right) => left.order - right.order);

    const rankedUnits: PackableUnit[] = [
      ...[...retrievalUnits].sort(compareRetrievalUnits),
      ...[...baseUnits]
        .filter((unit): unit is Extract<PackableUnit, { kind: 'base_message' }> => unit.kind === 'base_message')
        .filter((unit) => !unit.pinned)
        .sort((left, right) => right.order - left.order),
      ...[...baseUnits]
        .filter((unit): unit is Extract<PackableUnit, { kind: 'base_summary' }> => unit.kind === 'base_summary')
        .filter((unit) => !unit.pinned)
        .sort((left, right) => right.order - left.order),
    ];

    const keptUnits: PackableUnit[] = [...pinnedBaseUnits];
    const keptHintCounts = new Map<number, number>();
    let used = pinnedBaseUnits.reduce((total, unit) => total + unit.tokenCount, 0);

    if (used > availableBudget) {
      throw new MaterializeContextBudgetExceededError(
        availableBudget,
        used,
        'Pinned context items exceed available budget during final packing.',
      );
    }

    for (const unit of rankedUnits) {
      if (unit.kind === 'retrieval_bridge_summary' || unit.kind === 'retrieval_raw_bundle') {
        const usedForHint = keptHintCounts.get(unit.hintIndex) ?? 0;
        if (usedForHint >= unit.limit) {
          continue;
        }
      }

      if (used + unit.tokenCount > availableBudget) {
        continue;
      }

      keptUnits.push(unit);
      used += unit.tokenCount;

      if (unit.kind === 'retrieval_bridge_summary' || unit.kind === 'retrieval_raw_bundle') {
        keptHintCounts.set(unit.hintIndex, (keptHintCounts.get(unit.hintIndex) ?? 0) + 1);
      }
    }

    const droppedBridgeUnits = retrievalUnits
      .filter((unit): unit is RetrievalBridgeSummaryUnit => unit.kind === 'retrieval_bridge_summary')
      .filter((unit) => !keptUnits.includes(unit))
      .sort(compareRetrievalUnits);

    for (const bridgeUnit of droppedBridgeUnits) {
      const keptRawUnitsForHint = keptUnits
        .filter((unit): unit is RetrievalRawBundleUnit => unit.kind === 'retrieval_raw_bundle')
        .filter((unit) => unit.hintIndex === bridgeUnit.hintIndex);

      if (keptRawUnitsForHint.length >= bridgeUnit.limit) {
        const victim = [...keptRawUnitsForHint]
          .sort(compareWeakestRawRetrievalUnits)
          .find(
            (rawUnit) =>
              canBridgeReplaceRawRegion(bridgeUnit, rawUnit) &&
              used - rawUnit.tokenCount + bridgeUnit.tokenCount <= availableBudget,
          );

        if (victim !== undefined) {
          const victimIndex = keptUnits.indexOf(victim);
          if (victimIndex >= 0) {
            keptUnits.splice(victimIndex, 1, bridgeUnit);
            used = used - victim.tokenCount + bridgeUnit.tokenCount;
            continue;
          }
        }
      }

      const compressedSwap = [...keptRawUnitsForHint]
        .sort(compareWeakestRawRetrievalUnits)
        .map((rawUnit) => {
          const maxBridgeTokens = availableBudget - (used - rawUnit.tokenCount);
          if (
            maxBridgeTokens <= 0 ||
            !canCompressedBridgeReplaceRawRegion(bridgeUnit, rawUnit) ||
            !compressBridgeUnitInPlace({
              bridgeUnit,
              maxTokens: maxBridgeTokens,
              tokenizer: this.deps.tokenizer,
            })
          ) {
            return undefined;
          }

          return {
            rawUnit,
            maxBridgeTokens,
          };
        })
        .find((entry): entry is { readonly rawUnit: RetrievalRawBundleUnit; readonly maxBridgeTokens: number } =>
          entry !== undefined,
        );

      if (compressedSwap === undefined) {
        continue;
      }

      const victimIndex = keptUnits.indexOf(compressedSwap.rawUnit);
      if (victimIndex < 0) {
        continue;
      }

      keptUnits.splice(victimIndex, 1, bridgeUnit);
      used = used - compressedSwap.rawUnit.tokenCount + bridgeUnit.tokenCount;
    }

    const kept = [...keptUnits].sort((left, right) => left.order - right.order);
    const totalPackableUnitCount = rankedUnits.length + pinnedBaseUnits.length;

    for (const unit of rankedUnits) {
      if (keptUnits.includes(unit)) {
        continue;
      }

      switch (unit.kind) {
        case 'base_summary':
        case 'retrieval_bridge_summary':
          droppedSummaryCount += unit.summaryReferences.length;
          break;
        case 'base_message':
          droppedMessageCount += unit.modelMessages.length;
          break;
        case 'retrieval_raw_bundle':
          droppedMessageCount += unit.messageIds.length;
          break;
      }
    }

    if (kept.length < totalPackableUnitCount) {
      trimmedToFit = true;
    }

    modelMessages.splice(0, modelMessages.length, ...kept.flatMap((unit) => unit.modelMessages));
    summaryReferences.splice(
      0,
      summaryReferences.length,
      ...kept.flatMap((unit) =>
        unit.kind === 'base_summary' || unit.kind === 'retrieval_bridge_summary' ? unit.summaryReferences : [],
      ),
    );

    const keptRetrievedMessageIdStrings = new Set(
      kept
        .filter((unit): unit is Extract<PackableUnit, { kind: 'retrieval_raw_bundle' }> =>
          unit.kind === 'retrieval_raw_bundle',
        )
        .flatMap((unit) => unit.messageIds)
        .map((messageId) => String(messageId)),
    );
    const keptRetrievedSummaryIdStrings = new Set(
      kept
        .filter((unit): unit is Extract<PackableUnit, { kind: 'retrieval_bridge_summary' }> =>
          unit.kind === 'retrieval_bridge_summary',
        )
        .flatMap((unit) => unit.summaryReferences)
        .map((reference) => String(reference.id)),
    );

    budgetUsedValue = used;

    const keptSummaryIdStrings = new Set(summaryReferences.map((reference) => String(reference.id)));
    const finalizedRetrievalDiagnostics = retrievalDiagnostics.map((hint) => {
      const selectedSummaryIds = hint.selectedSummaryIds.filter(
        (summaryId) =>
          keptSummaryIdStrings.has(String(summaryId)) && keptRetrievedSummaryIdStrings.has(String(summaryId)),
      );
      const selectedMessageIds = hint.selectedMessageIds.filter((messageId) =>
        keptRetrievedMessageIdStrings.has(String(messageId)),
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
