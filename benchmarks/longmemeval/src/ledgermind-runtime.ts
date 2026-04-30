import {
  AppendLedgerEventsUseCase,
  CheckIntegrityUseCase,
  DescribeUseCase,
  ExpandUseCase,
  ExploreArtifactUseCase,
  GrepUseCase,
  MaterializeContextUseCase,
  RunCompactionUseCase,
  StoreArtifactUseCase,
  type ArtifactStorePort,
  type ContextProjectionPort,
  type ConversationPort,
  type LedgerReadPort,
  type MemoryEngine,
  type SummaryDagPort,
  type UnitOfWorkPort,
} from '@ledgermind/application';
import {
  createDefaultExplorerRegistry,
  createInMemoryPersistenceState,
  DeterministicSummarizer,
  InMemoryArtifactStore,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SimpleTokenizer,
  SubAgentAuthorizationAdapter,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversationConfig,
  createIdService,
  createTimestamp,
  createTokenCount,
  type EventId,
  type ConversationId,
  type HashPort,
  type MessageRole,
} from '@ledgermind/domain';

import type {
  LongMemEvalBenchmarkConfig,
  LongMemEvalExample,
  LongMemEvalFairnessConfig,
  LongMemEvalRuntimeMode,
} from './types.js';

interface RuntimeDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
  readonly conversations: ConversationPort;
}

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

const sharedTokenizer = new SimpleTokenizer();
const benchmarkOccurredAt = createTimestamp(new Date('2026-03-01T00:00:00.000Z'));

const createEngine = (input: { readonly deps: RuntimeDeps }): MemoryEngine => {
  const { deps } = input;
  const idService = createIdService(deterministicHashPort);
  const clock = {
    now: () => benchmarkOccurredAt,
  };
  const summarizer = new DeterministicSummarizer(sharedTokenizer);
  const explorerRegistry = createDefaultExplorerRegistry(sharedTokenizer);

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork: deps.unitOfWork,
    ledgerRead: deps.ledgerRead,
    summarizer,
    tokenizer: sharedTokenizer,
    idService,
    clock,
    config: {
      maxRounds: 20,
      tailWindowSize: 2,
      minBlockSize: 1,
      blockTokenTargetFraction: 0.2,
      targetFreePercentage: 0.15,
      deterministicFallbackMaxTokens: 512,
    },
  });

  const storeArtifactUseCase = new StoreArtifactUseCase({
    unitOfWork: deps.unitOfWork,
    idService,
    hashPort: deterministicHashPort,
    tokenizer: sharedTokenizer,
    explorerRegistry,
  });

  const exploreArtifactUseCase = new ExploreArtifactUseCase({
    artifactStore: deps.artifactStore,
    explorerRegistry,
  });

  const appendUseCase = new AppendLedgerEventsUseCase({
    unitOfWork: deps.unitOfWork,
    ledgerRead: deps.ledgerRead,
    idService,
    hashPort: deterministicHashPort,
    clock,
  });

  const materializeUseCase = new MaterializeContextUseCase({
    conversations: deps.conversations,
    contextProjection: deps.contextProjection,
    summaryDag: deps.summaryDag,
    ledgerRead: deps.ledgerRead,
    artifactStore: deps.artifactStore,
    tokenizer: sharedTokenizer,
    runCompaction: (compactionInput) => runCompactionUseCase.execute(compactionInput),
  });

  const checkIntegrityUseCase = new CheckIntegrityUseCase({
    conversations: deps.conversations,
    summaryDag: deps.summaryDag,
  });

  const grepUseCase = new GrepUseCase({
    ledgerRead: deps.ledgerRead,
    summaryDag: deps.summaryDag,
  });

  const describeUseCase = new DescribeUseCase({
    summaryDag: deps.summaryDag,
    artifactStore: deps.artifactStore,
  });

  const expandUseCase = new ExpandUseCase({
    authorization: new SubAgentAuthorizationAdapter(),
    conversations: deps.conversations,
    summaryDag: deps.summaryDag,
  });

  const createUnsupportedOperatorError = (
    operatorName:
      | 'recordContinuity'
      | 'createHandoff'
      | 'getCurrentState'
      | 'getNextSteps'
      | 'recallForTask'
      | 'markContinuityRecord'
      | 'llmMap'
      | 'agenticMap'
      | 'getOperatorRun',
  ): Error => {
    return new Error(`LongMemEval benchmark runtime does not support ${operatorName}().`);
  };

  return {
    append: (appendInput) => appendUseCase.execute(appendInput),
    materializeContext: (materializeInput) => materializeUseCase.execute(materializeInput),
    runCompaction: (compactionInput) => runCompactionUseCase.execute(compactionInput),
    checkIntegrity: (checkInput) => checkIntegrityUseCase.execute(checkInput),
    grep: (grepInput) => grepUseCase.execute(grepInput),
    describe: (describeInput) => describeUseCase.execute(describeInput),
    expand: (expandInput) => expandUseCase.execute(expandInput),
    storeArtifact: (storeInput) => storeArtifactUseCase.execute(storeInput),
    exploreArtifact: (exploreInput) => exploreArtifactUseCase.execute(exploreInput),
    recordContinuity: async () => {
      throw createUnsupportedOperatorError('recordContinuity');
    },
    createHandoff: async () => {
      throw createUnsupportedOperatorError('createHandoff');
    },
    getCurrentState: async () => {
      throw createUnsupportedOperatorError('getCurrentState');
    },
    getNextSteps: async () => {
      throw createUnsupportedOperatorError('getNextSteps');
    },
    recallForTask: async () => {
      throw createUnsupportedOperatorError('recallForTask');
    },
    markContinuityRecord: async () => {
      throw createUnsupportedOperatorError('markContinuityRecord');
    },
    llmMap: async () => {
      throw createUnsupportedOperatorError('llmMap');
    },
    agenticMap: async () => {
      throw createUnsupportedOperatorError('agenticMap');
    },
    getOperatorRun: async () => {
      throw createUnsupportedOperatorError('getOperatorRun');
    },
  };
};

