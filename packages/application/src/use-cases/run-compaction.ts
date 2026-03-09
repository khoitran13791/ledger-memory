import {
  createCompactionPolicyService,
  createContextItem,
  createSummaryContextItemRef,
  createSummaryNode,
  createTokenBudgetService,
  createTokenCount,
  createArtifactId,
  InvariantViolationError,
  type ArtifactId,
  type CompactionPolicyService,
  type ContextItem,
  type ContextItemWithTokens,
  type EventId,
  type EventMetadata,
  type IdService,
  type LedgerEvent,
  type MessageRole,
  type SummaryKind,
  type SummaryNode,
  type SummaryNodeId,
  type TokenBudgetService,
  type TokenCount,
} from '@ledgermind/domain';

import {
  ApplicationError,
  ConversationNotFoundError,
  InvalidTokenizerOutputError,
  type TokenizerOperation,
} from '../errors/application-errors';
import type { ClockPort } from '../ports/driven/clock/clock.port';
import type { EventPublisherPort } from '../ports/driven/events/event-publisher.port';
import type { SummarizationMessage, SummarizerPort } from '../ports/driven/llm/summarizer.port';
import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
import {
  StaleContextVersionError,
  type ContextProjectionPort,
} from '../ports/driven/persistence/context-projection.port';
import type { LedgerReadPort } from '../ports/driven/persistence/ledger-read.port';
import type { UnitOfWork, UnitOfWorkPort } from '../ports/driven/persistence/unit-of-work.port';
import type { RunCompactionInput, RunCompactionOutput } from '../ports/driving/memory-engine.port';

export const DETERMINISTIC_FALLBACK_MARKER =
  '\n\n[... truncated — use memory.expand(summary_id) for full content ...]';

const MAX_ESCALATION_LEVEL = 3;

export interface RunCompactionConfig {
  readonly maxRounds: number;
  readonly blockTokenTargetFraction: number;
  readonly minBlockSize: number;
  readonly tailWindowSize: number;
  readonly targetFreePercentage: number;
  readonly deterministicFallbackMaxTokens: number;
}

const DEFAULT_RUN_COMPACTION_CONFIG: RunCompactionConfig = {
  maxRounds: 10,
  blockTokenTargetFraction: 0.25,
  minBlockSize: 2,
  tailWindowSize: 3,
  targetFreePercentage: 0.15,
  deterministicFallbackMaxTokens: 512,
};

export class CompactionFailedToConvergeError extends ApplicationError {
  readonly code = 'COMPACTION_FAILED_TO_CONVERGE';
  readonly conversationId: RunCompactionInput['conversationId'];
  readonly rounds: number;
  readonly currentTokens: TokenCount;
  readonly availableBudget: TokenCount;

  constructor(input: {
    readonly conversationId: RunCompactionInput['conversationId'];
    readonly rounds: number;
    readonly currentTokens: TokenCount;
    readonly availableBudget: TokenCount;
  }) {
    super('Hard-trigger compaction failed to converge within max rounds.');
    this.conversationId = input.conversationId;
    this.rounds = input.rounds;
    this.currentTokens = input.currentTokens;
    this.availableBudget = input.availableBudget;
  }
}

export interface RunCompactionUseCaseDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly summarizer: SummarizerPort;
  readonly tokenizer: TokenizerPort;
  readonly idService: IdService;
  readonly clock: ClockPort;
  readonly tokenBudgetService?: TokenBudgetService;
  readonly compactionPolicyService?: CompactionPolicyService;
  readonly config?: Partial<RunCompactionConfig>;
  readonly eventPublisher?: EventPublisherPort;
}

interface ResolvedContextItem {
  readonly item: ContextItem;
  readonly tokenCount: TokenCount;
  readonly role?: MessageRole;
  readonly content: string;
  readonly artifactIds: readonly ArtifactId[];
}

type EscalationOutput = {
  readonly level: 1 | 2 | 3;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly preservedArtifactIds: readonly ArtifactId[];
};

