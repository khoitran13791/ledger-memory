import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  ArtifactId,
  ContextItem,
  ContextVersion,
  Conversation,
  ConversationConfig,
  ConversationId,
  DomainEvent,
  EventId,
  EventMetadata,
  HashPort,
  LedgerEvent,
  SummaryNode,
  SummaryNodeId,
} from '@ledgermind/domain';
import {
  createArtifactId,
  createCompactionThresholds,
  createContextItem,
  createContextVersion,
  createConversation,
  createConversationConfig,
  createConversationId,
  createEventId,
  createIdService,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  type IdService,
  type SequenceNumber,
  type TokenCount,
} from '@ledgermind/domain';

import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type {
  SummarizationInput,
  SummarizationOutput,
  SummarizerPort,
} from '../../ports/driven/llm/summarizer.port';
import type { TokenizerPort } from '../../ports/driven/llm/tokenizer.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import {
  StaleContextVersionError,
  type ContextProjectionPort,
} from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerAppendPort } from '../../ports/driven/persistence/ledger-append.port';
import type { LedgerReadPort, SequenceRange } from '../../ports/driven/persistence/ledger-read.port';
import type { IntegrityReport, SummaryDagPort } from '../../ports/driven/persistence/summary-dag.port';
import type { UnitOfWork, UnitOfWorkPort } from '../../ports/driven/persistence/unit-of-work.port';
import type { EventPublisherPort } from '../../ports/driven/events/event-publisher.port';
import { InvalidTokenizerOutputError } from '../../errors/application-errors';
import {
  CompactionFailedToConvergeError,
  RunCompactionUseCase,
  type RunCompactionConfig,
} from '../run-compaction';

const conversationId = createConversationId('conv_run_compaction_uc');

const createConversationForTest = (
  overrides?: Partial<{
    contextWindow: number;
    softThreshold: number;
    hardThreshold: number;
  }>,
): Conversation => {
  const config: ConversationConfig = createConversationConfig({
    modelName: 'claude-opus-4-6',
    contextWindow: createTokenCount(overrides?.contextWindow ?? 100),
    thresholds: createCompactionThresholds(
      overrides?.softThreshold ?? 0.6,
      overrides?.hardThreshold ?? 1,
    ),
  });

  return createConversation({
    id: conversationId,
    config,
    createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
  });
};

const createEventForTest = (input: {
  readonly id: string;
  readonly sequence: number;
  readonly role?: LedgerEvent['role'];
  readonly content?: string;
  readonly tokenCount?: number;
  readonly metadata?: EventMetadata;
}): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(input.id),
    conversationId,
    sequence: createSequenceNumber(input.sequence),
    role: input.role ?? 'user',
    content: input.content ?? input.id,
    tokenCount: createTokenCount(input.tokenCount ?? 10),
    occurredAt: createTimestamp(
      new Date(`2026-01-01T00:00:${String(input.sequence).padStart(2, '0')}.000Z`),
    ),
    metadata: input.metadata ?? {},
  });
};

const createSummaryForTest = (input: {
  readonly id: string;
  readonly tokenCount?: number;
  readonly kind?: SummaryNode['kind'];
  readonly content?: string;
  readonly artifactIds?: readonly ArtifactId[];
}): SummaryNode => {
  return createSummaryNode({
    id: createSummaryNodeId(input.id),
    conversationId,
    kind: input.kind ?? 'leaf',
    content: input.content ?? `[Summary] ${input.id}`,
    tokenCount: createTokenCount(input.tokenCount ?? 12),
    ...(input.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
    createdAt: createTimestamp(new Date('2026-01-01T00:00:30.000Z')),
  });
};

const normalizeContextItems = (
  inputConversationId: ConversationId,
  items: readonly ContextItem[],
): ContextItem[] => {
  return [...items]
    .sort((left, right) => left.position - right.position)
    .map((item, index) =>
      createContextItem({
        conversationId: inputConversationId,
        position: index,
        ref: item.ref,
      }),
    );
};

type MutableState = {
  conversation: Conversation | null;
  events: LedgerEvent[];
  contextItems: ContextItem[];
  contextVersion: ContextVersion;
  summaries: Map<SummaryNodeId, SummaryNode>;
};

const cloneState = (state: MutableState): MutableState => {
  return {
    conversation: state.conversation,
    events: [...state.events],
    contextItems: [...state.contextItems],
    contextVersion: createContextVersion(state.contextVersion),
    summaries: new Map(state.summaries),
  };
};

const applyState = (target: MutableState, source: MutableState): void => {
  target.conversation = source.conversation;
  target.events = [...source.events];
  target.contextItems = [...source.contextItems];
  target.contextVersion = source.contextVersion;
  target.summaries = new Map(source.summaries);
};

class DeterministicHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
}

class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const timestamp = createTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)));
    this.tick += 1;
    return timestamp;
  }
}