export interface LedgermindRuntime {
  readonly conversationId: ConversationId;
  readonly engine: MemoryEngine;
  readonly runtimeMode: LongMemEvalRuntimeMode;
  readonly eventLookup: ReadonlyMap<
    string,
    {
      readonly eventId: EventId;
      readonly content: string;
      readonly sourceId: string;
      readonly sessionId: string;
      readonly sessionDate: string;
      readonly role: string;
    }
  >;
  destroy(): Promise<void>;
}

const toEventRole = (role: string): MessageRole => {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }

  return 'assistant';
};

const formatTurnContent = (input: {
  readonly example: LongMemEvalExample;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly turnId: string;
  readonly role: string;
  readonly content: string;
}): string => {
  return [
    `QUESTION_ID: ${input.example.exampleId}`,
    `QUESTION_TYPE: ${input.example.metadata.questionType}`,
    `SESSION_ID: ${input.sessionId}`,
    `SESSION_DATE: ${input.sessionDate}`,
    `SOURCE_ID: ${input.turnId}`,
    `ROLE: ${input.role}`,
    `CONTENT: ${input.content}`,
  ].join(' | ');
};

const createRuntimeConfig = (fairness: LongMemEvalFairnessConfig) =>
  createConversationConfig({
    modelName: fairness.modelName,
    contextWindow: createTokenCount(fairness.tokenBudget),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });

export const createLedgermindRuntime = async (input: {
  readonly example: LongMemEvalExample;
  readonly fairness: LongMemEvalFairnessConfig;
  readonly runtimeMode: LongMemEvalRuntimeMode;
  readonly precompact?: boolean;
}): Promise<LedgermindRuntime> => {
  const state = createInMemoryPersistenceState();
  const deps: RuntimeDeps = {
    unitOfWork: new InMemoryUnitOfWork(state),
    ledgerRead: new InMemoryLedgerStore(state),
    contextProjection: new InMemoryContextProjection(state),
    summaryDag: new InMemorySummaryDag(state),
    artifactStore: new InMemoryArtifactStore(state),
    conversations: new InMemoryConversationStore(state),
  };

  const conversation = await deps.conversations.create(createRuntimeConfig(input.fairness));
  const engine = createEngine({ deps });

  const appendOutput = await engine.append({
    conversationId: conversation.id,
    events: input.example.history.flatMap((session) =>
      session.turns.map((turn) => {
        const content = formatTurnContent({
          example: input.example,
          sessionId: session.sessionId,
          sessionDate: session.sessionDate,
          turnId: turn.turnId,
          role: turn.role,
          content: turn.content,
        });

        return {
          role: toEventRole(turn.role),
          content,
          tokenCount: sharedTokenizer.countTokens(content),
          occurredAt: benchmarkOccurredAt,
          metadata: {
            sourceId: turn.turnId,
            sessionId: session.sessionId,
            sessionDate: session.sessionDate,
            role: turn.role,
            sourceIndex: turn.sourceIndex,
            hasAnswer: turn.hasAnswer,
          },
        };
      }),
    ),
  });

  const eventLookup = new Map<
    string,
    {
      readonly eventId: EventId;
      readonly content: string;
      readonly sourceId: string;
      readonly sessionId: string;
      readonly sessionDate: string;
      readonly role: string;
    }
  >();
  for (const event of appendOutput.appendedEvents) {
    const sourceId =
      typeof event.metadata?.['sourceId'] === 'string' ? event.metadata['sourceId'] : event.id;
    const sessionId =
      typeof event.metadata?.['sessionId'] === 'string'
        ? event.metadata['sessionId']
        : 'unknown-session';
    const sessionDate =
      typeof event.metadata?.['sessionDate'] === 'string'
        ? event.metadata['sessionDate']
        : input.example.metadata.questionDate;
    const role = typeof event.metadata?.['role'] === 'string' ? event.metadata['role'] : event.role;
    eventLookup.set(event.id, {
      eventId: event.id,
      content: event.content,
      sourceId,
      sessionId,
      sessionDate,
      role,
    });
  }

  if (input.precompact === true) {
    await engine.runCompaction({
      conversationId: conversation.id,
      trigger: 'soft',
      targetTokens: createTokenCount(Math.floor(input.fairness.tokenBudget * 0.7)),
    });
  }

  return {
    conversationId: conversation.id,
    engine,
    eventLookup,
    runtimeMode: input.runtimeMode,
    destroy: async () => undefined,
  };
};

export const createLedgermindRuntimeFromConfig = async (input: {
  readonly config: LongMemEvalBenchmarkConfig;
  readonly example: LongMemEvalExample;
}): Promise<LedgermindRuntime> => {
  return createLedgermindRuntime({
    example: input.example,
    fairness: input.config.fairness,
    runtimeMode: input.config.runtimeMode,
  });
};
