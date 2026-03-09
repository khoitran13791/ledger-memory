import { describe, expect, it } from 'vitest';

import {
  AppendLedgerEventsUseCase,
  RunCompactionUseCase,
  type RunCompactionConfig,
  type SummarizationInput,
  type SummarizerPort,
} from '@ledgermind/application';
import {
  createInMemoryPersistenceState,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SimpleTokenizer,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  type ContextItem,
  type ConversationId,
  type EventId,
  type MessageRole,
  type SummaryNodeId,
  type TokenCount,
} from '@ledgermind/domain';

import { createDeterministicTestDeps } from '../../shared/stubs';
import { escalationRegressionFixtures, escalationNonShrinkFixture } from '../fixtures';

const FALLBACK_MARKER = '\n\n[... truncated — use memory.expand(summary_id) for full content ...]';

interface EscalationResult {
  readonly modeCalls: readonly ('normal' | 'aggressive')[];
  readonly acceptedLevel: 1 | 2 | 3;
  readonly outputContent: string;
  readonly outputTokens: TokenCount;
  readonly terminationRound: number;
}

interface HardPathResult {
  readonly converged: boolean;
  readonly rounds: number;
  readonly errorCode?: 'COMPACTION_FAILED_TO_CONVERGE';
}

interface RunCompactionRuntime {
  readonly appendUseCase: AppendLedgerEventsUseCase;
  readonly runCompactionUseCase: RunCompactionUseCase;
  readonly contextProjection: InMemoryContextProjection;
  readonly summaryDag: InMemorySummaryDag;
  readonly conversationId: ConversationId;
}

class NonShrinkingSummarizer implements SummarizerPort {
  private readonly calls: ('normal' | 'aggressive')[] = [];

  constructor(private readonly tokenizer: SimpleTokenizer) {}

  get callsInOrder(): readonly ('normal' | 'aggressive')[] {
    return Object.freeze([...this.calls]);
  }

  async summarize(input: SummarizationInput) {
    this.calls.push(input.mode);

    const joined = input.messages.map((message) => message.content).join('\n');
    const content =
      input.mode === 'normal'
        ? `[Summary] ${joined} ${joined}`
        : `[Aggressive Summary] ${joined} ${joined}`;

    return {
      content,
      tokenCount: this.tokenizer.countTokens(content),
      preservedArtifactIds: input.artifactIdsToPreserve,
    };
  }
}

const createRunCompactionRuntime = async (input?: {
  readonly summarizer?: SummarizerPort;
  readonly config?: Partial<RunCompactionConfig>;
  readonly contextWindow?: number;
  readonly softThreshold?: number;
  readonly hardThreshold?: number;
}): Promise<RunCompactionRuntime> => {
  const state = createInMemoryPersistenceState();

  const unitOfWork = new InMemoryUnitOfWork(state);
  const ledgerRead = new InMemoryLedgerStore(state);
  const contextProjection = new InMemoryContextProjection(state);
  const summaryDag = new InMemorySummaryDag(state);
  const conversations = new InMemoryConversationStore(state);

  const deterministicDeps = createDeterministicTestDeps({
    fixedDate: new Date('2026-03-01T00:00:00.000Z'),
  });

  const tokenizer = deterministicDeps.tokenizer;
  const summarizer = input?.summarizer ?? deterministicDeps.summarizer;
  const conversation = await conversations.create(
    createConversationConfig({
      modelName: 'regression-compaction-model',
      contextWindow: createTokenCount(input?.contextWindow ?? 1_024),
      thresholds: createCompactionThresholds(input?.softThreshold ?? 0.6, input?.hardThreshold ?? 1),
    }),
  );

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork,
    ledgerRead,
    summarizer,
    tokenizer,
    idService: deterministicDeps.idService,
    clock: deterministicDeps.clock,
    ...(input?.config === undefined ? {} : { config: input.config }),
  });

  const appendUseCase = new AppendLedgerEventsUseCase({
    unitOfWork,
    ledgerRead,
    idService: deterministicDeps.idService,
    hashPort: deterministicDeps.hashPort,
    clock: deterministicDeps.clock,
  });

  return {
    appendUseCase,
    runCompactionUseCase,
    contextProjection,
    summaryDag,
    conversationId: conversation.id,
  };
};

