import { describe, expect, it } from 'vitest';

import {
  AppendLedgerEventsUseCase,
  CheckIntegrityUseCase,
  RunCompactionUseCase,
  type EventPublisherPort,
  type RunCompactionConfig,
  type SummarizationInput,
  type SummarizationOutput,
  type SummarizerPort,
} from '@ledgermind/application';
import {
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SimpleTokenizer,
  createInMemoryPersistenceState,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversationConfig,
  createIdService,
  createTokenCount,
  type ConversationId,
  type DomainEvent,
  type HashPort,
  type MessageRole,
} from '@ledgermind/domain';

import { goldenReplayFixtures, basicCompactionFixture } from '../../golden/fixtures';
import { runGoldenScenario, type GoldenAdapterName } from '../../golden/shared/run-golden-scenario';
import { escalationNonShrinkFixture } from '../../regression/fixtures';
import { createDeterministicTestDeps } from '../../shared/stubs';

const INTEGRITY_CHECK_NAMES = Object.freeze([
  'no_orphan_edges',
  'no_orphan_context_refs',
  'acyclic_dag',
  'leaf_coverage',
  'condensed_coverage',
  'contiguous_positions',
  'monotonic_sequence',
  'artifact_propagation',
]);

const deterministicHashPort: HashPort = {
  sha256: (input) => {
    let acc = 2166136261;

    for (const byte of input) {
      acc ^= byte;
      acc = Math.imul(acc, 16777619) >>> 0;
    }

    return acc.toString(16).padStart(8, '0').repeat(8);
  },
};

class SpyEventPublisher implements EventPublisherPort {
  readonly events: DomainEvent[] = [];

  publish(event: DomainEvent): void {
    this.events.push(event);
  }
}

class NonShrinkingSummarizer implements SummarizerPort {
  readonly calls: SummarizationInput[] = [];

  constructor(private readonly tokenizer: SimpleTokenizer) {}

  async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
    this.calls.push(input);

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

interface Runtime {
  readonly conversationId: ConversationId;
  readonly appendUseCase: AppendLedgerEventsUseCase;
  readonly runCompactionUseCase: RunCompactionUseCase;
  readonly checkIntegrityUseCase: CheckIntegrityUseCase;
  readonly summaryDag: InMemorySummaryDag;
  readonly tokenizer: SimpleTokenizer;
  readonly eventPublisher: SpyEventPublisher;
}

const createRuntime = async (input?: {
  readonly summarizer?: SummarizerPort;
  readonly runCompactionConfig?: Partial<RunCompactionConfig>;
  readonly contextWindow?: number;
  readonly softThreshold?: number;
  readonly hardThreshold?: number;
}): Promise<Runtime> => {
  const state = createInMemoryPersistenceState();

  const unitOfWork = new InMemoryUnitOfWork(state);
  const ledgerRead = new InMemoryLedgerStore(state);
  const summaryDag = new InMemorySummaryDag(state);
  const conversations = new InMemoryConversationStore(state);

  const deterministicDeps = createDeterministicTestDeps({
    fixedDate: new Date('2026-03-01T00:00:00.000Z'),
  });
  const tokenizer = deterministicDeps.tokenizer;
  const summarizer = input?.summarizer ?? deterministicDeps.summarizer;
  const clock = deterministicDeps.clock;
  const idService = createIdService(deterministicHashPort);
  const eventPublisher = new SpyEventPublisher();

  const conversationConfig = createConversationConfig({
    modelName: 'quality-test-model',
    contextWindow: createTokenCount(input?.contextWindow ?? 2_048),
    thresholds: createCompactionThresholds(input?.softThreshold ?? 0.6, input?.hardThreshold ?? 1),
  });

  const conversation = await conversations.create(conversationConfig);

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork,
    ledgerRead,
    summarizer,
    tokenizer,
    idService,
    clock,
    ...(input?.runCompactionConfig === undefined ? {} : { config: input.runCompactionConfig }),
    eventPublisher,
  });

  return {
    appendUseCase: new AppendLedgerEventsUseCase({
      unitOfWork,
      ledgerRead,
      idService,
      hashPort: deterministicHashPort,
      clock,
      eventPublisher,
    }),
    runCompactionUseCase,
    checkIntegrityUseCase: new CheckIntegrityUseCase({
      conversations,
      summaryDag,
    }),
    conversationId: conversation.id,
    summaryDag,
    tokenizer,
    eventPublisher,
  };
};

const appendEvents = async (
  runtime: Runtime,
  events: readonly {
    readonly role: MessageRole;
    readonly content: string;
  }[],
): Promise<void> => {
  await runtime.appendUseCase.execute({
    conversationId: runtime.conversationId,
    events: events.map((event) => ({
      role: event.role,
      content: event.content,
      tokenCount: runtime.tokenizer.countTokens(event.content),
    })),
  });
};