class SimpleTokenizer implements TokenizerPort {
  countTokens(text: string): TokenCount {
    return createTokenCount(Math.ceil(text.length / 4));
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(Math.ceil(byteLength / 4));
  }
}

class InvalidOutputTokenizer implements TokenizerPort {
  countTokens(): TokenCount {
    return { value: Number.NaN } as TokenCount;
  }

  estimateFromBytes(): TokenCount {
    return { value: Number.NaN } as TokenCount;
  }
}

type PlannedSummaryOutput = {
  readonly content: string;
  readonly tokenCount: number;
  readonly preservedArtifactIds?: readonly ArtifactId[];
};

class TestSummarizer implements SummarizerPort {
  readonly calls: SummarizationInput[] = [];

  constructor(
    private readonly normalOutputs: PlannedSummaryOutput[],
    private readonly aggressiveOutputs: PlannedSummaryOutput[] = [],
  ) {}

  async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
    this.calls.push(input);

    const queue = input.mode === 'normal' ? this.normalOutputs : this.aggressiveOutputs;
    const next = queue.shift();

    if (next === undefined) {
      throw new Error(`Missing planned ${input.mode} summarizer output.`);
    }

    return {
      content: next.content,
      tokenCount: createTokenCount(next.tokenCount),
      preservedArtifactIds: next.preservedArtifactIds ?? input.artifactIdsToPreserve,
    };
  }
}

class NoopLedgerAppendPort implements LedgerAppendPort {
  async appendEvents(): Promise<void> {
    return;
  }

  async getNextSequence(): Promise<SequenceNumber> {
    return createSequenceNumber(1);
  }
}

class NoopArtifactStore implements ArtifactStorePort {
  async store(): Promise<void> {
    return;
  }

  async getMetadata(): Promise<Artifact | null> {
    return null;
  }

  async getContent(): Promise<string | Uint8Array | null> {
    return null;
  }

  async updateExploration(): Promise<void> {
    return;
  }
}

class TestConversationStore implements ConversationPort {
  constructor(private readonly state: MutableState) {}

  async create(config: ConversationConfig): Promise<Conversation> {
    const created = createConversation({
      id: createConversationId('conv_created_run_compaction_test'),
      config,
      createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
    });

    this.state.conversation = created;
    return created;
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    if (this.state.conversation?.id === id) {
      return this.state.conversation;
    }

    return null;
  }

  async getAncestorChain(): Promise<readonly ConversationId[]> {
    return [];
  }
}

class TestLedgerReadPort implements LedgerReadPort {
  constructor(private readonly state: MutableState) {}

  async getEvents(
    inputConversationId: ConversationId,
    range?: SequenceRange,
  ): Promise<readonly LedgerEvent[]> {
    const ordered = this.state.events
      .filter((event) => event.conversationId === inputConversationId)
      .sort((left, right) => left.sequence - right.sequence);

    if (range === undefined) {
      return ordered;
    }

    return ordered.filter((event) => {
      if (range.start !== undefined && event.sequence < range.start) {
        return false;
      }

      if (range.end !== undefined && event.sequence > range.end) {
        return false;
      }

      return true;
    });
  }

  async searchEvents(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async regexSearchEvents() {
    return [];
  }
}

type ContextControls = {
  replaceCalls: Array<{
    expectedVersion: ContextVersion;
    positionsToRemove: readonly number[];
    replacementPosition: number;
  }>;
  staleFailuresRemaining: number;
};

class TestContextProjection implements ContextProjectionPort {
  constructor(
    private readonly state: MutableState,
    private readonly controls: ContextControls,
  ) {}

  async getCurrentContext(): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ContextVersion;
  }> {
    return {
      items: normalizeContextItems(conversationId, this.state.contextItems),
      version: this.state.contextVersion,
    };
  }

  async getContextTokenCount(): Promise<TokenCount> {
    const eventsById = new Map<EventId, LedgerEvent>(
      this.state.events.map((event) => [event.id, event] as const),
    );

    let total = 0;
    for (const item of this.state.contextItems) {
      if (item.ref.type === 'message') {
        total += eventsById.get(item.ref.messageId)?.tokenCount.value ?? 0;
      } else {
        total += this.state.summaries.get(item.ref.summaryId)?.tokenCount.value ?? 0;
      }
    }

    return createTokenCount(total);
  }

  async appendContextItems(): Promise<ContextVersion> {
    throw new Error('appendContextItems is not used by RunCompactionUseCase tests');
  }