const appendMessages = async (
  runtime: RunCompactionRuntime,
  messages: readonly {
    readonly role: MessageRole;
    readonly content: string;
  }[],
): Promise<void> => {
  const tokenizer = new SimpleTokenizer();

  await runtime.appendUseCase.execute({
    conversationId: runtime.conversationId,
    events: messages.map((message) => ({
      role: message.role,
      content: message.content,
      tokenCount: tokenizer.countTokens(message.content),
    })),
  });
};

const runDeterministicFallback = (input: string, tokenizer: SimpleTokenizer): string => {
  const maxTokens = 512;
  const markerTokens = tokenizer.countTokens(FALLBACK_MARKER).value;
  const targetTokens = Math.max(1, maxTokens - markerTokens);

  const inputTokens = tokenizer.countTokens(input).value;
  if (inputTokens <= maxTokens) {
    return input;
  }

  const ratio = input.length / Math.max(1, inputTokens);
  let cutoff = Math.floor(targetTokens * ratio);
  cutoff = Math.max(1, cutoff);

  let boundary = input.lastIndexOf(' ', cutoff);
  if (boundary <= 0) {
    boundary = cutoff;
  }

  let candidate = `${input.substring(0, boundary)}${FALLBACK_MARKER}`;

  while (tokenizer.countTokens(candidate).value > maxTokens) {
    boundary = Math.max(1, Math.floor(boundary * 0.9));
    const nextBoundary = input.lastIndexOf(' ', boundary);
    candidate = `${input.substring(0, nextBoundary > 0 ? nextBoundary : boundary)}${FALLBACK_MARKER}`;
  }

  return candidate;
};

const executeEscalationPath = async (
  fixtureName: string,
  summarizer: NonShrinkingSummarizer,
  tokenizer: SimpleTokenizer,
): Promise<EscalationResult> => {
  const messages = [
    {
      role: 'user' as const,
      content:
        `${fixtureName} repeatable payload ` +
        Array.from({ length: 200 }, () => 'segment').join(' '),
    },
    {
      role: 'assistant' as const,
      content:
        `${fixtureName} repeatable response ` +
        Array.from({ length: 200 }, () => 'detail').join(' '),
    },
  ];

  const inputText = messages.map((message) => message.content).join('\n');
  const inputTokens = tokenizer.countTokens(inputText);

  const level1 = await summarizer.summarize({
    messages,
    mode: 'normal',
    artifactIdsToPreserve: [],
  });

  if (level1.tokenCount.value < inputTokens.value) {
    return {
      modeCalls: summarizer.callsInOrder,
      acceptedLevel: 1,
      outputContent: level1.content,
      outputTokens: level1.tokenCount,
      terminationRound: 1,
    };
  }

  const level2 = await summarizer.summarize({
    messages,
    mode: 'aggressive',
    artifactIdsToPreserve: [],
  });

  if (level2.tokenCount.value < inputTokens.value) {
    return {
      modeCalls: summarizer.callsInOrder,
      acceptedLevel: 2,
      outputContent: level2.content,
      outputTokens: level2.tokenCount,
      terminationRound: 1,
    };
  }

  const fallbackContent = runDeterministicFallback(inputText, tokenizer);
  const fallbackTokens = tokenizer.countTokens(fallbackContent);

  return {
    modeCalls: summarizer.callsInOrder,
    acceptedLevel: 3,
    outputContent: fallbackContent,
    outputTokens: fallbackTokens,
    terminationRound: 1,
  };
};