type RoundResult =
  | {
      readonly kind: 'stale';
    }
  | {
      readonly kind: 'no_candidates';
    }
  | {
      readonly kind: 'compacted';
      readonly nodeId: SummaryNodeId;
      readonly currentTokens: TokenCount;
      readonly summaryKind: SummaryKind;
      readonly level: 1 | 2 | 3;
      readonly inputTokens: TokenCount;
      readonly outputTokens: TokenCount;
      readonly coveredItemCount: number;
    };

const ensureSafePositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvariantViolationError(`${label} must be a positive safe integer.`);
  }
};

const ensureFractionRange = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvariantViolationError(`${label} must be a finite number in [0, 1].`);
  }
};

const createRunCompactionConfig = (partial?: Partial<RunCompactionConfig>): RunCompactionConfig => {
  const config: RunCompactionConfig = {
    ...DEFAULT_RUN_COMPACTION_CONFIG,
    ...partial,
  };

  ensureSafePositiveInteger(config.maxRounds, 'maxRounds');
  ensureFractionRange(config.blockTokenTargetFraction, 'blockTokenTargetFraction');

  if (config.blockTokenTargetFraction <= 0) {
    throw new InvariantViolationError('blockTokenTargetFraction must be greater than 0.');
  }

  ensureSafePositiveInteger(config.minBlockSize, 'minBlockSize');

  if (!Number.isSafeInteger(config.tailWindowSize) || config.tailWindowSize < 0) {
    throw new InvariantViolationError('tailWindowSize must be a non-negative safe integer.');
  }

  ensureFractionRange(config.targetFreePercentage, 'targetFreePercentage');
  ensureSafePositiveInteger(config.deterministicFallbackMaxTokens, 'deterministicFallbackMaxTokens');

  return Object.freeze(config);
};

const addArtifactIdFromUnknown = (target: Set<ArtifactId>, value: unknown): void => {
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      target.add(createArtifactId(value.trim()));
    } catch {
      // Ignore malformed metadata values; downstream integrity checks guard lineage.
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addArtifactIdFromUnknown(target, item);
    }
    return;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    addArtifactIdFromUnknown(target, (value as { readonly id?: unknown }).id);
  }
};

const extractArtifactIdsFromMetadata = (metadata: EventMetadata): readonly ArtifactId[] => {
  const artifactIds = new Set<ArtifactId>();

  addArtifactIdFromUnknown(artifactIds, metadata['artifactIds']);
  addArtifactIdFromUnknown(artifactIds, metadata['artifact_ids']);
  addArtifactIdFromUnknown(artifactIds, metadata['artifactId']);
  addArtifactIdFromUnknown(artifactIds, metadata['artifact_id']);
  addArtifactIdFromUnknown(artifactIds, metadata['artifacts']);

  return [...artifactIds];
};

const uniqueArtifactIds = (artifactIds: readonly ArtifactId[]): readonly ArtifactId[] => {
  const seen = new Set<ArtifactId>();
  const ordered: ArtifactId[] = [];

  for (const artifactId of artifactIds) {
    if (!seen.has(artifactId)) {
      seen.add(artifactId);
      ordered.push(artifactId);
    }
  }

  return ordered;
};

const uniqueMessageIds = (messageIds: readonly EventId[]): readonly EventId[] => {
  const seen = new Set<EventId>();
  const ordered: EventId[] = [];

  for (const messageId of messageIds) {
    if (!seen.has(messageId)) {
      seen.add(messageId);
      ordered.push(messageId);
    }
  }

  return ordered;
};

const uniqueSummaryIds = (summaryIds: readonly SummaryNodeId[]): readonly SummaryNodeId[] => {
  const seen = new Set<SummaryNodeId>();
  const ordered: SummaryNodeId[] = [];

  for (const summaryId of summaryIds) {
    if (!seen.has(summaryId)) {
      seen.add(summaryId);
      ordered.push(summaryId);
    }
  }

  return ordered;
};

const describeTokenizerOutput = (output: unknown): string => {
  if (output === null) {
    return 'null';
  }

  if (output === undefined) {
    return 'undefined';
  }

  if (typeof output === 'number') {
    return Number.isNaN(output) ? 'number(NaN)' : `number(${output})`;
  }

  if (typeof output === 'object') {
    if ('value' in output) {
      const rawValue = (output as { readonly value?: unknown }).value;
      if (typeof rawValue === 'number') {
        return Number.isNaN(rawValue)
          ? 'TokenCount.value(number(NaN))'
          : `TokenCount.value(number(${rawValue}))`;
      }
      return `TokenCount.value(${String(rawValue)})`;
    }

    return 'object(without value field)';
  }

  return typeof output;
};