  async replaceContextItems(
    inputConversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: readonly number[],
    replacement: ContextItem,
  ): Promise<ContextVersion> {
    this.controls.replaceCalls.push({
      expectedVersion,
      positionsToRemove: [...positionsToRemove],
      replacementPosition: replacement.position,
    });

    if (this.controls.staleFailuresRemaining > 0) {
      this.controls.staleFailuresRemaining -= 1;
      throw new StaleContextVersionError(expectedVersion, createContextVersion(expectedVersion + 1));
    }

    if (inputConversationId !== conversationId || replacement.conversationId !== inputConversationId) {
      throw new Error('conversation mismatch during replaceContextItems');
    }

    if (this.state.contextVersion !== expectedVersion) {
      throw new StaleContextVersionError(expectedVersion, this.state.contextVersion);
    }

    const normalized = normalizeContextItems(inputConversationId, this.state.contextItems);
    const dedupedPositions = [...new Set(positionsToRemove)].sort((left, right) => left - right);
    const insertionPosition = dedupedPositions[0];

    if (insertionPosition === undefined) {
      return this.state.contextVersion;
    }

    const removalSet = new Set(dedupedPositions);
    const retained = normalized.filter((item) => !removalSet.has(item.position));

    const merged = [
      ...retained.slice(0, insertionPosition),
      createContextItem({
        conversationId: inputConversationId,
        position: insertionPosition,
        ref: replacement.ref,
      }),
      ...retained.slice(insertionPosition),
    ];

    this.state.contextItems = normalizeContextItems(inputConversationId, merged);
    this.state.contextVersion = createContextVersion(this.state.contextVersion + 1);

    return this.state.contextVersion;
  }
}

type DagControls = {
  createNodeCalls: SummaryNode[];
  leafEdgeCalls: Array<{
    summaryId: SummaryNodeId;
    messageIds: readonly EventId[];
  }>;
  condensedEdgeCalls: Array<{
    summaryId: SummaryNodeId;
    parentSummaryIds: readonly SummaryNodeId[];
  }>;
  expandCalls: SummaryNodeId[];
  expandedMessagesBySummaryId: ReadonlyMap<SummaryNodeId, readonly LedgerEvent[]>;
};

class TestSummaryDagPort implements SummaryDagPort {
  constructor(
    private readonly state: MutableState,
    private readonly controls: DagControls,
  ) {}

  async createNode(node: SummaryNode): Promise<void> {
    this.controls.createNodeCalls.push(node);
    this.state.summaries.set(node.id, node);
  }

  async getNode(id: SummaryNodeId): Promise<SummaryNode | null> {
    return this.state.summaries.get(id) ?? null;
  }

  async addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void> {
    this.controls.leafEdgeCalls.push({
      summaryId,
      messageIds: [...messageIds],
    });
  }

  async addCondensedEdges(
    summaryId: SummaryNodeId,
    parentSummaryIds: readonly SummaryNodeId[],
  ): Promise<void> {
    this.controls.condensedEdgeCalls.push({
      summaryId,
      parentSummaryIds: [...parentSummaryIds],
    });
  }

  async getParentSummaryIds(): Promise<readonly SummaryNodeId[]> {
    return [];
  }

  async expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]> {
    this.controls.expandCalls.push(summaryId);
    return this.controls.expandedMessagesBySummaryId.get(summaryId) ?? [];
  }

  async searchSummaries(): Promise<readonly SummaryNode[]> {
    return [];
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    return {
      passed: true,
      checks: [],
    };
  }
}

class TestUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly state: MutableState,
    private readonly contextControls: ContextControls,
    private readonly dagControls: DagControls,
  ) {}

  async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const workingState = cloneState(this.state);

    const uow: UnitOfWork = {
      ledger: new NoopLedgerAppendPort(),
      context: new TestContextProjection(workingState, this.contextControls),
      dag: new TestSummaryDagPort(workingState, this.dagControls),
      artifacts: new NoopArtifactStore(),
      conversations: new TestConversationStore(workingState),
    };

    const result = await work(uow);
    applyState(this.state, workingState);
    return result;
  }
}

const createState = (input?: {
  readonly conversation?: Conversation | null;
  readonly events?: readonly LedgerEvent[];
  readonly contextItems?: readonly ContextItem[];
  readonly contextVersion?: ContextVersion;
  readonly summaries?: readonly SummaryNode[];
}): MutableState => {
  return {
    conversation: input?.conversation ?? createConversationForTest(),
    events: [...(input?.events ?? [])],
    contextItems: normalizeContextItems(conversationId, input?.contextItems ?? []),
    contextVersion: input?.contextVersion ?? createContextVersion(0),
    summaries: new Map((input?.summaries ?? []).map((summary) => [summary.id, summary] as const)),
  };
};

class SpyEventPublisher implements EventPublisherPort {
  readonly events: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.events.push(event);
  }
}

