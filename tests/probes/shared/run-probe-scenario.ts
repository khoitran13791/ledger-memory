import {
  createCompactionThresholds,
  createConversationConfig,
  createMimeType,
  createTimestamp,
  createTokenCount,
  type ConversationId,
} from '@ledgermind/domain';
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
  type RunCompactionConfig,
  type SummaryDagPort,
  type UnitOfWorkPort,
} from '@ledgermind/application';
import {
  createDefaultExplorerRegistry,
  createInMemoryPersistenceState,
  InMemoryArtifactStore,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
} from '@ledgermind/adapters';
import {
  createPgUnitOfWork,
  NodeFileReader,
  PgArtifactStore,
  PgContextProjection,
  PgConversationStore,
  PgLedgerStore,
  PgSummaryDag,
  type PgExecutor,
} from '@ledgermind/infrastructure';

import { createDeterministicTestDeps } from '../../shared/stubs';
import { createPostgresTestHarness } from '../../../packages/infrastructure/src/postgres/__tests__/postgres-test-harness';

import { answerProbeQuestion } from './probe-agent';
import { judgeProbeAnswer } from './judge-scorer';
import {
  getProbeArtifacts,
  getProbeEvents,
  type ProbeExecutionResult,
  type ProbeFixture,
  validateProbeFixture,
} from './probe-fixture';

export type ProbeAdapterName = 'in-memory' | 'postgres';

interface ProbeRuntime {
  readonly conversationId: ConversationId;
  readonly engine: MemoryEngine;
  destroy(): Promise<void>;
}

interface CreateUseCasesInput {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
  readonly conversations: ConversationPort;
  readonly runCompactionConfig?: Partial<RunCompactionConfig>;
}

const createEngine = (input: CreateUseCasesInput): MemoryEngine => {
  const deterministicDeps = createDeterministicTestDeps({
    fixedDate: new Date('2026-03-01T00:00:00.000Z'),
  });

  const tokenizer = deterministicDeps.tokenizer;
  const summarizer = deterministicDeps.summarizer;
  const clock = deterministicDeps.clock;

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork: input.unitOfWork,
    ledgerRead: input.ledgerRead,
    summarizer,
    tokenizer,
    idService: deterministicDeps.idService,
    clock,
    ...(input.runCompactionConfig === undefined ? {} : { config: input.runCompactionConfig }),
  });

  const appendUseCase = new AppendLedgerEventsUseCase({
    unitOfWork: input.unitOfWork,
    ledgerRead: input.ledgerRead,
    idService: deterministicDeps.idService,
    hashPort: deterministicDeps.hashPort,
    clock,
  });

  const materializeUseCase = new MaterializeContextUseCase({
    conversations: input.conversations,
    contextProjection: input.contextProjection,
    summaryDag: input.summaryDag,
    ledgerRead: input.ledgerRead,
    artifactStore: input.artifactStore,
    runCompaction: (runInput) => runCompactionUseCase.execute(runInput),
  });

  const checkIntegrityUseCase = new CheckIntegrityUseCase({
    conversations: input.conversations,
    summaryDag: input.summaryDag,
  });

  const grepUseCase = new GrepUseCase({
    ledgerRead: input.ledgerRead,
    summaryDag: input.summaryDag,
  });

  const describeUseCase = new DescribeUseCase({
    summaryDag: input.summaryDag,
    artifactStore: input.artifactStore,
  });

  const expandUseCase = new ExpandUseCase({
    authorization: {
      canExpand: () => true,
    },
    summaryDag: input.summaryDag,
  });

  const storeArtifactUseCase = new StoreArtifactUseCase({
    unitOfWork: input.unitOfWork,
    idService: deterministicDeps.idService,
    hashPort: deterministicDeps.hashPort,
    tokenizer,
    fileReader: new NodeFileReader(),
  });

  const exploreArtifactUseCase = new ExploreArtifactUseCase({
    artifactStore: input.artifactStore,
    explorerRegistry: createDefaultExplorerRegistry(tokenizer),
  });

  return {
    append: (engineInput) => appendUseCase.execute(engineInput),
    materializeContext: (engineInput) => materializeUseCase.execute(engineInput),
    runCompaction: (engineInput) => runCompactionUseCase.execute(engineInput),
    checkIntegrity: (engineInput) => checkIntegrityUseCase.execute(engineInput),
    grep: (engineInput) => grepUseCase.execute(engineInput),
    describe: (engineInput) => describeUseCase.execute(engineInput),
    expand: (engineInput) => expandUseCase.execute(engineInput),
    storeArtifact: (engineInput) => storeArtifactUseCase.execute(engineInput),
    exploreArtifact: (engineInput) => exploreArtifactUseCase.execute(engineInput),
  };
};

const createInMemoryRuntime = async (fixture: ProbeFixture): Promise<ProbeRuntime> => {
  const state = createInMemoryPersistenceState();
  const unitOfWork = new InMemoryUnitOfWork(state);
  const ledgerRead = new InMemoryLedgerStore(state);
  const contextProjection = new InMemoryContextProjection(state);
  const summaryDag = new InMemorySummaryDag(state);
  const artifactStore = new InMemoryArtifactStore(state);
  const conversations = new InMemoryConversationStore(state);

  const conversation = await conversations.create(
    createConversationConfig({
      modelName: 'probe-eval-model',
      contextWindow: createTokenCount(fixture.contextWindow),
      thresholds: createCompactionThresholds(fixture.softThreshold, fixture.hardThreshold),
    }),
  );

  const engine = createEngine({
    unitOfWork,
    ledgerRead,
    contextProjection,
    summaryDag,
    artifactStore,
    conversations,
    runCompactionConfig: {
      tailWindowSize: 0,
      minBlockSize: 1,
      blockTokenTargetFraction: 0.5,
      maxRounds: 1,
    },
  });

  return {
    conversationId: conversation.id,
    engine,
    destroy: async () => undefined,
  };
};