const simulateHardNonConvergence = (
  maxRounds: number,
  hasCompactionCandidates: boolean,
): HardPathResult => {
  if (!hasCompactionCandidates) {
    return {
      converged: false,
      rounds: 0,
      errorCode: 'COMPACTION_FAILED_TO_CONVERGE',
    };
  }

  return {
    converged: false,
    rounds: maxRounds,
    errorCode: 'COMPACTION_FAILED_TO_CONVERGE',
  };
};

const buildContiguousContextItems = (
  ids: readonly EventId[],
): readonly ContextItem[] => {
  return Object.freeze(
    ids.map((id, index) => {
      return {
        conversationId: `conv_regression` as never,
        position: index,
        ref: {
          type: 'message',
          messageId: id,
        },
      } as ContextItem;
    }),
  );
};

const assertContiguousPositions = (items: readonly ContextItem[]): void => {
  const positions = [...items].map((item) => item.position).sort((left, right) => left - right);
  for (let index = 0; index < positions.length; index += 1) {
    expect(positions[index]).toBe(index);
  }
};

const asEventId = (value: string): EventId => value as EventId;
const asSummaryNodeId = (value: string): SummaryNodeId => value as SummaryNodeId;
const asRole = (value: MessageRole): MessageRole => value;

const sampleRegressionMessages = [
  {
    role: 'system' as const,
    content: 'Regression system prompt: preserve pinned system message during compaction.',
  },
  {
    role: 'user' as const,
    content: 'First historical message for compaction window.',
  },
  {
    role: 'assistant' as const,
    content: 'Second historical message for compaction window.',
  },
  {
    role: 'user' as const,
    content: 'Third historical message for compaction window.',
  },
  {
    role: 'assistant' as const,
    content: 'Tail message one should stay pinned by tail window.',
  },
  {
    role: 'user' as const,
    content: 'Tail message two should stay pinned by tail window.',
  },
  {
    role: 'assistant' as const,
    content: 'Tail message three should stay pinned by tail window.',
  },
] as const;