const createUseCase = (input?: {
  readonly state?: MutableState;
  readonly summarizer?: TestSummarizer;
  readonly config?: Partial<RunCompactionConfig>;
  readonly staleFailures?: number;
  readonly expandedMessagesBySummaryId?: ReadonlyMap<SummaryNodeId, readonly LedgerEvent[]>;
  readonly eventPublisher?: SpyEventPublisher;
  readonly tokenizer?: TokenizerPort;
}) => {
  const state = input?.state ?? createState();
  const summarizer =
    input?.summarizer ?? new TestSummarizer([{ content: '[Summary] default', tokenCount: 8 }]);

  const contextControls: ContextControls = {
    replaceCalls: [],
    staleFailuresRemaining: input?.staleFailures ?? 0,
  };

  const dagControls: DagControls = {
    createNodeCalls: [],
    leafEdgeCalls: [],
    condensedEdgeCalls: [],
    expandCalls: [],
    expandedMessagesBySummaryId: input?.expandedMessagesBySummaryId ?? new Map(),
  };

  const idService: IdService = createIdService(new DeterministicHashPort());

  const useCase = new RunCompactionUseCase({
    unitOfWork: new TestUnitOfWork(state, contextControls, dagControls),
    ledgerRead: new TestLedgerReadPort(state),
    summarizer,
    tokenizer: input?.tokenizer ?? new SimpleTokenizer(),
    idService,
    clock: new DeterministicClock(),
    ...(input?.config === undefined ? {} : { config: input.config }),
    ...(input?.eventPublisher === undefined ? {} : { eventPublisher: input.eventPublisher }),
  });

  return {
    state,
    summarizer,
    contextControls,
    dagControls,
    useCase,
  };
};