const validateTokenizerTokenCount = (
  output: unknown,
  tokenizer: string,
  operation: TokenizerOperation,
): TokenCount => {
  if (typeof output !== 'object' || output === null || !('value' in output)) {
    throw new InvalidTokenizerOutputError(tokenizer, operation, describeTokenizerOutput(output));
  }

  const tokenValue = (output as { readonly value: unknown }).value;

  if (
    typeof tokenValue !== 'number' ||
    !Number.isFinite(tokenValue) ||
    !Number.isSafeInteger(tokenValue) ||
    tokenValue < 0
  ) {
    throw new InvalidTokenizerOutputError(tokenizer, operation, describeTokenizerOutput(output));
  }

  return output as TokenCount;
};

export const applyDeterministicFallback = (input: {
  readonly content: string;
  readonly maxTokens: number;
  readonly countTokens: (text: string) => TokenCount;
}): string => {
  const inputTokens = input.countTokens(input.content);

  if (inputTokens.value <= input.maxTokens) {
    return input.content;
  }

  const markerTokens = input.countTokens(DETERMINISTIC_FALLBACK_MARKER);
  const targetTokens = Math.max(1, input.maxTokens - markerTokens.value);
  const ratio = input.content.length / Math.max(1, inputTokens.value);

  let cutoff = Math.max(1, Math.floor(targetTokens * ratio));
  const initialBoundary = input.content.lastIndexOf(' ', cutoff);
  cutoff = initialBoundary > 0 ? initialBoundary : cutoff;

  let truncated = `${input.content.slice(0, cutoff)}${DETERMINISTIC_FALLBACK_MARKER}`;

  while (input.countTokens(truncated).value > input.maxTokens && cutoff > 1) {
    cutoff = Math.max(1, Math.floor(cutoff * 0.9));

    const boundary = input.content.lastIndexOf(' ', cutoff);
    cutoff = boundary > 0 ? boundary : cutoff;

    truncated = `${input.content.slice(0, cutoff)}${DETERMINISTIC_FALLBACK_MARKER}`;
  }

  if (input.countTokens(truncated).value <= input.maxTokens) {
    return truncated;
  }

  let markerOnly = DETERMINISTIC_FALLBACK_MARKER;
  while (input.countTokens(markerOnly).value > input.maxTokens && markerOnly.length > 1) {
    markerOnly = markerOnly.slice(0, Math.floor(markerOnly.length * 0.9));
  }

  return markerOnly;
};

export class RunCompactionUseCase {
  private readonly config: RunCompactionConfig;
  private readonly tokenBudgetService: TokenBudgetService;
  private readonly compactionPolicyService: CompactionPolicyService;
  private readonly tokenizerName: string;

  constructor(private readonly deps: RunCompactionUseCaseDeps) {
    this.config = createRunCompactionConfig(deps.config);
    this.tokenBudgetService =
      deps.tokenBudgetService ??
      createTokenBudgetService(
        deps.config?.targetFreePercentage === undefined
          ? undefined
          : {
              softThresholdFraction: deps.config.targetFreePercentage,
            },
      );
    this.compactionPolicyService =
      deps.compactionPolicyService ??
      createCompactionPolicyService({
        blockTokenTargetFraction: this.config.blockTokenTargetFraction,
        minBlockSize: this.config.minBlockSize,
        tailWindowSize: this.config.tailWindowSize,
      });
    this.tokenizerName = deps.tokenizer.constructor.name || 'TokenizerPort';
  }

