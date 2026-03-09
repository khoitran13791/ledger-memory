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
  readonly tokenCount?: number;
  readonly artifactIds?: readonly ArtifactId[];
}): SummaryNode => {
  return createSummaryNode({
    id: input?.id ?? summaryId,
    conversationId,
    kind: 'leaf',
    content: input?.content ?? '[Summary] summary-content',
    tokenCount: createTokenCount(input?.tokenCount ?? 10),
    ...(input?.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
    createdAt: createTimestamp(new Date('2026-01-01T00:00:02.000Z')),
  });
};

const createTestArtifact = (input?: {
  readonly id?: ArtifactId;
  readonly tokenCount?: number;
}): Artifact => {
  return createArtifact({
    id: input?.id ?? artifactId,
    conversationId,
    storageKind: 'inline_text',
    mimeType: createMimeType('application/json'),
    tokenCount: createTokenCount(input?.tokenCount ?? 20),
    explorationSummary: null,
    explorerUsed: null,
  });
};

type TestState = {
  conversation: Conversation | null;
  contextItems: ContextItem[];
  contextVersion: ContextVersion;
  events: LedgerEvent[];
  summaries: Map<SummaryNode['id'], SummaryNode>;
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
  ): Promise<readonly LedgerEvent[]> {
    void conversationIdInput;
    void query;
    return [];
  }

  async regexSearchEvents(
    conversationIdInput: ConversationId,
    pattern: string,
    scope?: SummaryNode['id'],
  ) {
    void conversationIdInput;
    void pattern;
    void scope;
    return [];
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

  async expandToMessages(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async searchSummaries(
    conversationIdInput: ConversationId,
    query: string,
  ): Promise<readonly SummaryNode[]> {
    void conversationIdInput;
    void query;
    return [];
  }

  async checkIntegrity(conversationIdInput: ConversationId): Promise<IntegrityReport> {
    void conversationIdInput;
    return { passed: true, checks: [] };
  }
}

class TestArtifactStorePort implements ArtifactStorePort {
  constructor(private readonly state: TestState) {}

  async store(artifact: Artifact): Promise<void> {
    this.state.artifacts.set(artifact.id, artifact);
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
  readonly artifacts?: readonly Artifact[];
  readonly contextTokenCount?: number;
}): TestState => {
  return {
    conversation: input?.conversation ?? createTestConversation(),
    contextItems: [...(input?.contextItems ?? [])],
    contextVersion: createContextVersion(0),
    events: [...(input?.events ?? [])],
    summaries: new Map((input?.summaries ?? []).map((summary) => [summary.id, summary] as const)),
    artifacts: new Map((input?.artifacts ?? []).map((artifact) => [artifact.id, artifact] as const)),
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
  });

  it('triggers blocking hard compaction when current context exceeds hard threshold', async () => {
    const state = createState({
      conversation: createTestConversation({ contextWindow: 100, hardThreshold: 0.8 }),
      contextItems: [],
      events: [],
      summaries: [],
      artifacts: [],
      contextTokenCount: 81,
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

    await useCase.execute({
      conversationId,
      budgetTokens: 90,
      overheadTokens: 10,
    });

    expect(runCompaction.calls).toHaveLength(1);
    expect(runCompaction.calls[0]).toEqual({
      conversationId,
      trigger: 'hard',
      targetTokens: createTokenCount(80),
    });
  });

  it('returns typed failure when materialized context exceeds available budget', async () => {
    const message = createTestMessage({ tokenCount: 25, content: 'too-large' });

    const state = createState({
      contextItems: [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(message.id),
        }),
      ],
      events: [message],
      contextTokenCount: 25,
    });

    const { useCase } = createUseCase({ state });

    const execution = useCase.execute({
      conversationId,
      budgetTokens: 20,
      overheadTokens: 0,
    });

    await expect(execution).rejects.toBeInstanceOf(MaterializeContextBudgetExceededError);
    await expect(execution).rejects.toMatchObject({
      code: 'MATERIALIZE_CONTEXT_BUDGET_EXCEEDED',
      availableBudget: 20,
      requiredBudget: 25,
    });
  });

  it('returns typed failure when hard compaction does not converge', async () => {
    const state = createState({
      conversation: createTestConversation({ contextWindow: 100, hardThreshold: 0.8 }),
      contextTokenCount: 90,
    });

    const { useCase } = createUseCase({
      state,
      runCompactionResult: {
        rounds: 10,
        nodesCreated: [],
        tokensFreed: createTokenCount(0),
        converged: false,
      },
    });

    const execution = useCase.execute({
      conversationId,
      budgetTokens: 100,
      overheadTokens: 20,
    });

    await expect(execution).rejects.toBeInstanceOf(MaterializeContextBudgetExceededError);
    await expect(execution).rejects.toMatchObject({
      code: 'MATERIALIZE_CONTEXT_BUDGET_EXCEEDED',
      availableBudget: 80,
      requiredBudget: 90,
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

  it('prioritizes pinned items first in materialized output', async () => {
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

    // Pinned item (msg2) should come first
    expect(output.modelMessages[0]!.content).toBe('second');
    expect(output.modelMessages[1]!.content).toBe('first');
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