const createPostgresRuntime = async (fixture: ProbeFixture): Promise<ProbeRuntime> => {
  const harness = await createPostgresTestHarness();

  const executor: PgExecutor = {
    query: async (text, params) => {
      return harness.withClient(async (client) => {
        const result = await client.query(text, params as unknown[] | undefined);
        return {
          rows: result.rows,
          rowCount: result.rowCount,
        };
      });
    },
    connect: async () => {
      const client = await harness.pool.connect();
      await client.query(`SET search_path TO "${harness.schemaName.replaceAll('"', '""')}", public`);

      return {
        query: async (text, params) => {
          const result = await client.query(text, params as unknown[] | undefined);
          return {
            rows: result.rows,
            rowCount: result.rowCount,
          };
        },
        release: () => client.release(),
      };
    },
  };

  const conversations = new PgConversationStore(executor);
  const createdConversation = await conversations.create(
    createConversationConfig({
      modelName: 'probe-eval-model',
      contextWindow: createTokenCount(fixture.contextWindow),
      thresholds: createCompactionThresholds(fixture.softThreshold, fixture.hardThreshold),
    }),
  );

  const engine = createEngine({
    unitOfWork: createPgUnitOfWork(executor),
    ledgerRead: new PgLedgerStore(executor),
    contextProjection: new PgContextProjection(executor),
    summaryDag: new PgSummaryDag(executor),
    artifactStore: new PgArtifactStore(executor),
    conversations,
    runCompactionConfig: {
      tailWindowSize: 0,
      minBlockSize: 1,
      blockTokenTargetFraction: 0.5,
      maxRounds: 1,
    },
  });

  return {
    conversationId: createdConversation.id,
    engine,
    destroy: async () => {
      await harness.destroy();
    },
  };
};

const createRuntime = async (input: {
  readonly fixture: ProbeFixture;
  readonly adapter: ProbeAdapterName;
}): Promise<ProbeRuntime> => {
  return input.adapter === 'in-memory'
    ? createInMemoryRuntime(input.fixture)
    : createPostgresRuntime(input.fixture);
};

export const runProbeScenario = async (input: {
  readonly fixture: ProbeFixture;
  readonly adapter: ProbeAdapterName;
}): Promise<ProbeExecutionResult> => {
  const { fixture, adapter } = input;
  validateProbeFixture(fixture);

  const fixedOccurredAt = createTimestamp(new Date('2026-03-01T00:00:00.000Z'));

  const runtime = await createRuntime({ fixture, adapter });

  try {
    const events = getProbeEvents(fixture);

    await runtime.engine.append({
      conversationId: runtime.conversationId,
      events: events.map((event) => ({
        role: event.role,
        content: event.content,
        tokenCount: createTokenCount(Math.max(1, Math.ceil(event.content.length / 4))),
        occurredAt: fixedOccurredAt,
      })),
    });

    const artifacts = getProbeArtifacts(fixture);

    for (const artifact of artifacts) {
      const stored = await runtime.engine.storeArtifact({
        conversationId: runtime.conversationId,
        source: {
          kind: 'text',
          content: artifact.content,
        },
        ...(artifact.mimeType === undefined ? {} : { mimeType: createMimeType(artifact.mimeType) }),
      });

      await runtime.engine.exploreArtifact({
        artifactId: stored.artifactId,
      });

      const metadataEventContent = `Artifact reference recorded: ${artifact.path} -> ${stored.artifactId}`;
      await runtime.engine.append({
        conversationId: runtime.conversationId,
        events: [
          {
            role: 'tool',
            content: metadataEventContent,
            tokenCount: createTokenCount(Math.max(1, Math.ceil(metadataEventContent.length / 4))),
            occurredAt: fixedOccurredAt,
            metadata: {
              artifactIds: [stored.artifactId],
              artifactPath: artifact.path,
            },
          },
        ],
      });
    }

    await runtime.engine.runCompaction({
      conversationId: runtime.conversationId,
      trigger: 'soft',
      ...(fixture.runCompactionTargetTokens === undefined
        ? {}
        : {
            targetTokens: createTokenCount(fixture.runCompactionTargetTokens),
          }),
    });

    const materialized = await runtime.engine.materializeContext({
      conversationId: runtime.conversationId,
      budgetTokens: fixture.budgetTokens,
      overheadTokens: fixture.overheadTokens,
      ...((fixture.type === 'artifact' || fixture.type === 'tool_usage')
        ? {
            retrievalHints: [
              {
                query: fixture.question,
                limit: 3,
              },
            ],
          }
        : {}),
    });

    const integrity = await runtime.engine.checkIntegrity({
      conversationId: runtime.conversationId,
    });

    if (!integrity.report.passed) {
      throw new Error(`Probe fixture (${fixture.name}) failed integrity after scenario execution.`);
    }

    const answer = answerProbeQuestion({
      fixture,
      materialized,
    });

    const judged = judgeProbeAnswer({
      fixture,
      answer,
      materialized,
    });

    const reasons = [...judged.reasons];

    return {
      fixtureName: fixture.name,
      probeType: fixture.type,
      question: fixture.question,
      answer,
      passed: judged.passed,
      score: judged.score,
      maxScore: judged.maxScore,
      reasons,
      summaryIds: materialized.summaryReferences.map((ref) => ref.id),
      artifactIds: materialized.artifactReferences.map((ref) => ref.id),
      modelMessageCount: materialized.modelMessages.length,
      materializedBudgetUsed: materialized.budgetUsed.value,
    };
  } finally {
    await runtime.destroy();
  }
};