describe('RunCompactionUseCase', () => {
  it('compacts the oldest non-pinned contiguous block into a leaf summary', async () => {
    const system = createEventForTest({ id: 'evt_run_compact_0', sequence: 1, role: 'system', tokenCount: 5 });
    const first = createEventForTest({ id: 'evt_run_compact_1', sequence: 2, role: 'user', tokenCount: 10 });
    const second = createEventForTest({
      id: 'evt_run_compact_2',
      sequence: 3,
      role: 'assistant',
      tokenCount: 10,
    });
    const third = createEventForTest({ id: 'evt_run_compact_3', sequence: 4, role: 'user', tokenCount: 10 });
    const tailA = createEventForTest({ id: 'evt_run_compact_4', sequence: 5, role: 'user', tokenCount: 10 });
    const tailB = createEventForTest({ id: 'evt_run_compact_5', sequence: 6, role: 'assistant', tokenCount: 10 });
    const tailC = createEventForTest({ id: 'evt_run_compact_6', sequence: 7, role: 'user', tokenCount: 10 });

    const contextItems = [
      createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(system.id),
      }),
      createContextItem({
        conversationId,
        position: 1,
        ref: createMessageContextItemRef(first.id),
      }),
      createContextItem({
        conversationId,
        position: 2,
        ref: createMessageContextItemRef(second.id),
      }),
      createContextItem({
        conversationId,
        position: 3,
        ref: createMessageContextItemRef(third.id),
      }),
      createContextItem({
        conversationId,
        position: 4,
        ref: createMessageContextItemRef(tailA.id),
      }),
      createContextItem({
        conversationId,
        position: 5,
        ref: createMessageContextItemRef(tailB.id),
      }),
      createContextItem({
        conversationId,
        position: 6,
        ref: createMessageContextItemRef(tailC.id),
      }),
    ];

    const state = createState({
      events: [system, first, second, third, tailA, tailB, tailC],
      contextItems,
    });

    const summarizer = new TestSummarizer([
      {
        content: '[Summary] first-two-messages',
        tokenCount: 8,
      },
    ]);

    const { useCase, contextControls, dagControls } = createUseCase({ state, summarizer });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    expect(output.rounds).toBe(1);
    expect(output.nodesCreated).toHaveLength(1);
    expect(output.tokensFreed).toEqual(createTokenCount(12));
    expect(output.converged).toBe(true);

    expect(contextControls.replaceCalls).toEqual([
      {
        expectedVersion: createContextVersion(0),
        positionsToRemove: [1, 2],
        replacementPosition: 1,
      },
    ]);

    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0]?.messages).toEqual([
      { role: 'user', content: 'evt_run_compact_1' },
      { role: 'assistant', content: 'evt_run_compact_2' },
    ]);

    expect(dagControls.createNodeCalls).toHaveLength(1);
    expect(dagControls.createNodeCalls[0]?.kind).toBe('leaf');
    expect(dagControls.leafEdgeCalls).toEqual([
      {
        summaryId: output.nodesCreated[0] as SummaryNodeId,
        messageIds: [first.id, second.id],
      },
    ]);
    expect(dagControls.condensedEdgeCalls).toHaveLength(0);
  });

  it('escalates to deterministic fallback when normal and aggressive outputs do not shrink', async () => {
    const one = createEventForTest({
      id: 'evt_escalate_1',
      sequence: 1,
      tokenCount: 15,
      content: 'A'.repeat(80),
    });
    const two = createEventForTest({
      id: 'evt_escalate_2',
      sequence: 2,
      tokenCount: 15,
      content: 'B'.repeat(80),
    });
    const three = createEventForTest({
      id: 'evt_escalate_3',
      sequence: 3,
      tokenCount: 15,
      content: 'C'.repeat(80),
    });
    const four = createEventForTest({
      id: 'evt_escalate_4',
      sequence: 4,
      tokenCount: 15,
      content: 'D'.repeat(80),
    });
    const five = createEventForTest({
      id: 'evt_escalate_5',
      sequence: 5,
      tokenCount: 15,
      content: 'E'.repeat(80),
    });

    const state = createState({
      events: [one, two, three, four, five],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(one.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(two.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(three.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(four.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(five.id) }),
      ],
    });

    const summarizer = new TestSummarizer(
      [
        {
          content: '[Summary] not smaller',
          tokenCount: 30,
        },
      ],
      [
        {
          content: '[Aggressive Summary] still not smaller',
          tokenCount: 30,
        },
      ],
    );

    const { useCase, dagControls } = createUseCase({
      state,
      summarizer,
      config: {
        deterministicFallbackMaxTokens: 6,
      },
    });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    expect(output.rounds).toBe(1);
    expect(summarizer.calls.map((call) => call.mode)).toEqual(['normal', 'aggressive']);
    expect(summarizer.calls[1]?.targetTokens).toBe(15);

    const node = dagControls.createNodeCalls[0];
    expect(node).toBeDefined();
    expect(node?.tokenCount.value).toBeLessThanOrEqual(6);
    expect(node?.content).not.toBe('[Summary] not smaller');
    expect(node?.content).not.toBe('[Aggressive Summary] still not smaller');
  });

  it('throws typed tokenizer invalid-output error and aborts compaction when deterministic fallback token counting is invalid', async () => {
    const one = createEventForTest({
      id: 'evt_escalate_1',
      sequence: 1,
      tokenCount: 15,
      content: 'A'.repeat(80),
    });
    const two = createEventForTest({
      id: 'evt_escalate_2',
      sequence: 2,
      tokenCount: 15,
      content: 'B'.repeat(80),
    });
    const three = createEventForTest({
      id: 'evt_escalate_3',
      sequence: 3,
      tokenCount: 15,
      content: 'C'.repeat(80),
    });
    const four = createEventForTest({
      id: 'evt_escalate_4',
      sequence: 4,
      tokenCount: 15,
      content: 'D'.repeat(80),
    });
    const five = createEventForTest({
      id: 'evt_escalate_5',
      sequence: 5,
      tokenCount: 15,
      content: 'E'.repeat(80),
    });

    const state = createState({
      events: [one, two, three, four, five],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(one.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(two.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(three.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(four.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(five.id) }),
      ],
    });

    const summarizer = new TestSummarizer(
      [
        {
          content: '[Summary] not smaller',
          tokenCount: 30,
        },
      ],
      [
        {
          content: '[Aggressive Summary] still not smaller',
          tokenCount: 30,
        },
      ],
    );

    const { useCase, dagControls, contextControls, state: finalState } = createUseCase({
      state,
      summarizer,
      tokenizer: new InvalidOutputTokenizer(),
      config: {
        deterministicFallbackMaxTokens: 6,
      },
    });

    const execution = useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidTokenizerOutputError);
    await expect(execution).rejects.toMatchObject({
      code: 'TOKENIZER_OUTPUT_INVALID',
      operation: 'countTokens',
    });

    expect(summarizer.calls.map((call) => call.mode)).toEqual(['normal', 'aggressive']);
    expect(summarizer.calls[1]?.targetTokens).toBe(15);
    expect(dagControls.createNodeCalls).toHaveLength(0);
    expect(contextControls.replaceCalls).toHaveLength(0);
    expect(finalState.contextItems).toHaveLength(5);
    expect(finalState.summaries.size).toBe(0);
  });

  it('retries a compaction round after stale context version conflict', async () => {
    const system = createEventForTest({ id: 'evt_stale_0', sequence: 1, role: 'system', tokenCount: 5 });
    const first = createEventForTest({ id: 'evt_stale_1', sequence: 2, tokenCount: 10 });
    const second = createEventForTest({ id: 'evt_stale_2', sequence: 3, tokenCount: 10, role: 'assistant' });
    const third = createEventForTest({ id: 'evt_stale_3', sequence: 4, tokenCount: 10 });
    const tailA = createEventForTest({ id: 'evt_stale_4', sequence: 5, tokenCount: 10 });
    const tailB = createEventForTest({ id: 'evt_stale_5', sequence: 6, tokenCount: 10 });
    const tailC = createEventForTest({ id: 'evt_stale_6', sequence: 7, tokenCount: 10 });

    const state = createState({
      events: [system, first, second, third, tailA, tailB, tailC],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(system.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(first.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(second.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(third.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(tailA.id) }),
        createContextItem({ conversationId, position: 5, ref: createMessageContextItemRef(tailB.id) }),
        createContextItem({ conversationId, position: 6, ref: createMessageContextItemRef(tailC.id) }),
      ],
      contextVersion: createContextVersion(0),
    });

    const summarizer = new TestSummarizer([
      { content: '[Summary] stale retry first', tokenCount: 8 },
      { content: '[Summary] stale retry second', tokenCount: 8 },
    ]);

    const { useCase, contextControls } = createUseCase({
      state,
      summarizer,
      staleFailures: 1,
    });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    expect(contextControls.replaceCalls).toHaveLength(2);
    expect(output.rounds).toBe(1);
    expect(output.nodesCreated).toHaveLength(1);
    expect(state.contextVersion).toBe(createContextVersion(1));
  });

  it('stops at maxRounds and reports non-converged for soft trigger', async () => {
    const system = createEventForTest({ id: 'evt_max_rounds_0', sequence: 1, role: 'system', tokenCount: 5 });
    const one = createEventForTest({ id: 'evt_max_rounds_1', sequence: 2, tokenCount: 10 });
    const two = createEventForTest({ id: 'evt_max_rounds_2', sequence: 3, tokenCount: 10, role: 'assistant' });
    const three = createEventForTest({ id: 'evt_max_rounds_3', sequence: 4, tokenCount: 10 });
    const tailA = createEventForTest({ id: 'evt_max_rounds_4', sequence: 5, tokenCount: 10 });
    const tailB = createEventForTest({ id: 'evt_max_rounds_5', sequence: 6, tokenCount: 10 });
    const tailC = createEventForTest({ id: 'evt_max_rounds_6', sequence: 7, tokenCount: 10 });

    const state = createState({
      events: [system, one, two, three, tailA, tailB, tailC],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(system.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(one.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(two.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(three.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(tailA.id) }),
        createContextItem({ conversationId, position: 5, ref: createMessageContextItemRef(tailB.id) }),
        createContextItem({ conversationId, position: 6, ref: createMessageContextItemRef(tailC.id) }),
      ],
    });

    const { useCase, contextControls, summarizer } = createUseCase({
      state,
      summarizer: new TestSummarizer([{ content: '[Summary] round-1', tokenCount: 8 }]),
      config: { maxRounds: 1 },
    });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(20),
    });

    expect(output.rounds).toBe(1);
    expect(output.nodesCreated).toHaveLength(1);
    expect(output.converged).toBe(false);
    expect(contextControls.replaceCalls).toHaveLength(1);
    expect(summarizer.calls).toHaveLength(1);
  });

  it('emits SummaryNodeCreated for each successful compaction round', async () => {
    const system = createEventForTest({ id: 'evt_summary_event_0', sequence: 1, role: 'system', tokenCount: 5 });
    const one = createEventForTest({ id: 'evt_summary_event_1', sequence: 2, tokenCount: 10 });
    const two = createEventForTest({ id: 'evt_summary_event_2', sequence: 3, tokenCount: 10, role: 'assistant' });
    const three = createEventForTest({ id: 'evt_summary_event_3', sequence: 4, tokenCount: 10 });
    const tailA = createEventForTest({ id: 'evt_summary_event_4', sequence: 5, tokenCount: 10 });
    const tailB = createEventForTest({ id: 'evt_summary_event_5', sequence: 6, tokenCount: 10 });
    const tailC = createEventForTest({ id: 'evt_summary_event_6', sequence: 7, tokenCount: 10 });

    const state = createState({
      events: [system, one, two, three, tailA, tailB, tailC],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(system.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(one.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(two.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(three.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(tailA.id) }),
        createContextItem({ conversationId, position: 5, ref: createMessageContextItemRef(tailB.id) }),
        createContextItem({ conversationId, position: 6, ref: createMessageContextItemRef(tailC.id) }),
      ],
    });

    const eventPublisher = new SpyEventPublisher();
    const { useCase } = createUseCase({
      state,
      summarizer: new TestSummarizer([{ content: '[Summary] round-1', tokenCount: 8 }]),
      config: { maxRounds: 1 },
      eventPublisher,
    });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(20),
    });

    const summaryNodeCreatedEvents = eventPublisher.events.filter(
      (
        event,
      ): event is Extract<DomainEvent, { type: 'SummaryNodeCreated' }> => event.type === 'SummaryNodeCreated',
    );

    expect(summaryNodeCreatedEvents).toHaveLength(output.rounds);
    expect(summaryNodeCreatedEvents[0]).toMatchObject({
      type: 'SummaryNodeCreated',
      conversationId,
      nodeId: output.nodesCreated[0],
      kind: 'leaf',
      level: 1,
      inputTokens: createTokenCount(20),
      outputTokens: createTokenCount(8),
      coveredItemCount: 2,
    });
    expect(eventPublisher.events.map((event) => event.type)).toEqual([
      'SummaryNodeCreated',
      'CompactionCompleted',
    ]);
  });

  it('throws typed hard-trigger failure when context remains above available budget', async () => {
    const system = createEventForTest({ id: 'evt_hard_0', sequence: 1, role: 'system', tokenCount: 30 });
    const one = createEventForTest({ id: 'evt_hard_1', sequence: 2, tokenCount: 30 });
    const two = createEventForTest({ id: 'evt_hard_2', sequence: 3, tokenCount: 30 });

    const state = createState({
      events: [system, one, two],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(system.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(one.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(two.id) }),
      ],
    });

    const summarizer = new TestSummarizer([]);
    const { useCase, contextControls } = createUseCase({ state, summarizer });

    const execution = useCase.execute({
      conversationId,
      trigger: 'hard',
    });

    await expect(execution).rejects.toBeInstanceOf(CompactionFailedToConvergeError);
    await expect(execution).rejects.toMatchObject({
      code: 'COMPACTION_FAILED_TO_CONVERGE',
      conversationId,
      rounds: 0,
      currentTokens: { value: 90 },
      availableBudget: { value: 75 },
    });

    expect(summarizer.calls).toHaveLength(0);
    expect(contextControls.replaceCalls).toHaveLength(0);
  });

  it('preserves artifact IDs from source metadata and summarizer output', async () => {
    const artifactA = createEventForTest({
      id: 'evt_artifacts_1',
      sequence: 1,
      tokenCount: 10,
      metadata: {
        artifactId: 'file_a',
      },
    });
    const artifactB = createEventForTest({
      id: 'evt_artifacts_2',
      sequence: 2,
      tokenCount: 10,
      metadata: {
        artifact_ids: ['file_b', 'file_a'],
        artifacts: [{ id: 'file_c' }],
      },
    });
    const extra1 = createEventForTest({ id: 'evt_artifacts_3', sequence: 3, tokenCount: 10 });
    const extra2 = createEventForTest({ id: 'evt_artifacts_4', sequence: 4, tokenCount: 10 });
    const extra3 = createEventForTest({ id: 'evt_artifacts_5', sequence: 5, tokenCount: 10 });
    const extra4 = createEventForTest({ id: 'evt_artifacts_6', sequence: 6, tokenCount: 10 });
    const extra5 = createEventForTest({ id: 'evt_artifacts_7', sequence: 7, tokenCount: 10 });

    const state = createState({
      events: [artifactA, artifactB, extra1, extra2, extra3, extra4, extra5],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(artifactA.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(artifactB.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(extra1.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(extra2.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(extra3.id) }),
        createContextItem({ conversationId, position: 5, ref: createMessageContextItemRef(extra4.id) }),
        createContextItem({ conversationId, position: 6, ref: createMessageContextItemRef(extra5.id) }),
      ],
    });

    const summarizer = new TestSummarizer([
      {
        content: '[Summary] artifacts preserved',
        tokenCount: 6,
        preservedArtifactIds: [createArtifactId('file_c'), createArtifactId('file_d')],
      },
    ]);

    const { useCase, dagControls } = createUseCase({ state, summarizer });

    await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    const created = dagControls.createNodeCalls[0];
    expect(created).toBeDefined();
    expect(created?.artifactIds).toEqual([
      createArtifactId('file_a'),
      createArtifactId('file_b'),
      createArtifactId('file_c'),
      createArtifactId('file_d'),
    ]);
  });

  it('creates condensed summaries and parent edges when candidate contains only summaries', async () => {
    const summary1 = createSummaryForTest({ id: 'sum_condense_1', tokenCount: 16 });
    const summary2 = createSummaryForTest({ id: 'sum_condense_2', tokenCount: 16 });
    const summary3 = createSummaryForTest({ id: 'sum_condense_3', tokenCount: 16 });
    const summary4 = createSummaryForTest({ id: 'sum_condense_4', tokenCount: 16 });
    const summary5 = createSummaryForTest({ id: 'sum_condense_5', tokenCount: 16 });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summary1.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createSummaryContextItemRef(summary2.id),
        }),
        createContextItem({
          conversationId,
          position: 2,
          ref: createSummaryContextItemRef(summary3.id),
        }),
        createContextItem({
          conversationId,
          position: 3,
          ref: createSummaryContextItemRef(summary4.id),
        }),
        createContextItem({
          conversationId,
          position: 4,
          ref: createSummaryContextItemRef(summary5.id),
        }),
      ],
      summaries: [summary1, summary2, summary3, summary4, summary5],
    });

    const summarizer = new TestSummarizer([
      {
        content: '[Condensed] first two summaries',
        tokenCount: 10,
      },
    ]);

    const { useCase, dagControls } = createUseCase({ state, summarizer });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    expect(output.rounds).toBe(1);
    expect(dagControls.createNodeCalls[0]?.kind).toBe('condensed');
    expect(dagControls.leafEdgeCalls).toHaveLength(0);
    expect(dagControls.condensedEdgeCalls).toEqual([
      {
        summaryId: output.nodesCreated[0] as SummaryNodeId,
        parentSummaryIds: [summary1.id, summary2.id],
      },
    ]);
  });

  it('expands summary references when building leaf edges for mixed message + summary candidates', async () => {
    const system = createEventForTest({ id: 'evt_mix_0', sequence: 1, role: 'system', tokenCount: 5 });
    const direct = createEventForTest({ id: 'evt_mix_direct', sequence: 5, tokenCount: 12 });
    const other = createEventForTest({ id: 'evt_mix_other', sequence: 6, tokenCount: 12 });
    const tailA = createEventForTest({ id: 'evt_mix_tail_a', sequence: 7, tokenCount: 12 });
    const tailB = createEventForTest({ id: 'evt_mix_tail_b', sequence: 8, tokenCount: 12 });
    const tailC = createEventForTest({ id: 'evt_mix_tail_c', sequence: 9, tokenCount: 12 });

    const parentSummary = createSummaryForTest({
      id: 'sum_mix_parent',
      tokenCount: 10,
      content: '[Summary] parent',
    });

    const expandedEarly = createEventForTest({
      id: 'evt_mix_early',
      sequence: 2,
      tokenCount: 3,
      content: 'expanded early',
    });
    const expandedDirectOlderSequence = createLedgerEvent({
      id: direct.id,
      conversationId,
      sequence: createSequenceNumber(4),
      role: direct.role,
      content: direct.content,
      tokenCount: direct.tokenCount,
      occurredAt: createTimestamp(new Date('2026-01-01T00:00:04.000Z')),
      metadata: {},
    });

    const state = createState({
      events: [system, direct, other, tailA, tailB, tailC],
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(system.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(direct.id) }),
        createContextItem({
          conversationId,
          position: 2,
          ref: createSummaryContextItemRef(parentSummary.id),
        }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(other.id) }),
        createContextItem({ conversationId, position: 4, ref: createMessageContextItemRef(tailA.id) }),
        createContextItem({ conversationId, position: 5, ref: createMessageContextItemRef(tailB.id) }),
        createContextItem({ conversationId, position: 6, ref: createMessageContextItemRef(tailC.id) }),
      ],
      summaries: [parentSummary],
    });

    const summarizer = new TestSummarizer([
      {
        content: '[Summary] mixed block',
        tokenCount: 8,
      },
    ]);

    const { useCase, dagControls } = createUseCase({
      state,
      summarizer,
      expandedMessagesBySummaryId: new Map([
        [parentSummary.id, [expandedEarly, expandedDirectOlderSequence]],
      ]),
    });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    expect(dagControls.createNodeCalls[0]?.kind).toBe('leaf');
    expect(dagControls.expandCalls).toEqual([parentSummary.id]);
    expect(dagControls.leafEdgeCalls).toEqual([
      {
        summaryId: output.nodesCreated[0] as SummaryNodeId,
        messageIds: [expandedEarly.id, direct.id],
      },
    ]);
  });

  it('emits CompactionCompleted domain event when eventPublisher is provided', async () => {
    const events = [
      createEventForTest({ id: 'evt_event_pub_1', sequence: 1, role: 'user', tokenCount: 10 }),
      createEventForTest({ id: 'evt_event_pub_2', sequence: 2, role: 'assistant', tokenCount: 10 }),
      createEventForTest({ id: 'evt_event_pub_3', sequence: 3, role: 'user', tokenCount: 10 }),
      createEventForTest({ id: 'evt_event_pub_4', sequence: 4, role: 'user', tokenCount: 10 }),
      createEventForTest({ id: 'evt_event_pub_5', sequence: 5, role: 'assistant', tokenCount: 10 }),
      createEventForTest({ id: 'evt_event_pub_6', sequence: 6, role: 'user', tokenCount: 10 }),
    ];

    const contextItems = events.map((event, index) =>
      createContextItem({
        conversationId,
        position: index,
        ref: createMessageContextItemRef(event.id),
      }),
    );

    const state = createState({
      conversation: createConversationForTest({ contextWindow: 100 }),
      events,
      contextItems,
    });

    const eventPublisher = new SpyEventPublisher();
    const { useCase } = createUseCase({
      state,
      summarizer: new TestSummarizer([{ content: '[Summary] compacted', tokenCount: 8 }]),
      eventPublisher,
    });

    const output = await useCase.execute({
      conversationId,
      trigger: 'soft',
    });

    expect(eventPublisher.events).toHaveLength(1);
    expect(eventPublisher.events[0]).toMatchObject({
      type: 'CompactionCompleted',
      conversationId,
      rounds: output.rounds,
      converged: output.converged,
    });
  });
});