  async execute(input: RunCompactionInput): Promise<RunCompactionOutput> {
    const conversation = await this.deps.unitOfWork.execute((uow) => {
      return uow.conversations.get(input.conversationId);
    });

    if (conversation === null) {
      throw new ConversationNotFoundError(input.conversationId);
    }

    const budget = this.tokenBudgetService.computeBudget(conversation.config, createTokenCount(0));
    const defaultTargetTokens = createTokenCount(
      Math.floor(budget.available.value * (1 - this.config.targetFreePercentage)),
    );
    const targetTokens = input.targetTokens ?? defaultTargetTokens;

    const initialTokens = await this.readCurrentContextTokenCount(input.conversationId);
    let currentTokens = initialTokens;

    let rounds = 0;
    const nodesCreated: SummaryNodeId[] = [];
    let staleRetries = 0;

    while (currentTokens.value > targetTokens.value && rounds < this.config.maxRounds) {
      const roundResult = await this.runSingleRound(input.conversationId, budget.available);

      if (roundResult.kind === 'stale') {
        staleRetries += 1;

        if (staleRetries > this.config.maxRounds * MAX_ESCALATION_LEVEL) {
          break;
        }

        continue;
      }

      staleRetries = 0;

      if (roundResult.kind === 'no_candidates') {
        break;
      }

      rounds += 1;
      nodesCreated.push(roundResult.nodeId);
      currentTokens = roundResult.currentTokens;

      this.deps.eventPublisher?.publish({
        type: 'SummaryNodeCreated',
        conversationId: input.conversationId,
        nodeId: roundResult.nodeId,
        kind: roundResult.summaryKind,
        level: roundResult.level,
        inputTokens: roundResult.inputTokens,
        outputTokens: roundResult.outputTokens,
        coveredItemCount: roundResult.coveredItemCount,
      });
    }

    if (input.trigger === 'hard' && currentTokens.value > budget.available.value) {
      throw new CompactionFailedToConvergeError({
        conversationId: input.conversationId,
        rounds,
        currentTokens,
        availableBudget: budget.available,
      });
    }

    const tokensFreed = createTokenCount(Math.max(0, initialTokens.value - currentTokens.value));

    if (this.deps.eventPublisher) {
      this.deps.eventPublisher.publish({
        type: 'CompactionCompleted',
        conversationId: input.conversationId,
        rounds,
        nodesCreated: Object.freeze([...nodesCreated]),
        tokensFreed,
        converged: currentTokens.value <= targetTokens.value,
      });
    }

    return {
      rounds,
      nodesCreated: Object.freeze([...nodesCreated]),
      tokensFreed,
      converged: currentTokens.value <= targetTokens.value,
    };
  }

  private async readCurrentContextTokenCount(conversationId: RunCompactionInput['conversationId']) {
    return this.deps.unitOfWork.execute(async (uow) => {
      return uow.context.getContextTokenCount(conversationId);
    });
  }