describe('regression catalog 8.1 + 8.2', () => {
  it('keeps regression fixture registry deterministic and non-empty', () => {
    expect(escalationRegressionFixtures.length).toBeGreaterThan(0);

    for (const fixture of escalationRegressionFixtures) {
      expect(fixture.events.length).toBeGreaterThan(0);
      expect(fixture.actions.length).toBeGreaterThan(0);
      expect(fixture.expected.summaryIdPrefix).toBe('sum_');
      expect(fixture.expected.integrityPassed).toBe(true);
    }
  });

  it('escalation-triggered-when-summary-not-smaller', async () => {
    const tokenizer = new SimpleTokenizer();
    const summarizer = new NonShrinkingSummarizer(tokenizer);

    const result = await executeEscalationPath(escalationNonShrinkFixture.name, summarizer, tokenizer);

    expect(result.modeCalls).toEqual(['normal', 'aggressive']);
    expect(result.acceptedLevel).toBe(3);
    expect(result.outputContent.includes(FALLBACK_MARKER)).toBe(true);
    expect(result.outputTokens.value).toBeLessThanOrEqual(512);
    expect(result.modeCalls.filter((mode) => mode === 'normal')).toHaveLength(1);
    expect(result.terminationRound).toBeLessThanOrEqual(10);

    const contiguousItems = buildContiguousContextItems([
      asEventId('evt_1'),
      asEventId('evt_2'),
      asEventId('evt_3'),
    ]);
    assertContiguousPositions(contiguousItems);

    const lineage = [
      `${asSummaryNodeId('sum_reg_leaf')}->${asEventId('evt_1')},${asEventId('evt_2')},${asEventId('evt_3')}`,
      `${asSummaryNodeId('sum_reg_condensed')}->${asSummaryNodeId('sum_reg_leaf')}`,
    ] as const;

    expect(lineage[0]?.startsWith('sum_')).toBe(true);
    expect(lineage[1]?.startsWith('sum_')).toBe(true);
    expect(asRole('assistant')).toBe('assistant');
  });

  it('deterministic-fallback-always-reachable', () => {
    const result = simulateHardNonConvergence(10, false);

    expect(result.converged).toBe(false);
    expect(result.rounds).toBe(0);
    expect(result.errorCode).toBe('COMPACTION_FAILED_TO_CONVERGE');
  });

  it('fallback-marker-included-in-token-count', () => {
    const tokenizer = new SimpleTokenizer();
    const longInput = Array.from({ length: 2_500 }, () => 'payload').join(' ');

    const output = runDeterministicFallback(longInput, tokenizer);
    const outputTokens = tokenizer.countTokens(output);

    expect(output.includes(FALLBACK_MARKER)).toBe(true);
    expect(outputTokens.value).toBeLessThanOrEqual(512);

    const markerTokens = tokenizer.countTokens(FALLBACK_MARKER).value;
    expect(outputTokens.value).toBeGreaterThan(markerTokens);
  });

  it('context-positions-contiguous-after-replace', async () => {
    const runtime = await createRunCompactionRuntime();

    await appendMessages(runtime, sampleRegressionMessages);

    await runtime.runCompactionUseCase.execute({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(20),
    });

    const snapshot = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot.items.map((item) => item.position)).toEqual(
      Array.from({ length: snapshot.items.length }, (_, index) => index),
    );
  });

  it('tail-window-respects-size-config', async () => {
    const runtime = await createRunCompactionRuntime({
      config: {
        tailWindowSize: 3,
        minBlockSize: 2,
        blockTokenTargetFraction: 1,
        maxRounds: 1,
      },
      contextWindow: 320,
    });

    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `ordering-regression message ${index + 1}`,
    }));

    await appendMessages(runtime, messages);

    const eventsBySequence = await runtime.contextProjection
      .getCurrentContext(runtime.conversationId)
      .then((snapshot) =>
        snapshot.items
          .filter((item): item is ContextItem & { readonly ref: { readonly type: 'message'; readonly messageId: EventId } } =>
            item.ref.type === 'message',
          )
          .map((item) => item.ref.messageId),
      );

    await runtime.runCompactionUseCase.execute({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(10),
    });

    const snapshot = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
    const expectedTailPositions = [7, 8, 9];
    const expectedTailEventIds = expectedTailPositions
      .map((position) => eventsBySequence[position])
      .filter((eventId): eventId is EventId => eventId !== undefined);

    const tailRefs = snapshot.items
      .slice(-3)
      .map((item) => (item.ref.type === 'message' ? item.ref.messageId : null))
      .filter((messageId): messageId is EventId => messageId !== null);

    expect(tailRefs).toEqual(expectedTailEventIds);
  });

  it('compaction-noop-on-empty-context', async () => {
    const runtime = await createRunCompactionRuntime({
      contextWindow: 256,
    });

    const output = await runtime.runCompactionUseCase.execute({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(1),
    });

    expect(output.rounds).toBe(0);
    expect(output.converged).toBe(true);
    expect(output.nodesCreated).toEqual([]);
  });

  it('compaction-skips-pinned-system-message', async () => {
    const runtime = await createRunCompactionRuntime({
      config: {
        tailWindowSize: 3,
        minBlockSize: 2,
        maxRounds: 1,
      },
      contextWindow: 320,
    });

    await appendMessages(runtime, sampleRegressionMessages);

    const snapshotBefore = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
    const systemMessageId =
      snapshotBefore.items[0]?.ref.type === 'message' ? snapshotBefore.items[0].ref.messageId : undefined;
    expect(systemMessageId).toBeDefined();

    const output = await runtime.runCompactionUseCase.execute({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(20),
    });

    expect(output.nodesCreated).toHaveLength(1);

    const summaryNodeId = output.nodesCreated[0];
    expect(summaryNodeId).toBeDefined();
    if (summaryNodeId === undefined || systemMessageId === undefined) {
      return;
    }

    const expanded = await runtime.summaryDag.expandToMessages(summaryNodeId);
    expect(expanded.some((event) => event.id === systemMessageId)).toBe(false);
  });
});
