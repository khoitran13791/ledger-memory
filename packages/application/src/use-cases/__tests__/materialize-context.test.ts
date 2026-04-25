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
  LedgerEvent,
  SummaryNode,
} from '@ledgermind/domain';
import {
  createArtifact,
  createArtifactId,
  createCompactionThresholds,
  createContextItem,
  createContextVersion,
  createConversation,
  createConversationConfig,
  createConversationId,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createMimeType,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import { InvalidReferenceError } from '../../errors/application-errors';
import type { EventPublisherPort } from '../../ports/driven/events/event-publisher.port';
import type { TokenizerPort } from '../../ports/driven/llm/tokenizer.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerReadPort } from '../../ports/driven/persistence/ledger-read.port';
import type { SummaryDagPort, IntegrityReport } from '../../ports/driven/persistence/summary-dag.port';
import type { RunCompactionInput, RunCompactionOutput } from '../../ports/driving/memory-engine.port';
import {
  MaterializeContextBudgetExceededError,
  MaterializeContextUseCase,
  type MaterializeContextUseCaseDeps,
} from '../materialize-context';

const conversationId = createConversationId('conv_materialize_uc');
const messageEventId = createEventId('evt_materialize_message_1');
const summaryId = createSummaryNodeId('sum_materialize_1');
const artifactId = createArtifactId('file_materialize_1');

const createTestConversation = (
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

const createTestMessage = (input?: {
  readonly id?: EventId;
  readonly content?: string;
  readonly tokenCount?: number;
  readonly role?: LedgerEvent['role'];
  readonly sequence?: number;
}): LedgerEvent => {
  return createLedgerEvent({
    id: input?.id ?? messageEventId,
    conversationId,
    sequence: createSequenceNumber(input?.sequence ?? 1),
    role: input?.role ?? 'user',
    content: input?.content ?? 'message-content',
    tokenCount: createTokenCount(input?.tokenCount ?? 12),
    occurredAt: createTimestamp(new Date('2026-01-01T00:00:01.000Z')),
    metadata: {},
  });
};

const createTestSummary = (input?: {
  readonly id?: SummaryNode['id'];
  readonly content?: string;
  readonly retrievalText?: string;
  readonly tokenCount?: number;
  readonly artifactIds?: readonly ArtifactId[];
}): SummaryNode => {
  return createSummaryNode({
    id: input?.id ?? summaryId,
    conversationId,
    kind: 'leaf',
    content: input?.content ?? '[Summary] summary-content',
    ...(input?.retrievalText === undefined ? {} : { retrievalText: input.retrievalText }),
    tokenCount: createTokenCount(input?.tokenCount ?? 10),
    ...(input?.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
    createdAt: createTimestamp(new Date('2026-01-01T00:00:02.000Z')),
  });
};

const createTestArtifact = (input?: {
  readonly id?: ArtifactId;
  readonly tokenCount?: number;
  readonly storageKind?: Artifact['storageKind'];
  readonly originalPath?: string | null;
  readonly explorationSummary?: string | null;
}): Artifact => {
  return createArtifact({
    id: input?.id ?? artifactId,
    conversationId,
    storageKind: input?.storageKind ?? 'inline_text',
    ...(input?.originalPath === undefined ? {} : { originalPath: input.originalPath }),
    mimeType: createMimeType('application/json'),
    tokenCount: createTokenCount(input?.tokenCount ?? 20),
    explorationSummary: input?.explorationSummary ?? null,
    explorerUsed: null,
  });
};

type TestState = {
  conversation: Conversation | null;
  contextItems: ContextItem[];
  contextVersion: ContextVersion;
  events: LedgerEvent[];
  summaries: Map<SummaryNode['id'], SummaryNode>;
  expandedSummaryMessages: Map<SummaryNode['id'], readonly LedgerEvent[]>;
  summarySearchResults: Map<string, readonly SummaryNode[]>;
  searchQueries: Array<{ readonly query: string; readonly scope?: SummaryNode['id'] }>;
  eventSearchResults: Map<string, readonly LedgerEvent[]>;
  eventSearchQueries: Array<{ readonly query: string; readonly scope?: SummaryNode['id'] }>;
  artifacts: Map<ArtifactId, Artifact>;
  contextTokenCount: number;
};

class TestConversationPort implements ConversationPort {
  constructor(private readonly state: TestState) {}

  async create(config: ConversationConfig): Promise<Conversation> {
    const created = createConversation({
      id: createConversationId('conv_created_materialize_uc'),
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

class TestContextProjectionPort implements ContextProjectionPort {
  constructor(private readonly state: TestState) {}

  async getCurrentContext(): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ContextVersion;
  }> {
    return {
      items: [...this.state.contextItems],
      version: this.state.contextVersion,
    };
  }

  async getContextTokenCount(): Promise<ReturnType<typeof createTokenCount>> {
    return createTokenCount(this.state.contextTokenCount);
  }

  async appendContextItems(): Promise<ContextVersion> {
    throw new Error('appendContextItems not needed in this test suite');
  }

  async replaceContextItems(): Promise<ContextVersion> {
    throw new Error('replaceContextItems not needed in this test suite');
  }
}

class TestLedgerReadPort implements LedgerReadPort {
  constructor(private readonly state: TestState) {}

  async getEvents(): Promise<readonly LedgerEvent[]> {
    return [...this.state.events];
  }

  async searchEvents(
    conversationIdInput: ConversationId,
    query: string,
    scope?: SummaryNode['id'],
  ): Promise<readonly LedgerEvent[]> {
    void conversationIdInput;
    this.state.eventSearchQueries.push({
      query,
      ...(scope === undefined ? {} : { scope }),
    });
    return this.state.eventSearchResults.get(query) ?? [];
  }

  async regexSearchEvents(
    conversationIdInput: ConversationId,
    pattern: string,
    page?: {
      readonly scope?: SummaryNode['id'];
      readonly offset: number;
      readonly limit: number;
    },
  ) {
    void conversationIdInput;
    void pattern;
    void page;
    return {
      matches: [],
      totalMatchCount: 0,
    };
  }
}

class TestSummaryDagPort implements SummaryDagPort {
  constructor(private readonly state: TestState) {}

  async createNode(node: SummaryNode): Promise<void> {
    this.state.summaries.set(node.id, node);
  }

  async getNode(id: SummaryNode['id']): Promise<SummaryNode | null> {
    return this.state.summaries.get(id) ?? null;
  }

  async addLeafEdges(): Promise<void> {
    return;
  }

  async addCondensedEdges(): Promise<void> {
    return;
  }

  async getParentSummaryIds(): Promise<readonly SummaryNode['id'][]> {
    return [];
  }

  async expandToMessages(id: SummaryNode['id']): Promise<readonly LedgerEvent[]> {
    return [...(this.state.expandedSummaryMessages.get(id) ?? [])];
  }

  async searchSummaries(
    conversationIdInput: ConversationId,
    query: string,
    scope?: SummaryNode['id'],
  ): Promise<readonly SummaryNode[]> {
    void conversationIdInput;
    this.state.searchQueries.push({
      query,
      ...(scope === undefined ? {} : { scope }),
    });
    return this.state.summarySearchResults.get(query) ?? [];
  }

  async checkIntegrity(conversationIdInput: ConversationId): Promise<IntegrityReport> {
    void conversationIdInput;
    return { passed: true, checks: [] };
  }
}

class TestArtifactStorePort implements ArtifactStorePort {
  constructor(private readonly state: TestState) {}

  async store(artifact: Artifact): Promise<boolean> {
    this.state.artifacts.set(artifact.id, artifact);
    return true;
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    return this.state.artifacts.get(id) ?? null;
  }

  async getContent(): Promise<string | Uint8Array | null> {
    return null;
  }

  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void> {
    const current = this.state.artifacts.get(id);
    if (!current) {
      throw new Error(`Unknown artifact: ${id}`);
    }

    this.state.artifacts.set(
      id,
      createArtifact({
        ...current,
        explorationSummary: summary,
        explorerUsed,
      }),
    );
  }
}

class TestRunCompaction {
  readonly calls: RunCompactionInput[] = [];

  constructor(private readonly result: RunCompactionOutput) {}

  async execute(input: RunCompactionInput): Promise<RunCompactionOutput> {
    this.calls.push(input);
    return this.result;
  }
}

class TestTokenizer implements TokenizerPort {
  countTokens(text: string) {
    return createTokenCount(Math.max(1, Math.ceil(text.length / 4)));
  }

  estimateFromBytes(byteLength: number) {
    return createTokenCount(Math.max(1, Math.ceil(byteLength / 4)));
  }
}

class SpyEventPublisher implements EventPublisherPort {
  readonly events: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.events.push(event);
  }
}

const createState = (input?: {
  readonly conversation?: Conversation | null;
  readonly contextItems?: readonly ContextItem[];
  readonly events?: readonly LedgerEvent[];
  readonly summaries?: readonly SummaryNode[];
  readonly expandedSummaryMessages?: Readonly<Record<string, readonly LedgerEvent[]>>;
  readonly summarySearchResults?: Readonly<Record<string, readonly SummaryNode[]>>;
  readonly eventSearchResults?: Readonly<Record<string, readonly LedgerEvent[]>>;
  readonly artifacts?: readonly Artifact[];
  readonly contextTokenCount?: number;
}): TestState => {
  return {
    conversation: input?.conversation ?? createTestConversation(),
    contextItems: [...(input?.contextItems ?? [])],
    contextVersion: createContextVersion(0),
    events: [...(input?.events ?? [])],
    summaries: new Map((input?.summaries ?? []).map((summary) => [summary.id, summary] as const)),
    expandedSummaryMessages: new Map(
      Object.entries(input?.expandedSummaryMessages ?? {}).map(
        ([summaryId, events]) => [summaryId as SummaryNode['id'], [...events]] as const,
      ),
    ),
    summarySearchResults: new Map(
      Object.entries(input?.summarySearchResults ?? {}).map(([query, summaries]) => [query, [...summaries]] as const),
    ),
    eventSearchResults: new Map(
      Object.entries(input?.eventSearchResults ?? {}).map(([query, events]) => [query, [...events]] as const),
    ),
    artifacts: new Map((input?.artifacts ?? []).map((artifact) => [artifact.id, artifact] as const)),
    searchQueries: [],
    eventSearchQueries: [],
    contextTokenCount: input?.contextTokenCount ?? 0,
  };
};

const createUseCase = (input?: {
  readonly state?: TestState;
  readonly runCompactionResult?: RunCompactionOutput;
  readonly eventPublisher?: SpyEventPublisher;
}) => {
  const state = input?.state ?? createState();
  const runCompaction = new TestRunCompaction(
    input?.runCompactionResult ?? {
      rounds: 0,
      nodesCreated: [],
      tokensFreed: createTokenCount(0),
      converged: true,
    },
  );

  const deps: MaterializeContextUseCaseDeps = {
    conversations: new TestConversationPort(state),
    contextProjection: new TestContextProjectionPort(state),
    summaryDag: new TestSummaryDagPort(state),
    ledgerRead: new TestLedgerReadPort(state),
    artifactStore: new TestArtifactStorePort(state),
    tokenizer: new TestTokenizer(),
    runCompaction: (compactionInput) => runCompaction.execute(compactionInput),
    ...(input?.eventPublisher === undefined ? {} : { eventPublisher: input.eventPublisher }),
  };

  return {
    state,
    runCompaction,
    useCase: new MaterializeContextUseCase(deps),
  };
};

describe('MaterializeContextUseCase', () => {
  it('materializes model-ready messages with summary and artifact references within budget', async () => {
    const message = createTestMessage({
      id: createEventId('evt_materialize_message_2'),
      content: 'raw-message',
      tokenCount: 12,
      role: 'user',
      sequence: 1,
    });

    const summary = createTestSummary({
      id: createSummaryNodeId('sum_materialize_2'),
      content: '[Summary] compacted-context',
      tokenCount: 10,
      artifactIds: [artifactId],
    });

    const artifact = createTestArtifact();

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createSummaryContextItemRef(summary.id),
        }),
      ],
      events: [message],
      summaries: [summary],
      artifacts: [artifact],
      contextTokenCount: 22,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 10,
    });

    expect(output.systemPreamble).toContain('You have access to memory tools');
    expect(output.systemPreamble).toContain(`Available summaries: ${summary.id}.`);
    expect(output.systemPreamble).toContain(`Available artifacts: ${artifact.id}.`);
    expect(output.modelMessages).toEqual([
      { role: 'user', content: 'raw-message' },
      { role: 'assistant', content: `[Summary ID: ${summary.id}]\n[Summary] compacted-context` },
    ]);
    expect(output.summaryReferences).toEqual([
      {
        id: summary.id,
        kind: summary.kind,
        tokenCount: summary.tokenCount,
      },
    ]);
    expect(output.artifactReferences).toEqual([
      {
        id: artifact.id,
        mimeType: artifact.mimeType,
        tokenCount: artifact.tokenCount,
      },
    ]);
    expect(output.budgetUsed.value).toBe(22);
    expect(output.retrievalMatchCount).toBe(0);
    expect(output.retrievalAddedCount).toBe(0);
    expect(output.compactionTriggered).toBe(false);
    expect(output.trimmedToFit).toBe(false);
    expect(output.droppedMessageCount).toBe(0);
    expect(output.droppedSummaryCount).toBe(0);
  });

  it('includes artifact preview metadata in references and system preamble', async () => {
    const summary = createTestSummary({
      id: createSummaryNodeId('sum_materialize_artifact_preview'),
      content: '[Summary] compacted-with-artifact-preview',
      tokenCount: 9,
      artifactIds: [artifactId],
    });
    const artifact = createTestArtifact({
      storageKind: 'path',
      originalPath: '/workspace/docs/specs/large-file.md',
      explorationSummary:
        'Large-file contract notes describing parser boundaries, token budget assumptions, and fallback behavior when previews are missing from context.',
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summary.id),
        }),
      ],
      summaries: [summary],
      artifacts: [artifact],
      contextTokenCount: 9,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 30,
      overheadTokens: 0,
    });

    expect(output.artifactReferences).toEqual([
      {
        id: artifact.id,
        mimeType: artifact.mimeType,
        tokenCount: artifact.tokenCount,
        originalPath: '/workspace/docs/specs/large-file.md',
        explorationSummary:
          'Large-file contract notes describing parser boundaries, token budget assumptions, and fallback behavior when previews are missing from context.',
      },
    ]);
    expect(output.systemPreamble).toContain(
      `Available artifacts: ${artifact.id} (/workspace/docs/specs/large-file.md) - `,
    );
    expect(output.systemPreamble).toContain('Large-file contract notes describing parser boundaries');
  });

  it('renders normalized deterministic teaser for long irregular-whitespace exploration summaries', async () => {
    const summary = createTestSummary({
      id: createSummaryNodeId('sum_materialize_artifact_teaser'),
      content: '[Summary] compacted-with-long-artifact-preview',
      tokenCount: 9,
      artifactIds: [artifactId],
    });
    const artifact = createTestArtifact({
      storageKind: 'path',
      originalPath: '/workspace/docs/specs/teaser-target.md',
      explorationSummary:
        '  Alpha   beta\n\ngamma\t delta   epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega 1234567890 repeated    marker   for    truncation   behavior   check  ',
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summary.id),
        }),
      ],
      summaries: [summary],
      artifacts: [artifact],
      contextTokenCount: 9,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 30,
      overheadTokens: 0,
    });

    expect(output.systemPreamble).toContain(
      `Available artifacts: ${artifact.id} (/workspace/docs/specs/teaser-target.md) - Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega 1234567890 re....`,
    );
  });

  it('shows only the first four formatted artifact previews and reports omitted count', async () => {
    const artifactId1 = createArtifactId('file_materialize_cap_1');
    const artifactId2 = createArtifactId('file_materialize_cap_2');
    const artifactId3 = createArtifactId('file_materialize_cap_3');
    const artifactId4 = createArtifactId('file_materialize_cap_4');
    const artifactId5 = createArtifactId('file_materialize_cap_5');

    const summary = createTestSummary({
      id: createSummaryNodeId('sum_materialize_artifact_cap'),
      content: '[Summary] compacted-with-many-artifacts',
      tokenCount: 12,
      artifactIds: [artifactId1, artifactId2, artifactId3, artifactId4, artifactId5],
    });

    const artifacts = [
      createTestArtifact({
        id: artifactId1,
        storageKind: 'path',
        originalPath: '/workspace/artifacts/first.md',
        explorationSummary: 'first artifact preview',
      }),
      createTestArtifact({
        id: artifactId2,
        storageKind: 'path',
        originalPath: '/workspace/artifacts/second.md',
      }),
      createTestArtifact({
        id: artifactId3,
      }),
      createTestArtifact({
        id: artifactId4,
        storageKind: 'path',
        originalPath: '/workspace/artifacts/fourth.md',
        explorationSummary: '   \n\t  ',
      }),
      createTestArtifact({
        id: artifactId5,
        storageKind: 'path',
        originalPath: '/workspace/artifacts/fifth.md',
        explorationSummary: 'fifth artifact preview',
      }),
    ];

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summary.id),
        }),
      ],
      summaries: [summary],
      artifacts,
      contextTokenCount: 12,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 0,
    });

    expect(output.systemPreamble).toContain(
      'Available artifacts: file_materialize_cap_1 (/workspace/artifacts/first.md) - first artifact preview, file_materialize_cap_2 (/workspace/artifacts/second.md), file_materialize_cap_3, file_materialize_cap_4 (/workspace/artifacts/fourth.md), and 1 more.',
    );
    expect(output.systemPreamble).not.toContain('file_materialize_cap_5');
  });

  it('triggers soft compaction to fit available budget when below hard threshold', async () => {
    const state = createState({
      conversation: createTestConversation({ contextWindow: 100, hardThreshold: 0.9 }),
      contextItems: [],
      events: [],
      summaries: [],
      artifacts: [],
      contextTokenCount: 85,
    });

    const { useCase, runCompaction } = createUseCase({
      state,
      runCompactionResult: {
        rounds: 1,
        nodesCreated: [createSummaryNodeId('sum_compaction_run_1')],
        tokensFreed: createTokenCount(20),
        converged: true,
      },
    });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 90,
      overheadTokens: 10,
    });

    expect(runCompaction.calls).toHaveLength(1);
    expect(runCompaction.calls[0]).toEqual({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(80),
    });
    expect(output.compactionTriggered).toBe(true);
  });

  it('trims unpinned items to fit available budget instead of failing', async () => {
    const message1 = createTestMessage({
      id: createEventId('evt_trim_1'),
      tokenCount: 12,
      content: 'first-large-message',
      sequence: 1,
    });
    const message2 = createTestMessage({
      id: createEventId('evt_trim_2'),
      tokenCount: 12,
      content: 'second-large-message',
      sequence: 2,
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message1.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(message2.id),
        }),
      ],
      events: [message1, message2],
      contextTokenCount: 24,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 20,
      overheadTokens: 0,
    });

    expect(output.modelMessages).toHaveLength(1);
    expect(output.modelMessages[0]?.content).toBe('second-large-message');
    expect(output.budgetUsed.value).toBe(12);
    expect(output.trimmedToFit).toBe(true);
    expect(output.droppedMessageCount).toBe(1);
    expect(output.droppedSummaryCount).toBe(0);
  });

  it('prioritizes raw messages over summaries when budget pressure forces a choice', async () => {
    const message = createTestMessage({
      id: createEventId('evt_trim_message_priority'),
      tokenCount: 12,
      content: 'raw-evidence-turn',
      sequence: 1,
    });
    const summary = createTestSummary({
      id: createSummaryNodeId('sum_trim_message_priority'),
      content: '[Summary] condensed-evidence-turn',
      tokenCount: 12,
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createSummaryContextItemRef(summary.id),
        }),
      ],
      events: [message],
      summaries: [summary],
      contextTokenCount: 24,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 12,
      overheadTokens: 0,
    });

    expect(output.modelMessages).toEqual([{ role: 'user', content: 'raw-evidence-turn' }]);
    expect(output.summaryReferences).toEqual([]);
    expect(output.budgetUsed.value).toBe(12);
    expect(output.trimmedToFit).toBe(true);
    expect(output.droppedMessageCount).toBe(0);
    expect(output.droppedSummaryCount).toBe(1);
  });

  it('continues after non-converged compaction and still trims to budget', async () => {
    const message = createTestMessage({
      id: createEventId('evt_non_converged_recovery'),
      tokenCount: 12,
      content: 'recoverable-message',
      sequence: 1,
    });

    const state = createState({
      conversation: createTestConversation({ contextWindow: 100, hardThreshold: 0.8 }),
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message.id),
        }),
      ],
      events: [message],
      contextTokenCount: 95,
    });

    const { useCase, runCompaction } = createUseCase({
      state,
      runCompactionResult: {
        rounds: 10,
        nodesCreated: [],
        tokensFreed: createTokenCount(0),
        converged: false,
      },
    });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 100,
      overheadTokens: 20,
    });

    expect(runCompaction.calls).toHaveLength(1);
    expect(output.budgetUsed.value).toBeLessThanOrEqual(80);
    expect(output.compactionTriggered).toBe(true);
  });

  it('returns typed failure when pinned items alone exceed budget', async () => {
    const message = createTestMessage({
      id: createEventId('evt_pinned_over_budget'),
      tokenCount: 30,
      content: 'pinned-message',
      sequence: 1,
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message.id),
        }),
      ],
      events: [message],
      contextTokenCount: 30,
    });

    const { useCase } = createUseCase({ state });

    const execution = useCase.execute({
      conversationId,
      budgetTokens: 20,
      overheadTokens: 0,
      pinRules: [{ type: 'message', messageId: message.id }],
    });

    await expect(execution).rejects.toBeInstanceOf(MaterializeContextBudgetExceededError);
    await expect(execution).rejects.toMatchObject({
      code: 'MATERIALIZE_CONTEXT_BUDGET_EXCEEDED',
      availableBudget: 20,
      requiredBudget: 30,
    });
  });

  it('rejects unknown summary references during materialization', async () => {
    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(createSummaryNodeId('sum_unknown_materialize')),
        }),
      ],
      contextTokenCount: 5,
    });

    const { useCase } = createUseCase({ state });

    const execution = useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 5,
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary',
      referenceId: 'sum_unknown_materialize',
    });
  });

  it('injects summary ID header in summary content', async () => {
    const summary = createTestSummary({
      id: createSummaryNodeId('sum_header_test'),
      content: '[Summary] test content',
      tokenCount: 10,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createSummaryContextItemRef(summary.id) }),
      ],
      summaries: [summary],
      contextTokenCount: 10,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 50,
      overheadTokens: 0,
    });

    expect(output.modelMessages[0]!.content).toContain('[Summary ID: sum_header_test]');
    expect(output.modelMessages[0]!.content).toContain('[Summary] test content');
  });

  it('keeps pinned items while preserving chronological output order', async () => {
    const msg1 = createTestMessage({ id: createEventId('evt_pin_1'), content: 'first', tokenCount: 5, sequence: 1 });
    const msg2 = createTestMessage({ id: createEventId('evt_pin_2'), content: 'second', tokenCount: 5, sequence: 2 });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(msg1.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(msg2.id) }),
      ],
      events: [msg1, msg2],
      contextTokenCount: 10,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 50,
      overheadTokens: 0,
      pinRules: [{ type: 'message', messageId: msg2.id }],
    });

    expect(output.modelMessages[0]!.content).toBe('first');
    expect(output.modelMessages[1]!.content).toBe('second');
    expect(output.modelMessages.some((message) => message.content === 'second')).toBe(true);
  });

  it('returns empty systemPreamble when no summaries or artifacts are present', async () => {
    const message = createTestMessage({ content: 'plain-message', tokenCount: 5 });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(message.id) }),
      ],
      events: [message],
      contextTokenCount: 5,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 50,
      overheadTokens: 0,
    });

    expect(output.systemPreamble).toBe('');
  });

  it('captures staged retrieval diagnostics and ranking decisions in output', async () => {
    const primarySummary = createTestSummary({
      id: createSummaryNodeId('sum_retrieval_primary'),
      content: '[Summary] auth token rotation details',
      tokenCount: 8,
      artifactIds: [artifactId],
    });
    const keywordSummary = createTestSummary({
      id: createSummaryNodeId('sum_retrieval_keyword'),
      content: '[Summary] token key expiry reminders',
      tokenCount: 7,
    });
    const artifact = createTestArtifact();

    const state = createState({
      summaries: [primarySummary, keywordSummary],
      summarySearchResults: {
        'auth token rotation #ZX-41': [primarySummary],
        'auth token rotation': [primarySummary],
        'ZX-41': [primarySummary],
      },
      artifacts: [artifact],
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 0,
      retrievalHints: [{ query: 'auth token rotation #ZX-41', scope: primarySummary.id, limit: 1 }],
    });

    expect(output.retrievalMatchCount).toBe(3);
    expect(output.retrievalAddedCount).toBe(1);
    expect(output.retrievalAddedMessageCount).toBe(0);
    expect(output.retrievalAddedSummaryCount).toBe(1);
    expect(output.retrievalAddedCount).toBe(
      (output.retrievalAddedMessageCount ?? 0) + (output.retrievalAddedSummaryCount ?? 0),
    );
    expect(state.searchQueries).toEqual([
      { query: 'auth token rotation #ZX-41', scope: primarySummary.id },
      { query: 'auth token rotation', scope: primarySummary.id },
      { query: 'ZX-41', scope: primarySummary.id },
    ]);

    const firstHint = output.retrievalDiagnostics?.[0];
    expect(firstHint?.hintQuery).toBe('auth token rotation #ZX-41');
    expect(firstHint?.scopeSummaryId).toBe(primarySummary.id);
    expect(firstHint?.limit).toBe(1);
    expect(firstHint?.stageQueries).toEqual([
      {
        stage: 'primary',
        query: 'auth token rotation #ZX-41',
        matchCount: 1,
      },
      {
        stage: 'keywords',
        query: 'auth token rotation',
        matchCount: 1,
      },
      {
        stage: 'anchors',
        query: 'ZX-41',
        matchCount: 1,
      },
    ]);

    const firstDecision = firstHint?.candidateDecisions[0];
    expect(firstDecision?.summaryId).toBe(primarySummary.id);
    expect(firstDecision?.selected).toBe(true);
    expect(firstDecision?.reason).toBe('selected');
    expect(firstDecision?.score).toBeGreaterThan(0);

    expect(firstHint?.candidateDecisions.find((candidate) => candidate.summaryId === keywordSummary.id)).toBeUndefined();
    expect(firstHint?.messageDecisions).toEqual([]);
    expect(firstHint?.selectedSummaryIds).toEqual([primarySummary.id]);
    expect(firstHint?.selectedMessageIds).toEqual([]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([primarySummary.id]);
    expect(output.artifactReferences.map((reference) => reference.id)).toEqual([artifact.id]);
    expect(output.budgetUsed.value).toBe(8);
  });

  it('adds raw retrieval messages when summary retrieval has no match', async () => {
    const exactEvent = createTestMessage({
      id: createEventId('evt_retrieval_raw_only'),
      content: 'DATE: 1 Jan 2026 | ID: D1:7 | Alice: auth token rotation #ZX-41 happens tonight.',
      tokenCount: 18,
      role: 'assistant',
      sequence: 7,
    });

    const state = createState({
      events: [exactEvent],
      eventSearchResults: {
        'auth token rotation #ZX-41': [exactEvent],
        'auth token rotation': [exactEvent],
        'ZX-41': [exactEvent],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 48,
      overheadTokens: 0,
      retrievalHints: [{ query: 'auth token rotation #ZX-41', limit: 1 }],
    });

    expect(state.eventSearchQueries).toEqual([
      { query: 'auth token rotation #ZX-41' },
      { query: 'auth token rotation' },
      { query: 'ZX-41' },
    ]);
    expect(output.modelMessages.map((message) => message.content)).toEqual([
      'DATE: 1 Jan 2026 | ID: D1:7 | Alice: auth token rotation #ZX-41 happens tonight.',
    ]);
    expect(output.summaryReferences).toEqual([]);
    expect(output.retrievalAddedCount).toBe(1);
    expect(output.retrievalMatchCount).toBe(3);
    expect(output.retrievalDiagnostics?.[0]?.stageQueries).toEqual([
      {
        stage: 'primary',
        query: 'auth token rotation #ZX-41',
        matchCount: 1,
      },
      {
        stage: 'keywords',
        query: 'auth token rotation',
        matchCount: 1,
      },
      {
        stage: 'anchors',
        query: 'ZX-41',
        matchCount: 1,
      },
    ]);
    expect(output.budgetUsed.value).toBe(18);
  });

  it('reports raw retrieval diagnostics separately from summary diagnostics', async () => {
    const exactEvent = createTestMessage({
      id: createEventId('evt_retrieval_raw_diagnostics'),
      content: 'DATE: 1 Jan 2026 | ID: D1:9 | Alice: auth token rotation #ZX-41 happens tonight.',
      tokenCount: 18,
      role: 'assistant',
      sequence: 9,
    });
    const genericSummary = createTestSummary({
      id: createSummaryNodeId('sum_retrieval_diagnostics'),
      content: '[Summary] Alice discussed auth token rotation #ZX-41 details.',
      tokenCount: 10,
    });

    const state = createState({
      summaries: [genericSummary],
      events: [exactEvent],
      summarySearchResults: {
        'auth token rotation #ZX-41': [genericSummary],
        'auth token rotation': [genericSummary],
        'ZX-41': [genericSummary],
      },
      eventSearchResults: {
        'auth token rotation #ZX-41': [exactEvent],
        'auth token rotation': [exactEvent],
        'ZX-41': [exactEvent],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 48,
      overheadTokens: 0,
      retrievalHints: [{ query: 'auth token rotation #ZX-41', limit: 1 }],
    });

    expect(output.retrievalAddedCount).toBe(1);
    expect(output.retrievalAddedMessageCount).toBe(1);
    expect(output.retrievalAddedSummaryCount).toBe(0);
    expect(output.retrievalAddedCount).toBe(
      (output.retrievalAddedMessageCount ?? 0) + (output.retrievalAddedSummaryCount ?? 0),
    );
    expect(output.summaryReferences).toEqual([]);

    expect(output.retrievalDiagnostics?.[0]).toEqual(
      expect.objectContaining({
        selectedSummaryIds: [],
        selectedMessageIds: [exactEvent.id],
        candidateDecisions: expect.arrayContaining([
          expect.objectContaining({
            summaryId: genericSummary.id,
            selected: false,
            reason: 'over_budget',
          }),
        ]),
        messageDecisions: [
          expect.objectContaining({
            messageId: exactEvent.id,
            selected: true,
            reason: 'selected',
          }),
        ],
      }),
    );
  });

  it('prefers exact older evidence over newer generic matches when overlap ties', async () => {
    const exactOlderEvent = createTestMessage({
      id: createEventId('evt_retrieval_exact_older_evidence'),
      content:
        'DATE: 1:56 pm on 8 May, 2023 | ID: D1:3 | Caroline: I went to a LGBTQ support group yesterday and it was so powerful.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 3,
    });
    const newerGenericEventOne = createTestMessage({
      id: createEventId('evt_retrieval_generic_newer_1'),
      content:
        'DATE: 12:09 am on 13 September, 2023 | ID: D16:5 | Caroline: The LGBTQ support group inspired my artwork and reminded me to keep going.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 65,
    });
    const newerGenericEventTwo = createTestMessage({
      id: createEventId('evt_retrieval_generic_newer_2'),
      content:
        'DATE: 3:19 pm on 28 August, 2023 | ID: D15:3 | Caroline: The LGBTQ support group made me want to show more support in my community.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 54,
    });

    const state = createState({
      events: [exactOlderEvent, newerGenericEventOne, newerGenericEventTwo],
      eventSearchResults: {
        'When did Caroline go to the LGBTQ support group?': [
          exactOlderEvent,
          newerGenericEventOne,
          newerGenericEventTwo,
        ],
        'when did caroline the lgbtq support group': [
          exactOlderEvent,
          newerGenericEventOne,
          newerGenericEventTwo,
        ],
        'When Caroline LGBTQ': [exactOlderEvent, newerGenericEventOne, newerGenericEventTwo],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 48,
      overheadTokens: 0,
      retrievalHints: [{ query: 'When did Caroline go to the LGBTQ support group?', limit: 1 }],
    });

    expect(state.eventSearchQueries).toEqual([
      { query: 'When did Caroline go to the LGBTQ support group?' },
      { query: 'when did caroline the lgbtq support group' },
      { query: 'When Caroline LGBTQ' },
    ]);
    expect(output.modelMessages.map((message) => message.content)).toEqual([exactOlderEvent.content]);
    expect(output.retrievalAddedCount).toBe(1);
    expect(output.retrievalAddedMessageCount).toBe(1);
    expect(output.retrievalAddedSummaryCount).toBe(0);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([exactOlderEvent.id]);
  });

  it('prefers the most specific raw evidence even when a broader match appears in more retrieval stages', async () => {
    const exactOlderEvent = createTestMessage({
      id: createEventId('evt_retrieval_exact_stage_specificity'),
      content:
        'DATE: 1:56 pm on 8 May, 2023 | ID: D1:3 | Alice: I visited the community center yesterday and it was really meaningful.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 3,
    });
    const broaderNewerEvent = createTestMessage({
      id: createEventId('evt_retrieval_broader_stage_coverage'),
      content:
        'DATE: 12:09 am on 13 September, 2023 | ID: D16:5 | Alice: The community center inspired my artwork and reminded me to keep going.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 65,
    });

    const state = createState({
      events: [exactOlderEvent, broaderNewerEvent],
      eventSearchResults: {
        'When did Alice visit the community center?': [exactOlderEvent, broaderNewerEvent],
        'when did alice visit the community center': [broaderNewerEvent],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 48,
      overheadTokens: 0,
      retrievalHints: [{ query: 'When did Alice visit the community center?', limit: 1 }],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([exactOlderEvent.content]);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([exactOlderEvent.id]);
    expect(output.retrievalDiagnostics?.[0]?.messageDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: exactOlderEvent.id,
          selected: true,
          reason: 'selected',
        }),
        expect.objectContaining({
          messageId: broaderNewerEvent.id,
          selected: false,
          reason: 'limit_reached',
        }),
      ]),
    );
  });

  it('counts inflected retrieval matches once per concept in specificity diagnostics', async () => {
    const exactEvent = createTestMessage({
      id: createEventId('evt_retrieval_inflected_specificity_exact'),
      content:
        'DATE: 1:56 pm on 8 May, 2023 | ID: D1:3 | Alice: I visited the community center yesterday and it was really meaningful.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 3,
    });
    const genericEvent = createTestMessage({
      id: createEventId('evt_retrieval_inflected_specificity_generic'),
      content:
        'DATE: 12:09 am on 13 September, 2023 | ID: D16:5 | Alice: The community center inspired my artwork and reminded me to keep going.',
      tokenCount: 24,
      role: 'assistant',
      sequence: 65,
    });

    const state = createState({
      events: [exactEvent, genericEvent],
      eventSearchResults: {
        'When was Alice visiting the community center?': [exactEvent, genericEvent],
        'when was alice visiting the community center': [exactEvent, genericEvent],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 48,
      overheadTokens: 0,
      retrievalHints: [{ query: 'When was Alice visiting the community center?', limit: 1 }],
    });

    const selectedDecision = output.retrievalDiagnostics?.[0]?.messageDecisions.find(
      (decision) => decision.messageId === exactEvent.id,
    );
    const genericDecision = output.retrievalDiagnostics?.[0]?.messageDecisions.find(
      (decision) => decision.messageId === genericEvent.id,
    );

    expect(output.modelMessages.map((message) => message.content)).toEqual([exactEvent.content]);
    expect(selectedDecision).toEqual(
      expect.objectContaining({
        messageId: exactEvent.id,
        selected: true,
        reason: 'selected',
        specificityScore: 4,
      }),
    );
    expect(genericDecision).toEqual(
      expect.objectContaining({
        messageId: genericEvent.id,
        selected: false,
        reason: 'limit_reached',
        specificityScore: 3,
      }),
    );
  });

  it('prefers exact raw retrieval messages over generic summaries when hint limit is one', async () => {
    const exactEvent = createTestMessage({
      id: createEventId('evt_retrieval_exact_first'),
      content: 'DATE: 1 Jan 2026 | ID: D1:8 | Alice: auth token rotation #ZX-41 happens tonight.',
      tokenCount: 18,
      role: 'assistant',
      sequence: 8,
    });
    const genericSummary = createTestSummary({
      id: createSummaryNodeId('sum_retrieval_generic'),
      content: '[Summary] Alice discussed auth token rotation #ZX-41 details.',
      tokenCount: 10,
    });
    const competingSummary = createTestSummary({
      id: createSummaryNodeId('sum_retrieval_competing'),
      content: '[Summary] auth token rotation #ZX-41 checklist.',
      tokenCount: 9,
    });

    const state = createState({
      summaries: [genericSummary, competingSummary],
      events: [exactEvent],
      summarySearchResults: {
        'auth token rotation #ZX-41': [genericSummary, competingSummary],
        'auth token rotation': [genericSummary, competingSummary],
        'ZX-41': [genericSummary, competingSummary],
      },
      eventSearchResults: {
        'auth token rotation #ZX-41': [exactEvent],
        'auth token rotation': [exactEvent],
        'ZX-41': [exactEvent],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 48,
      overheadTokens: 0,
      retrievalHints: [{ query: 'auth token rotation #ZX-41', limit: 1 }],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([
      'DATE: 1 Jan 2026 | ID: D1:8 | Alice: auth token rotation #ZX-41 happens tonight.',
    ]);
    expect(output.summaryReferences).toEqual([]);
    expect(output.retrievalAddedCount).toBe(1);
    expect(output.retrievalMatchCount).toBe(9);
    expect(state.searchQueries).toEqual([
      { query: 'auth token rotation #ZX-41' },
      { query: 'auth token rotation' },
      { query: 'ZX-41' },
    ]);
    expect(state.eventSearchQueries).toEqual([
      { query: 'auth token rotation #ZX-41' },
      { query: 'auth token rotation' },
      { query: 'ZX-41' },
    ]);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: genericSummary.id,
          selected: false,
          reason: 'limit_reached',
        }),
      ]),
    );
  });

  it('selects a bridge summary that fits after borrowing one base message worth of slack', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_base_slack_1'),
      content: 'base-slack-context-1',
      tokenCount: 16,
      sequence: 101,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_base_slack_2'),
      content: 'base-slack-context-2',
      tokenCount: 16,
      sequence: 102,
    });
    const baseThree = createTestMessage({
      id: createEventId('evt_bridge_base_slack_3'),
      content: 'base-slack-context-3',
      tokenCount: 16,
      sequence: 103,
    });

    const oversizedTopBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_base_slack_top'),
      content:
        '[Summary] Andrew talked broadly about animals, birds, and outdoor interests without naming the bird.',
      tokenCount: 72,
    });
    const fitCapableBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_base_slack_compact'),
      content:
        '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are so strong and graceful.',
      tokenCount: 40,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
      ],
      events: [baseOne, baseTwo, baseThree],
      summaries: [oversizedTopBridgeSummary, fitCapableBridgeSummary],
      summarySearchResults: {
        'Which specific type of bird mesmerizes Andrew?': [oversizedTopBridgeSummary, fitCapableBridgeSummary],
        'which specific type bird mesmerizes andrew': [oversizedTopBridgeSummary, fitCapableBridgeSummary],
        'Which Andrew': [oversizedTopBridgeSummary, fitCapableBridgeSummary],
      },
      contextTokenCount: 48,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 64,
      overheadTokens: 0,
      retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
    });

    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([fitCapableBridgeSummary.id]);
    expect(output.modelMessages.map((message) => message.content)).toEqual([
      baseThree.content,
      `[Summary ID: ${fitCapableBridgeSummary.id}]\n${fitCapableBridgeSummary.content}`,
    ]);
    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([fitCapableBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: oversizedTopBridgeSummary.id,
          selected: false,
        }),
        expect.objectContaining({
          summaryId: fitCapableBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
      ]),
    );
  });

  it('selects a compact bridge summary when two base messages make it fit', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_base_two_unit_1'),
      content: 'base-two-unit-context-1',
      tokenCount: 16,
      sequence: 201,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_base_two_unit_2'),
      content: 'base-two-unit-context-2',
      tokenCount: 16,
      sequence: 202,
    });
    const baseThree = createTestMessage({
      id: createEventId('evt_bridge_base_two_unit_3'),
      content: 'base-two-unit-context-3',
      tokenCount: 16,
      sequence: 203,
    });

    const oversizedTopBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_base_two_unit_top'),
      content:
        '[Summary] Andrew talked about birds repeatedly, but this top summary is too large to fit the allowed bridge slack.',
      tokenCount: 80,
    });
    const twoUnitBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_base_two_unit_compact'),
      content:
        '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me. DATE: 8:11 am | ID:D1:17 | Andrew | Birds of prey feel powerful and graceful to me.',
      tokenCount: 44,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
      ],
      events: [baseOne, baseTwo, baseThree],
      summaries: [oversizedTopBridgeSummary, twoUnitBridgeSummary],
      summarySearchResults: {
        'Which specific type of bird mesmerizes Andrew?': [oversizedTopBridgeSummary, twoUnitBridgeSummary],
        'which specific type bird mesmerizes andrew': [oversizedTopBridgeSummary, twoUnitBridgeSummary],
        'Which Andrew': [oversizedTopBridgeSummary, twoUnitBridgeSummary],
      },
      contextTokenCount: 48,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 68,
      overheadTokens: 0,
      retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
    });

    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([twoUnitBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([twoUnitBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: oversizedTopBridgeSummary.id,
          selected: false,
        }),
        expect.objectContaining({
          summaryId: twoUnitBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
      ]),
    );
    expect(output.modelMessages.some((message) => message.content.includes('Eagles have always mesmerized me'))).toBe(
      true,
    );
  });

  it('keeps the top bridge summary when it already fits inside the reserve', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_reserve_fit_1'),
      content: 'base-reserve-fit-1',
      tokenCount: 16,
      sequence: 301,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_reserve_fit_2'),
      content: 'base-reserve-fit-2',
      tokenCount: 16,
      sequence: 302,
    });

    const topBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_reserve_fit_top'),
      content:
        '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are strong and graceful.',
      tokenCount: 12,
    });
    const smallerBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_reserve_fit_smaller'),
      content: '[Summary] Andrew likes birds.',
      tokenCount: 8,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      ],
      events: [baseOne, baseTwo],
      summaries: [topBridgeSummary, smallerBridgeSummary],
      summarySearchResults: {
        'Which specific type of bird mesmerizes Andrew?': [topBridgeSummary, smallerBridgeSummary],
        'which specific type bird mesmerizes andrew': [topBridgeSummary, smallerBridgeSummary],
        'Which Andrew': [topBridgeSummary, smallerBridgeSummary],
      },
      contextTokenCount: 32,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 64,
      overheadTokens: 0,
      retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
    });

    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([topBridgeSummary.id]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([topBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: topBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
        expect.objectContaining({
          summaryId: smallerBridgeSummary.id,
          selected: false,
        }),
      ]),
    );
  });

  it('falls back to the top viable unpinned bridge when no summary fits the soft bridge budget', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_unpinned_fallback_base_1'),
      content: 'base-unpinned-context-1',
      tokenCount: 16,
      sequence: 801,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_unpinned_fallback_base_2'),
      content: 'base-unpinned-context-2',
      tokenCount: 16,
      sequence: 802,
    });
    const baseThree = createTestMessage({
      id: createEventId('evt_bridge_unpinned_fallback_base_3'),
      content: 'base-unpinned-context-3',
      tokenCount: 16,
      sequence: 803,
    });

    const strongBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_unpinned_fallback_top'),
      content:
        "[Summary] DATE: 3:47 pm | ID:D1:8 | James | I've worked with Python and C++. I've built a website and some game mods.",
      tokenCount: 64,
    });
    const weakCompactSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_unpinned_fallback_compact'),
      content: '[Summary] James enjoys programming projects with John.',
      tokenCount: 24,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
      ],
      events: [baseOne, baseTwo, baseThree],
      summaries: [strongBridgeSummary, weakCompactSummary],
      summarySearchResults: {
        'What programming languages has James worked with?': [strongBridgeSummary],
        'what programming languages has james worked with': [strongBridgeSummary],
        'What James': [strongBridgeSummary, weakCompactSummary],
      },
      contextTokenCount: 48,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 80,
      overheadTokens: 0,
      retrievalHints: [{ query: 'What programming languages has James worked with?', limit: 1 }],
    });

    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([strongBridgeSummary.id]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([strongBridgeSummary.id]);
    expect(output.modelMessages.some((message) => message.content.includes('Python and C++'))).toBe(true);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: strongBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
        expect.objectContaining({
          summaryId: weakCompactSummary.id,
          selected: false,
        }),
      ]),
    );
  });

  it('does not count pinned base context as bridge-fit slack', async () => {
    const pinnedBase = createTestMessage({
      id: createEventId('evt_bridge_pinned_slack'),
      content: 'base-pinned-context',
      tokenCount: 16,
      sequence: 401,
    });
    const bridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_pinned_slack'),
      content:
        '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are so strong and graceful.',
      tokenCount: 24,
    });

    const state = createState({
      contextItems: [createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(pinnedBase.id) })],
      events: [pinnedBase],
      summaries: [bridgeSummary],
      summarySearchResults: {
        'Which specific type of bird mesmerizes Andrew?': [bridgeSummary],
        'which specific type bird mesmerizes andrew': [bridgeSummary],
        'Which Andrew': [bridgeSummary],
      },
      contextTokenCount: 16,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 32,
      overheadTokens: 0,
      pinRules: [{ type: 'position', position: 0 }],
      retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
    });

    expect(output.summaryReferences).toEqual([]);
    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([]);
  });

  it('selects the next viable bridge when the top fallback cannot coexist with pinned base', async () => {
    const pinnedBase = createTestMessage({
      id: createEventId('evt_bridge_pinned_fallback_base_1'),
      content: 'pinned-base-context',
      tokenCount: 16,
      sequence: 601,
    });
    const newerBaseOne = createTestMessage({
      id: createEventId('evt_bridge_pinned_fallback_base_2'),
      content: 'newer-base-context-1',
      tokenCount: 16,
      sequence: 602,
    });
    const newerBaseTwo = createTestMessage({
      id: createEventId('evt_bridge_pinned_fallback_base_3'),
      content: 'newer-base-context-2',
      tokenCount: 16,
      sequence: 603,
    });

    const topFallbackSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_pinned_fallback_top'),
      content:
        '[Summary] Andrew described the specific type of bird that mesmerizes him in vivid detail, naming the eagle and why it feels powerful and graceful.',
      tokenCount: 52,
    });
    const smallerViableSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_pinned_fallback_viable'),
      content:
        '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they feel strong and graceful.',
      tokenCount: 48,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(pinnedBase.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(newerBaseOne.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(newerBaseTwo.id) }),
      ],
      events: [pinnedBase, newerBaseOne, newerBaseTwo],
      summaries: [topFallbackSummary, smallerViableSummary],
      summarySearchResults: {
        'Which specific type of bird mesmerizes Andrew?': [topFallbackSummary, smallerViableSummary],
        'which specific type bird mesmerizes andrew': [topFallbackSummary, smallerViableSummary],
        'Which Andrew': [topFallbackSummary, smallerViableSummary],
      },
      contextTokenCount: 48,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 64,
      overheadTokens: 0,
      pinRules: [{ type: 'position', position: 0 }],
      retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
    });

    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([smallerViableSummary.id]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([smallerViableSummary.id]);
    expect(output.modelMessages.some((message) => message.content === pinnedBase.content)).toBe(true);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: topFallbackSummary.id,
          selected: false,
          reason: 'over_budget',
        }),
        expect.objectContaining({
          summaryId: smallerViableSummary.id,
          selected: true,
          reason: 'selected',
        }),
      ]),
    );
  });

  it('keeps pinned base context in final output when a bridge summary is selected', async () => {
    const pinnedBase = createTestMessage({
      id: createEventId('evt_bridge_pinned_keep_base'),
      content: 'pinned-base-context',
      tokenCount: 16,
      sequence: 701,
    });
    const newerUnpinnedBase = createTestMessage({
      id: createEventId('evt_bridge_pinned_keep_unpinned'),
      content: 'newer-unpinned-base-context',
      tokenCount: 16,
      sequence: 702,
    });

    const bridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_pinned_keep'),
      content:
        '[Summary] DATE: 8:10 am | ID:D1:16 | Andrew | Eagles have always mesmerized me because they are so strong and graceful.',
      tokenCount: 24,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(pinnedBase.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(newerUnpinnedBase.id) }),
      ],
      events: [pinnedBase, newerUnpinnedBase],
      summaries: [bridgeSummary],
      summarySearchResults: {
        'Which specific type of bird mesmerizes Andrew?': [bridgeSummary],
        'which specific type bird mesmerizes andrew': [bridgeSummary],
        'Which Andrew': [bridgeSummary],
      },
      contextTokenCount: 32,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 0,
      pinRules: [{ type: 'position', position: 0 }],
      retrievalHints: [{ query: 'Which specific type of bird mesmerizes Andrew?', limit: 1 }],
    });

    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([bridgeSummary.id]);
    expect(output.modelMessages.map((message) => message.content)).toEqual([
      pinnedBase.content,
      `[Summary ID: ${bridgeSummary.id}]\n${bridgeSummary.content}`,
    ]);
    expect(output.modelMessages.some((message) => message.content === newerUnpinnedBase.content)).toBe(false);
    expect(output.trimmedToFit).toBe(true);
    expect(output.droppedMessageCount).toBe(1);
  });

  it('selects the top bridge when reclaiming a longer unpinned base prefix makes it fit', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_long_reclaim_1'),
      content: 'older-base-context-1',
      tokenCount: 20,
      sequence: 901,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_long_reclaim_2'),
      content: 'older-base-context-2',
      tokenCount: 20,
      sequence: 902,
    });
    const baseThree = createTestMessage({
      id: createEventId('evt_bridge_long_reclaim_3'),
      content: 'older-base-context-3',
      tokenCount: 20,
      sequence: 903,
    });
    const baseFour = createTestMessage({
      id: createEventId('evt_bridge_long_reclaim_4'),
      content: 'newest-base-context',
      tokenCount: 20,
      sequence: 904,
    });

    const topBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_long_reclaim_top'),
      content:
        "[Summary] DATE: 3:47 pm | ID:D1:8 | James | I've worked with Python and C++. I've built a website and some game mods.",
      tokenCount: 72,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
        createContextItem({ conversationId, position: 2, ref: createMessageContextItemRef(baseThree.id) }),
        createContextItem({ conversationId, position: 3, ref: createMessageContextItemRef(baseFour.id) }),
      ],
      events: [baseOne, baseTwo, baseThree, baseFour],
      summaries: [topBridgeSummary],
      summarySearchResults: {
        'What programming languages has James worked with?': [topBridgeSummary],
        'what programming languages has james worked with': [topBridgeSummary],
        'What James': [topBridgeSummary],
      },
      contextTokenCount: 80,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 100,
      overheadTokens: 0,
      retrievalHints: [{ query: 'What programming languages has James worked with?', limit: 1 }],
    });

    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([topBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([topBridgeSummary.id]);
    expect(output.modelMessages.map((message) => message.content)).toEqual([
      baseFour.content,
      `[Summary ID: ${topBridgeSummary.id}]\n${topBridgeSummary.content}`,
    ]);
    expect(output.modelMessages.some((message) => message.content.includes('Python and C++'))).toBe(true);
    expect(output.droppedMessageCount).toBe(3);
    expect(output.trimmedToFit).toBe(true);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: topBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
      ]),
    );
  });

  it('ranks bridge summaries using retrievalText for abstract questions', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_retrieval_text_base_1'),
      content: 'base-context-1',
      tokenCount: 16,
      sequence: 941,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_retrieval_text_base_2'),
      content: 'base-context-2',
      tokenCount: 16,
      sequence: 942,
    });

    const answerBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_retrieval_text_answer'),
      content: '[Summary] James talked with John about work.',
      retrievalText:
        "[Summary] James talked with John about work.\n[summary_fact] ID:D1:8 | James | I've worked with Python and C++.",
      tokenCount: 18,
    });
    const genericBridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_retrieval_text_generic'),
      content: '[Summary] James enjoys programming projects with John.',
      retrievalText: '[Summary] James enjoys programming projects with John.',
      tokenCount: 18,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      ],
      events: [baseOne, baseTwo],
      summaries: [answerBridgeSummary, genericBridgeSummary],
      summarySearchResults: {
        'What programming languages has James worked with?': [answerBridgeSummary, genericBridgeSummary],
        'what programming languages has james worked with': [answerBridgeSummary, genericBridgeSummary],
        'What James': [answerBridgeSummary, genericBridgeSummary],
      },
      contextTokenCount: 32,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 64,
      overheadTokens: 0,
      retrievalHints: [{ query: 'What programming languages has James worked with?', limit: 1 }],
    });

    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([answerBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([answerBridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.candidateDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summaryId: answerBridgeSummary.id,
          selected: true,
          reason: 'selected',
        }),
        expect.objectContaining({
          summaryId: genericBridgeSummary.id,
          selected: false,
        }),
      ]),
    );
  });

  it('recovers exact raw evidence from the selected bridge summary scope when global raw search misses', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_scoped_recovery_base_1'),
      content: 'base-context-1',
      tokenCount: 16,
      sequence: 951,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_scoped_recovery_base_2'),
      content: 'base-context-2',
      tokenCount: 16,
      sequence: 952,
    });

    const bridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_scoped_recovery'),
      content: '[Summary] James answered a programming question.',
      retrievalText:
        "[Summary] James answered a programming question.\n[summary_fact] ID:D1:8 | James | I've worked with Python and C++.",
      tokenCount: 18,
    });

    const rawPrevious = createTestMessage({
      id: createEventId('evt_bridge_scoped_recovery_prev'),
      content: 'DATE: 3:47 pm | ID: D1:7 | John: What else have you built?',
      tokenCount: 8,
      sequence: 201,
    });
    const rawSeed = createTestMessage({
      id: createEventId('evt_bridge_scoped_recovery_seed'),
      content:
        "DATE: 3:47 pm | ID: D1:8 | James: I've worked with Python and C++. I've built a website and some game mods.",
      tokenCount: 12,
      sequence: 202,
    });
    const rawNext = createTestMessage({
      id: createEventId('evt_bridge_scoped_recovery_next'),
      content: 'DATE: 3:47 pm | ID: D1:9 | John: That sounds awesome.',
      tokenCount: 8,
      sequence: 203,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      ],
      events: [baseOne, baseTwo, rawPrevious, rawSeed, rawNext],
      summaries: [bridgeSummary],
      expandedSummaryMessages: {
        [bridgeSummary.id]: [rawPrevious, rawSeed, rawNext],
      },
      summarySearchResults: {
        'What programming languages has James worked with?': [bridgeSummary],
        'what programming languages has james worked with': [bridgeSummary],
        'What James': [bridgeSummary],
      },
      eventSearchResults: {
        'What programming languages has James worked with?': [],
        'what programming languages has james worked with': [],
        'What James': [],
      },
      contextTokenCount: 32,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 96,
      overheadTokens: 0,
      retrievalHints: [{ query: 'What programming languages has James worked with?', limit: 2 }],
    });

    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([bridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([rawPrevious.id, rawSeed.id, rawNext.id]);
    expect(output.modelMessages.some((message) => message.content === rawSeed.content)).toBe(true);
  });

  it('compresses a chosen bridge summary and preserves the best evidence line when the full bridge cannot fit', async () => {
    const baseOne = createTestMessage({
      id: createEventId('evt_bridge_compression_base_1'),
      content: 'base-context-1',
      tokenCount: 20,
      sequence: 961,
    });
    const baseTwo = createTestMessage({
      id: createEventId('evt_bridge_compression_base_2'),
      content: 'base-context-2',
      tokenCount: 20,
      sequence: 962,
    });

    const bridgeSummary = createTestSummary({
      id: createSummaryNodeId('sum_bridge_compression'),
      content:
        '[Summary] James answered in detail about his programming background, the languages he uses, the projects he has shipped, the tools he learned, and the types of software he keeps experimenting with whenever friends ask about his experience.',
      retrievalText:
        "[Summary] James answered in detail about his programming background, the languages he uses, the projects he has shipped, the tools he learned, and the types of software he keeps experimenting with whenever friends ask about his experience.\n[summary_fact] ID:D1:8 | James | I've worked with Python and C++ and built a website plus several game mods for friends.",
      tokenCount: 72,
    });

    const state = createState({
      contextItems: [
        createContextItem({ conversationId, position: 0, ref: createMessageContextItemRef(baseOne.id) }),
        createContextItem({ conversationId, position: 1, ref: createMessageContextItemRef(baseTwo.id) }),
      ],
      events: [baseOne, baseTwo],
      summaries: [bridgeSummary],
      summarySearchResults: {
        'What programming languages has James worked with?': [bridgeSummary],
        'what programming languages has james worked with': [bridgeSummary],
        'What James': [bridgeSummary],
      },
      contextTokenCount: 40,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 60,
      overheadTokens: 0,
      retrievalHints: [{ query: 'What programming languages has James worked with?', limit: 1 }],
    });

    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([bridgeSummary.id]);
    expect(output.retrievalDiagnostics?.[0]?.selectedSummaryIds).toEqual([bridgeSummary.id]);
    expect(output.modelMessages.some((message) => message.content.includes('Python and C++'))).toBe(true);
    expect(output.modelMessages.some((message) => message.content === `[Summary ID: ${bridgeSummary.id}]\n${bridgeSummary.content}`)).toBe(false);
  });

  it('keeps a retrieved evidence window by dropping stale base messages under budget pressure', async () => {
    const staleBaseOne = createTestMessage({
      id: createEventId('evt_base_stale_1'),
      content: 'recent-base-message-1',
      tokenCount: 20,
      sequence: 40,
    });
    const staleBaseTwo = createTestMessage({
      id: createEventId('evt_base_stale_2'),
      content: 'recent-base-message-2',
      tokenCount: 20,
      sequence: 41,
    });
    const staleBaseThree = createTestMessage({
      id: createEventId('evt_base_stale_3'),
      content: 'recent-base-message-3',
      tokenCount: 20,
      sequence: 42,
    });
    const staleBaseFour = createTestMessage({
      id: createEventId('evt_base_stale_4'),
      content: 'recent-base-message-4',
      tokenCount: 20,
      sequence: 43,
    });
    const promptTurn = createTestMessage({
      id: createEventId('evt_focus_prompt_turn'),
      content:
        'DATE: 8:14 am on 9 January, 2023 | ID: D1:7 | Maria: Woohoo, John! That is awesome. Any specific areas you want to tackle?',
      tokenCount: 18,
      role: 'assistant',
      sequence: 7,
    });
    const answerTurn = createTestMessage({
      id: createEventId('evt_focus_answer_turn'),
      content:
        'DATE: 8:14 am on 9 January, 2023 | ID: D1:8 | John: I am passionate about improving education and infrastructure in our community. Those are my main focuses.',
      tokenCount: 20,
      role: 'user',
      sequence: 8,
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(staleBaseOne.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(staleBaseTwo.id),
        }),
        createContextItem({
          conversationId,
          position: 2,
          ref: createMessageContextItemRef(staleBaseThree.id),
        }),
        createContextItem({
          conversationId,
          position: 3,
          ref: createMessageContextItemRef(staleBaseFour.id),
        }),
      ],
      events: [promptTurn, answerTurn, staleBaseOne, staleBaseTwo, staleBaseThree, staleBaseFour],
      eventSearchResults: {
        "What is John's main focus in local politics?": [promptTurn],
        'what is john main focus in local politics': [promptTurn],
        'What John': [promptTurn],
      },
      contextTokenCount: 80,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 100,
      overheadTokens: 0,
      retrievalHints: [{ query: "What is John's main focus in local politics?", limit: 1 }],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([
      'recent-base-message-2',
      'recent-base-message-3',
      'recent-base-message-4',
      promptTurn.content,
      answerTurn.content,
    ]);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([promptTurn.id, answerTurn.id]);
    expect(output.budgetUsed.value).toBe(98);
    expect(output.trimmedToFit).toBe(true);
    expect(output.droppedMessageCount).toBe(1);
  });

  it('keeps scoped retrieval windows inside the requested summary scope', async () => {
    const scopedSummary = createTestSummary({
      id: createSummaryNodeId('sum_retrieval_scope_window'),
      content: '[Summary] scoped contract storage context',
      tokenCount: 10,
    });
    const outsidePrevious = createTestMessage({
      id: createEventId('evt_retrieval_scope_previous'),
      content: 'DATE: 7:55 am on 9 January, 2023 | ID: D1:6 | Alice: unrelated out-of-scope setup.',
      tokenCount: 14,
      role: 'assistant',
      sequence: 6,
    });
    const scopedSeed = createTestMessage({
      id: createEventId('evt_retrieval_scope_seed'),
      content:
        'DATE: 8:14 am on 9 January, 2023 | ID: D1:7 | Alice: I stored the signed contract in the blue archive cabinet.',
      tokenCount: 18,
      role: 'assistant',
      sequence: 7,
    });
    const outsideNext = createTestMessage({
      id: createEventId('evt_retrieval_scope_next'),
      content: 'DATE: 8:16 am on 9 January, 2023 | ID: D1:8 | Bob: unrelated out-of-scope follow-up.',
      tokenCount: 14,
      role: 'user',
      sequence: 8,
    });

    const state = createState({
      events: [outsidePrevious, scopedSeed, outsideNext],
      summaries: [scopedSummary],
      expandedSummaryMessages: {
        [scopedSummary.id]: [scopedSeed],
      },
      eventSearchResults: {
        'Where did Alice store the signed contract?': [scopedSeed],
        'where did alice store the signed contract': [scopedSeed],
        'Where Alice': [scopedSeed],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 64,
      overheadTokens: 0,
      retrievalHints: [{ query: 'Where did Alice store the signed contract?', scope: scopedSummary.id, limit: 1 }],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([scopedSeed.content]);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([scopedSeed.id]);
  });

  it('skips oversized provisional bundles so smaller raw evidence can still be selected', async () => {
    const oversizedSeed = createTestMessage({
      id: createEventId('evt_retrieval_oversized_seed'),
      content:
        'DATE: 8:14 am on 9 January, 2023 | ID: D1:7 | Alice: The vendor contract is stored in the archive cabinet with every supporting document attached.',
      tokenCount: 70,
      role: 'assistant',
      sequence: 5,
    });
    const fittingCandidate = createTestMessage({
      id: createEventId('evt_retrieval_fitting_seed'),
      content: 'DATE: 8:20 am on 9 January, 2023 | ID: D1:9 | Alice: The vendor contract is stored in the archive cabinet.',
      tokenCount: 18,
      role: 'assistant',
      sequence: 50,
    });

    const state = createState({
      events: [oversizedSeed, fittingCandidate],
      eventSearchResults: {
        'Where is the vendor contract stored?': [oversizedSeed, fittingCandidate],
        'where is the vendor contract stored': [oversizedSeed, fittingCandidate],
        'Where': [oversizedSeed, fittingCandidate],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 60,
      overheadTokens: 0,
      retrievalHints: [{ query: 'Where is the vendor contract stored?', limit: 1 }],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([fittingCandidate.content]);
    expect(output.retrievalDiagnostics?.[0]?.selectedMessageIds).toEqual([fittingCandidate.id]);
    expect(output.retrievalDiagnostics?.[0]?.messageDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: oversizedSeed.id,
          selected: false,
          reason: 'over_budget',
        }),
        expect.objectContaining({
          messageId: fittingCandidate.id,
          selected: true,
          reason: 'selected',
        }),
      ]),
    );
  });

  it('dedupes raw retrieval events across multiple hints in one materialization run', async () => {
    const exactEvent = createTestMessage({
      id: createEventId('evt_retrieval_raw_dedupe'),
      content: 'DATE: 1 Jan 2026 | ID: D1:8 | Alice: auth token rotation #ZX-41 already covered.',
      tokenCount: 18,
      role: 'assistant',
      sequence: 8,
    });

    const state = createState({
      events: [exactEvent],
      eventSearchResults: {
        'auth token rotation #ZX-41': [exactEvent],
        'auth token rotation': [exactEvent],
        'ZX-41': [exactEvent],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 72,
      overheadTokens: 0,
      retrievalHints: [
        { query: 'auth token rotation #ZX-41', limit: 1 },
        { query: 'auth token rotation #ZX-41', limit: 1 },
      ],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([
      'DATE: 1 Jan 2026 | ID: D1:8 | Alice: auth token rotation #ZX-41 already covered.',
    ]);
    expect(output.retrievalAddedCount).toBe(1);
    expect(output.budgetUsed.value).toBe(18);
  });

  it('keeps raw messages under retrieval-reserve pressure before dropping summaries', async () => {
    const rawMessage = createTestMessage({
      id: createEventId('evt_trim_retrieval_reserve_message'),
      content: 'raw-evidence-under-reserve-pressure',
      tokenCount: 16,
      sequence: 1,
    });
    const olderSummary = createTestSummary({
      id: createSummaryNodeId('sum_trim_retrieval_reserve_old'),
      content: '[Summary] older-summary-context',
      tokenCount: 12,
    });
    const newerSummary = createTestSummary({
      id: createSummaryNodeId('sum_trim_retrieval_reserve_new'),
      content: '[Summary] newer-summary-context',
      tokenCount: 12,
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(rawMessage.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createSummaryContextItemRef(olderSummary.id),
        }),
        createContextItem({
          conversationId,
          position: 2,
          ref: createSummaryContextItemRef(newerSummary.id),
        }),
      ],
      events: [rawMessage],
      summaries: [olderSummary, newerSummary],
      contextTokenCount: 40,
    });

    const { useCase } = createUseCase({ state });

    const output = await useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 0,
      retrievalHints: [{ query: 'no-op-retrieval', limit: 1 }],
    });

    expect(output.modelMessages.map((message) => message.content)).toEqual([
      'raw-evidence-under-reserve-pressure',
      `[Summary ID: ${newerSummary.id}]\n[Summary] newer-summary-context`,
    ]);
    expect(output.summaryReferences.map((reference) => reference.id)).toEqual([newerSummary.id]);
    expect(output.retrievalAddedCount).toBe(0);
    expect(output.budgetUsed.value).toBe(28);
    expect(output.trimmedToFit).toBe(true);
    expect(output.droppedMessageCount).toBe(0);
    expect(output.droppedSummaryCount).toBe(1);
  });

  it('throws typed invalid-reference error for unknown retrieval scope', async () => {
    const summary = createTestSummary({
      id: createSummaryNodeId('sum_scope_known'),
      content: '[Summary] auth token rotation details',
      tokenCount: 8,
    });

    const state = createState({
      summaries: [summary],
      summarySearchResults: {
        'auth token rotation': [summary],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const execution = useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 0,
      retrievalHints: [
        {
          query: 'auth token rotation',
          scope: createSummaryNodeId('sum_scope_missing'),
          limit: 1,
        },
      ],
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary_scope',
      referenceId: 'sum_scope_missing',
    });
  });

  it('throws typed invalid-reference error when scoped retrieval has no matches', async () => {
    const summary = createTestSummary({
      id: createSummaryNodeId('sum_scope_known_nomatch'),
      content: '[Summary] unrelated content',
      tokenCount: 8,
    });

    const state = createState({
      summaries: [summary],
      summarySearchResults: {
        query: [],
      },
      contextTokenCount: 0,
    });

    const { useCase } = createUseCase({ state });

    const execution = useCase.execute({
      conversationId,
      budgetTokens: 40,
      overheadTokens: 0,
      retrievalHints: [
        {
          query: 'query',
          scope: summary.id,
          limit: 1,
        },
      ],
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary_scope',
      referenceId: summary.id,
    });
  });

  it('emits ContextMaterialized domain event when eventPublisher is provided', async () => {
    const message = createTestMessage({
      id: createEventId('evt_materialize_event_pub'),
      content: 'message-for-event-test',
      tokenCount: 12,
      role: 'user',
      sequence: 1,
    });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message.id),
        }),
      ],
      events: [message],
      contextTokenCount: 12,
    });

    const eventPublisher = new SpyEventPublisher();
    const { useCase } = createUseCase({ state, eventPublisher });

    await useCase.execute({
      conversationId,
      budgetTokens: 100,
      overheadTokens: 0,
    });

    expect(eventPublisher.events).toHaveLength(1);
    expect(eventPublisher.events[0]).toMatchObject({
      type: 'ContextMaterialized',
      conversationId,
      budgetUsed: createTokenCount(12),
      budgetTotal: createTokenCount(100),
      itemCount: 1,
    });
  });
});