  private async runSingleRound(
    conversationId: RunCompactionInput['conversationId'],
    availableBudget: TokenCount,
  ): Promise<RoundResult> {
    try {
      return await this.deps.unitOfWork.execute(async (uow) => {
        const { snapshotVersion, resolvedItems, eventsById } = await this.resolveContextSnapshot(
          uow,
          conversationId,
        );

        const compactionInputs: readonly ContextItemWithTokens[] = resolvedItems.map((entry) => {
          if (entry.role === undefined) {
            return {
              item: entry.item,
              tokenCount: entry.tokenCount,
            };
          }

          return {
            item: entry.item,
            tokenCount: entry.tokenCount,
            role: entry.role,
          };
        });

        const candidate = this.compactionPolicyService.selectCandidates(compactionInputs, [], availableBudget)[0];

        if (candidate === undefined) {
          return { kind: 'no_candidates' };
        }

        const resolvedByPosition = new Map<number, ResolvedContextItem>(
          resolvedItems.map((entry) => [entry.item.position, entry]),
        );

        const blockItems = candidate.items
          .map((entry) => resolvedByPosition.get(entry.item.position))
          .filter((entry): entry is ResolvedContextItem => entry !== undefined)
          .sort((left, right) => left.item.position - right.item.position);

        if (blockItems.length !== candidate.items.length || blockItems.length === 0) {
          throw new InvariantViolationError('Failed to resolve compaction candidates against current context.');
        }

        const summarizationMessages: readonly SummarizationMessage[] = blockItems.map((entry) => ({
          role: entry.role ?? 'assistant',
          content: entry.content,
        }));

        const sourceArtifactIds = uniqueArtifactIds(
          blockItems.flatMap((entry) => entry.artifactIds),
        );

        const escalationOutput = await this.runEscalation(
          candidate.tokenCount,
          summarizationMessages,
          sourceArtifactIds,
        );

        const directMessageIds: EventId[] = [];
        const directSummaryIds: SummaryNodeId[] = [];

        for (const entry of blockItems) {
          if (entry.item.ref.type === 'message') {
            directMessageIds.push(entry.item.ref.messageId);
            continue;
          }

          directSummaryIds.push(entry.item.ref.summaryId);
        }

        const summaryKind: SummaryKind =
          directSummaryIds.length > 0 && directMessageIds.length === 0 ? 'condensed' : 'leaf';

        const summaryNode = this.createSummaryNode({
          conversationId,
          kind: summaryKind,
          content: escalationOutput.content,
          tokenCount: escalationOutput.tokenCount,
          artifactIds: uniqueArtifactIds([
            ...sourceArtifactIds,
            ...escalationOutput.preservedArtifactIds,
          ]),
        });

        await uow.dag.createNode(summaryNode);

        if (summaryKind === 'leaf') {
          const leafMessageIds = await this.resolveLeafMessageIdsForEdgeCreation({
            uow,
            directMessageIds,
            directSummaryIds,
            eventsById,
          });

          await uow.dag.addLeafEdges(summaryNode.id, leafMessageIds);
        } else {
          await uow.dag.addCondensedEdges(summaryNode.id, uniqueSummaryIds(directSummaryIds));
        }

        const positionsToRemove = blockItems.map((entry) => entry.item.position).sort((a, b) => a - b);
        const insertionPosition = positionsToRemove[0];

        if (insertionPosition === undefined) {
          throw new InvariantViolationError('Compaction candidate did not provide removable context positions.');
        }

        await uow.context.replaceContextItems(
          conversationId,
          snapshotVersion,
          positionsToRemove,
          createContextItem({
            conversationId,
            position: insertionPosition,
            ref: createSummaryContextItemRef(summaryNode.id),
          }),
        );

        const currentTokens = await uow.context.getContextTokenCount(conversationId);

        return {
          kind: 'compacted',
          nodeId: summaryNode.id,
          currentTokens,
          summaryKind,
          level: escalationOutput.level,
          inputTokens: candidate.tokenCount,
          outputTokens: escalationOutput.tokenCount,
          coveredItemCount: blockItems.length,
        };
      });
    } catch (error) {
      if (error instanceof StaleContextVersionError) {
        return { kind: 'stale' };
      }

      throw error;
    }
  }

  private createSummaryNode(input: {
    readonly conversationId: RunCompactionInput['conversationId'];
    readonly kind: SummaryKind;
    readonly content: string;
    readonly tokenCount: TokenCount;
    readonly artifactIds: readonly ArtifactId[];
  }): SummaryNode {
    const id = this.deps.idService.generateSummaryId({
      content: input.content,
      conversationId: input.conversationId,
      kind: input.kind,
    });

    return createSummaryNode({
      id,
      conversationId: input.conversationId,
      kind: input.kind,
      content: input.content,
      tokenCount: input.tokenCount,
      artifactIds: input.artifactIds,
      createdAt: this.deps.clock.now(),
    });
  }

  private async resolveContextSnapshot(
    uow: Pick<UnitOfWork, 'context' | 'dag'>,
    conversationId: RunCompactionInput['conversationId'],
  ): Promise<{
    readonly snapshotVersion: Awaited<ReturnType<ContextProjectionPort['getCurrentContext']>>['version'];
    readonly resolvedItems: readonly ResolvedContextItem[];
    readonly eventsById: ReadonlyMap<EventId, LedgerEvent>;
  }> {
    const [contextSnapshot, events] = await Promise.all([
      uow.context.getCurrentContext(conversationId),
      this.deps.ledgerRead.getEvents(conversationId),
    ]);

    const eventsById = new Map<EventId, LedgerEvent>(events.map((event) => [event.id, event]));
    const resolvedItems: ResolvedContextItem[] = [];

    for (const item of contextSnapshot.items) {
      if (item.ref.type === 'message') {
        const event = eventsById.get(item.ref.messageId);

        if (event === undefined) {
          throw new InvariantViolationError(
            `Context references unknown message: ${item.ref.messageId}`,
          );
        }

        resolvedItems.push({
          item,
          tokenCount: event.tokenCount,
          role: event.role,
          content: event.content,
          artifactIds: extractArtifactIdsFromMetadata(event.metadata),
        });
        continue;
      }

      const summary = await uow.dag.getNode(item.ref.summaryId);
      if (summary === null) {
        throw new InvariantViolationError(
          `Context references unknown summary: ${item.ref.summaryId}`,
        );
      }

      resolvedItems.push({
        item,
        tokenCount: summary.tokenCount,
        content: summary.content,
        artifactIds: summary.artifactIds,
      });
    }

    return {
      snapshotVersion: contextSnapshot.version,
      resolvedItems,
      eventsById,
    };
  }