const getSummaryNodeCreatedEvents = (
  eventPublisher: SpyEventPublisher,
): readonly Extract<DomainEvent, { readonly type: 'SummaryNodeCreated' }>[] => {
  return eventPublisher.events.filter(
    (
      event,
    ): event is Extract<DomainEvent, { readonly type: 'SummaryNodeCreated' }> =>
      event.type === 'SummaryNodeCreated',
  );
};

describe('compaction deterministic quality validation (section 6.1)', () => {
  it('keeps L1/L2 compression monotonic and preserves DAG integrity', async () => {
    const runtime = await createRuntime();

    await appendEvents(runtime, basicCompactionFixture.events);

    const output = await runtime.runCompactionUseCase.execute({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(60),
    });

    expect(output.nodesCreated.length).toBeGreaterThan(0);

    const summaryEvents = getSummaryNodeCreatedEvents(runtime.eventPublisher);
    const nonFallbackEvents = summaryEvents.filter((event) => event.level === 1 || event.level === 2);

    expect(nonFallbackEvents.length).toBeGreaterThan(0);
    for (const event of nonFallbackEvents) {
      expect(event.outputTokens.value).toBeLessThan(event.inputTokens.value);
    }

    const integrity = await runtime.checkIntegrityUseCase.execute({
      conversationId: runtime.conversationId,
    });
    expect(integrity.report.passed).toBe(true);
    expect(integrity.report.checks.every((check) => check.passed)).toBe(true);
  });

  it('invokes L3 only after non-shrinking L1 and L2 outputs', async () => {
    const tokenizer = new SimpleTokenizer();
    const summarizer = new NonShrinkingSummarizer(tokenizer);
    const runtime = await createRuntime({
      summarizer,
      runCompactionConfig: {
        maxRounds: 1,
        tailWindowSize: 1,
      },
    });

    await appendEvents(runtime, escalationNonShrinkFixture.events);

    const output = await runtime.runCompactionUseCase.execute({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(40),
    });

    expect(output.nodesCreated).toHaveLength(1);

    const summaryEvents = getSummaryNodeCreatedEvents(runtime.eventPublisher);
    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0]?.level).toBe(3);
    expect(summaryEvents[0]?.outputTokens.value).toBeLessThanOrEqual(512);

    expect(summarizer.calls.map((call) => call.mode)).toEqual(['normal', 'aggressive']);
  });
});

const adapters: readonly GoldenAdapterName[] = ['in-memory', 'postgres'];

describe.each(adapters)('compaction deterministic quality gates (%s)', (adapter) => {
  it.each(goldenReplayFixtures)('enforces budget, stability, integrity, and expand recovery for $name', async (fixture) => {
    const first = await runGoldenScenario({ fixture, adapter });
    const second = await runGoldenScenario({ fixture, adapter });

    expect(second).toEqual(first);

    const materializeActions = fixture.actions.filter((action) => action.type === 'materialize');
    const materializeSteps = first.steps.filter((step) => step.type === 'materialize');
    expect(materializeSteps).toHaveLength(materializeActions.length);

    for (let index = 0; index < materializeActions.length; index += 1) {
      const action = materializeActions[index];
      const step = materializeSteps[index];

      expect(action).toBeDefined();
      expect(step).toBeDefined();

      if (action !== undefined && step !== undefined) {
        const availableBudget = action.budgetTokens - action.overheadTokens;
        expect(step.output.budgetUsed).toBeLessThanOrEqual(availableBudget);
      }
    }

    expect(first.signature.integrity.passed).toBe(true);
    expect(first.signature.integrity.checks.every((check) => check.passed)).toBe(true);
    expect(first.signature.integrity.checks.map((check) => check.name).sort((left, right) => left.localeCompare(right))).toEqual(
      [...INTEGRITY_CHECK_NAMES].sort((left, right) => left.localeCompare(right)),
    );

    const summaryContextRef = first.signature.contextItems.find((item) => item.ref.startsWith('summary:'));
    expect(summaryContextRef).toBeDefined();

    if (summaryContextRef !== undefined) {
      const summaryId = summaryContextRef.ref.slice('summary:'.length);
      const expandedMessageIds = first.signature.expandedMessageIdsBySummary[summaryId];

      expect(expandedMessageIds).toBeDefined();
      expect(expandedMessageIds?.length).toBe(fixture.expected.expandRecoveryCount);

      const expectedPrefix = first.signature.eventIds.slice(0, fixture.expected.expandRecoveryCount);
      expect(expandedMessageIds).toEqual(expectedPrefix);
    }
  });
});