  private async resolveLeafMessageIdsForEdgeCreation(input: {
    readonly uow: Pick<UnitOfWork, 'dag'>;
    readonly directMessageIds: readonly EventId[];
    readonly directSummaryIds: readonly SummaryNodeId[];
    readonly eventsById: ReadonlyMap<EventId, LedgerEvent>;
  }): Promise<readonly EventId[]> {
    if (input.directSummaryIds.length === 0) {
      return uniqueMessageIds(input.directMessageIds);
    }

    const sequenceByMessageId = new Map<EventId, number>();

    for (const messageId of input.directMessageIds) {
      const event = input.eventsById.get(messageId);
      if (event !== undefined) {
        sequenceByMessageId.set(event.id, event.sequence);
      }
    }

    for (const summaryId of uniqueSummaryIds(input.directSummaryIds)) {
      const expandedMessages = await input.uow.dag.expandToMessages(summaryId);

      for (const event of expandedMessages) {
        const existingSequence = sequenceByMessageId.get(event.id);
        if (existingSequence === undefined || existingSequence > event.sequence) {
          sequenceByMessageId.set(event.id, event.sequence);
        }
      }
    }

    return [...sequenceByMessageId.entries()]
      .sort((left, right) => {
        if (left[1] !== right[1]) {
          return left[1] - right[1];
        }

        return left[0].localeCompare(right[0]);
      })
      .map(([eventId]) => eventId);
  }

  private async runEscalation(
    inputTokens: TokenCount,
    messages: readonly SummarizationMessage[],
    sourceArtifactIds: readonly ArtifactId[],
  ): Promise<EscalationOutput> {
    const normalOutput = await this.deps.summarizer.summarize({
      messages,
      mode: 'normal',
      artifactIdsToPreserve: sourceArtifactIds,
    });

    if (!this.compactionPolicyService.shouldEscalate(inputTokens, normalOutput.tokenCount)) {
      return {
        level: 1,
        content: normalOutput.content,
        tokenCount: normalOutput.tokenCount,
        preservedArtifactIds: normalOutput.preservedArtifactIds,
      };
    }

    const aggressiveOutput = await this.deps.summarizer.summarize({
      messages,
      mode: 'aggressive',
      targetTokens: Math.max(1, Math.floor(inputTokens.value / 2)),
      artifactIdsToPreserve: sourceArtifactIds,
    });

    if (!this.compactionPolicyService.shouldEscalate(inputTokens, aggressiveOutput.tokenCount)) {
      return {
        level: 2,
        content: aggressiveOutput.content,
        tokenCount: aggressiveOutput.tokenCount,
        preservedArtifactIds: aggressiveOutput.preservedArtifactIds,
      };
    }

    const deterministicContent = this.deterministicFallback(
      messages.map((message) => message.content).join('\n'),
    );

    return {
      level: 3,
      content: deterministicContent,
      tokenCount: this.countTokensSafely(deterministicContent),
      preservedArtifactIds: sourceArtifactIds,
    };
  }

  private countTokensSafely(text: string): TokenCount {
    const output = this.deps.tokenizer.countTokens(text);
    return validateTokenizerTokenCount(output, this.tokenizerName, 'countTokens');
  }

  private deterministicFallback(content: string): string {
    return applyDeterministicFallback({
      content,
      maxTokens: this.config.deterministicFallbackMaxTokens,
      countTokens: (text) => this.countTokensSafely(text),
    });
  }
}
