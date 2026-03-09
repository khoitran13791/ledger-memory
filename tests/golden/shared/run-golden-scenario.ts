import {
  AppendLedgerEventsUseCase,
  CheckIntegrityUseCase,
  MaterializeContextUseCase,
  RunCompactionUseCase,
  type ArtifactStorePort,
  type ContextProjectionPort,
  type LedgerReadPort,
  type SummaryDagPort,
  type UnitOfWorkPort,
} from '@ledgermind/application';
import {
  createInMemoryPersistenceState,
  DeterministicSummarizer,
  FixedClock,
  InMemoryArtifactStore,
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
  createIdService,
  createTokenCount,
  type Artifact,
  type ConversationId,
  type HashPort,
  type SummaryNode,
  type SummaryNodeId,
} from '@ledgermind/domain';

import type { CoreUseCasesFixture } from '../../shared/fixtures';
import { createPostgresTestHarness } from '../../../packages/infrastructure/src/postgres/__tests__/postgres-test-harness';

const FIXED_DATE = new Date('2026-02-02T02:02:02.000Z');

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

export type GoldenAdapterName = 'in-memory' | 'postgres';

interface AppendStepOutput {
  readonly appendedEventIds: readonly string[];
  readonly contextTokenCount: number;
}

interface RunCompactionStepOutput {
  readonly rounds: number;
  readonly nodesCreated: readonly string[];
  readonly tokensFreed: number;
  readonly converged: boolean;
}

interface MaterializeStepOutput {
  readonly budgetUsed: number;
  readonly systemPreamble: string;
  readonly modelMessages: readonly string[];
  readonly summaryReferences: readonly {
    readonly id: string;
    readonly kind: SummaryNode['kind'];
    readonly tokenCount: number;
  }[];
  readonly artifactReferences: readonly {
    readonly id: string;
    readonly mimeType: string;
    readonly tokenCount: number;
  }[];
}

interface CheckIntegrityStepOutput {
  readonly passed: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly details: string | null;
    readonly affectedIds: readonly string[];
  }[];
}

export type GoldenScenarioStep =
  | {
      readonly type: 'append';
      readonly output: AppendStepOutput;
    }
  | {
      readonly type: 'runCompaction';
      readonly output: RunCompactionStepOutput;
    }
  | {
      readonly type: 'materialize';
      readonly output: MaterializeStepOutput;
    }
  | {
      readonly type: 'checkIntegrity';
      readonly output: CheckIntegrityStepOutput;
    };

export interface GoldenScenarioSignature {
  readonly eventIds: readonly string[];
  readonly summaryNodes: readonly {
    readonly id: string;
    readonly kind: SummaryNode['kind'];
    readonly tokenCount: number;
    readonly artifactIds: readonly string[];
  }[];
  readonly summaryMessageEdges: readonly string[];
  readonly summaryParentEdges: readonly string[];
  readonly contextItems: readonly {
    readonly position: number;
    readonly ref: string;
  }[];
  readonly artifacts: readonly {
    readonly id: string;
    readonly tokenCount: number;
    readonly storageKind: Artifact['storageKind'];
    readonly mimeType: string;
  }[];
  readonly expandedMessageIdsBySummary: Readonly<Record<string, readonly string[]>>;
  readonly integrity: CheckIntegrityStepOutput;
}

export interface GoldenScenarioResult {
  readonly steps: readonly GoldenScenarioStep[];
  readonly signature: GoldenScenarioSignature;
}

interface Runtime {
  readonly conversationId: ConversationId;
  readonly appendUseCase: AppendLedgerEventsUseCase;
  readonly runCompactionUseCase: RunCompactionUseCase;
  readonly materializeUseCase: MaterializeContextUseCase;
  readonly checkIntegrityUseCase: CheckIntegrityUseCase;
  readonly ledgerRead: LedgerReadPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
  destroy(): Promise<void>;
}

const toConversationConfig = (fixture: CoreUseCasesFixture) => {
  return createConversationConfig({
    modelName: fixture.conversation.modelName,
    contextWindow: createTokenCount(fixture.conversation.contextWindow),
    thresholds: createCompactionThresholds(
      fixture.conversation.thresholds.soft,
      fixture.conversation.thresholds.hard,
    ),
  });
};

const toIntegrityStepOutput = (report: { readonly passed: boolean; readonly checks: readonly {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
  readonly affectedIds?: readonly string[];
}[] }): CheckIntegrityStepOutput => {
  return {
    passed: report.passed,
    checks: Object.freeze(
      [...report.checks]
        .map((check) => ({
          name: check.name,
          passed: check.passed,
          details: check.details ?? null,
          affectedIds: Object.freeze([...(check.affectedIds ?? [])].sort((left, right) => left.localeCompare(right))),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  };
};

const createUseCases = (deps: {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
  readonly conversationStore: InMemoryConversationStore | Awaited<ReturnType<typeof createPostgresTestHarness>>['conversations'];
}) => {
  const tokenizer = new SimpleTokenizer();
  const summarizer = new DeterministicSummarizer(tokenizer);
  const idService = createIdService(deterministicHashPort);
  const clock = new FixedClock(FIXED_DATE);

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork: deps.unitOfWork,
    ledgerRead: deps.ledgerRead,
    summarizer,
    tokenizer,
    idService,
    clock,
  });

  return {
    appendUseCase: new AppendLedgerEventsUseCase({
      unitOfWork: deps.unitOfWork,
      ledgerRead: deps.ledgerRead,
      idService,
      hashPort: deterministicHashPort,
      clock,
    }),
    runCompactionUseCase,
    materializeUseCase: new MaterializeContextUseCase({
      conversations: deps.conversationStore,
      contextProjection: deps.contextProjection,
      summaryDag: deps.summaryDag,
      ledgerRead: deps.ledgerRead,
      artifactStore: deps.artifactStore,
      runCompaction: (input) => runCompactionUseCase.execute(input),
    }),
    checkIntegrityUseCase: new CheckIntegrityUseCase({
      conversations: deps.conversationStore,
      summaryDag: deps.summaryDag,
    }),
  };
};

const createInMemoryRuntime = async (fixture: CoreUseCasesFixture): Promise<Runtime> => {
  const state = createInMemoryPersistenceState();

  const unitOfWork = new InMemoryUnitOfWork(state);
  const ledgerRead = new InMemoryLedgerStore(state);
  const contextProjection = new InMemoryContextProjection(state);
  const summaryDag = new InMemorySummaryDag(state);
  const artifactStore = new InMemoryArtifactStore(state);
  const conversationStore = new InMemoryConversationStore(state);

  const conversation = await conversationStore.create(toConversationConfig(fixture));

  return {
    conversationId: conversation.id,
    ...createUseCases({
      unitOfWork,
      ledgerRead,
      contextProjection,
      summaryDag,
      artifactStore,
      conversationStore,
    }),
    ledgerRead,
    contextProjection,
    summaryDag,
    artifactStore,
    destroy: async () => {
      return;
    },
  };
};

const createPostgresRuntime = async (fixture: CoreUseCasesFixture): Promise<Runtime> => {
  const harness = await createPostgresTestHarness();
  const conversation = await harness.conversations.create(toConversationConfig(fixture));

  return {
    conversationId: conversation.id,
    ...createUseCases({
      unitOfWork: harness.unitOfWork,
      ledgerRead: harness.ledger,
      contextProjection: harness.context,
      summaryDag: harness.dag,
      artifactStore: harness.artifacts,
      conversationStore: harness.conversations,
    }),
    ledgerRead: harness.ledger,
    contextProjection: harness.context,
    summaryDag: harness.dag,
    artifactStore: harness.artifacts,
    destroy: async () => {
      await harness.destroy();
    },
  };
};

const getParentSummaryIds = async (
  runtime: Runtime,
  summaryId: SummaryNodeId,
): Promise<readonly SummaryNodeId[]> => {
  const dagWithoutParents = runtime.summaryDag as SummaryDagPort;

  if ('getParentSummaryIds' in runtime.summaryDag) {
    const dagWithParents = runtime.summaryDag as SummaryDagPort & {
      getParentSummaryIds: (summaryId: SummaryNodeId) => Promise<readonly SummaryNodeId[]>;
    };

    return dagWithParents.getParentSummaryIds(summaryId);
  }

  const summaryNode = await dagWithoutParents.getNode(summaryId);
  if (summaryNode?.kind !== 'condensed') {
    return [];
  }

  const candidates = await dagWithoutParents.searchSummaries(runtime.conversationId, '');
  const parents: SummaryNodeId[] = [];

  for (const candidate of candidates) {
    const expanded = await dagWithoutParents.expandToMessages(candidate.id);
    const expandedIds = new Set(expanded.map((event) => event.id));

    if (expandedIds.size === 0) {
      continue;
    }

    const summaryExpanded = await dagWithoutParents.expandToMessages(summaryId);
    const summaryExpandedIds = new Set(summaryExpanded.map((event) => event.id));

    const isSubset = [...expandedIds].every((eventId) => summaryExpandedIds.has(eventId));
    const isNotSelf = candidate.id !== summaryId;

    if (isSubset && isNotSelf) {
      parents.push(candidate.id);
    }
  }

  return Object.freeze(parents.sort((left, right) => left.localeCompare(right)));
};

const collectSummaryIds = async (
  runtime: Runtime,
  steps: readonly GoldenScenarioStep[],
): Promise<readonly SummaryNodeId[]> => {
  const contextSnapshot = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
  const ids = new Set<SummaryNodeId>();

  for (const step of steps) {
    if (step.type === 'runCompaction') {
      for (const summaryId of step.output.nodesCreated) {
        ids.add(summaryId as SummaryNodeId);
      }
      continue;
    }

    if (step.type === 'materialize') {
      for (const reference of step.output.summaryReferences) {
        ids.add(reference.id as SummaryNodeId);
      }
    }
  }

  for (const item of contextSnapshot.items) {
    if (item.ref.type === 'summary') {
      ids.add(item.ref.summaryId);
    }
  }

  const queue = [...ids];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      continue;
    }

    const parents = await getParentSummaryIds(runtime, current);
    for (const parent of parents) {
      if (!ids.has(parent)) {
        ids.add(parent);
        queue.push(parent);
      }
    }
  }

  return Object.freeze([...ids].sort((left, right) => left.localeCompare(right)));
};

const buildSignature = async (
  runtime: Runtime,
  steps: readonly GoldenScenarioStep[],
): Promise<GoldenScenarioSignature> => {
  const events = await runtime.ledgerRead.getEvents(runtime.conversationId);
  const contextSnapshot = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
  const summaryIds = await collectSummaryIds(runtime, steps);

  const summaryNodes = (
    await Promise.all(summaryIds.map((summaryId) => runtime.summaryDag.getNode(summaryId)))
  )
    .filter((summary): summary is SummaryNode => summary !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  const summaryMessageEdges: string[] = [];
  const summaryParentEdges: string[] = [];
  const expandedMessageIdsBySummary: Record<string, readonly string[]> = {};

  for (const summaryNode of summaryNodes) {
    const expanded = await runtime.summaryDag.expandToMessages(summaryNode.id);
    const expandedIds = Object.freeze(
      [...expanded]
        .sort((left, right) => left.sequence - right.sequence)
        .map((message) => message.id),
    );

    expandedMessageIdsBySummary[summaryNode.id] = expandedIds;

    if (summaryNode.kind === 'leaf') {
      summaryMessageEdges.push(`${summaryNode.id}->${expandedIds.join(',')}`);
      continue;
    }

    const parentIds = Object.freeze(
      [...(await getParentSummaryIds(runtime, summaryNode.id))].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    summaryParentEdges.push(`${summaryNode.id}->${parentIds.join(',')}`);
  }

  const artifactIds = Object.freeze(
    [...new Set(summaryNodes.flatMap((summaryNode) => summaryNode.artifactIds))].sort((left, right) =>
      left.localeCompare(right),
    ),
  );

  const artifacts = Object.freeze(
    (
      await Promise.all(
        artifactIds.map(async (artifactId) => {
          return runtime.artifactStore.getMetadata(artifactId);
        }),
      )
    )
      .filter((artifact): artifact is Artifact => artifact !== null)
      .map((artifact) => ({
        id: artifact.id,
        tokenCount: artifact.tokenCount.value,
        storageKind: artifact.storageKind,
        mimeType: artifact.mimeType,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

  const integrity = await runtime.checkIntegrityUseCase.execute({ conversationId: runtime.conversationId });

  return {
    eventIds: Object.freeze(
      [...events]
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => event.id),
    ),
    summaryNodes: Object.freeze(
      summaryNodes.map((summaryNode) => ({
        id: summaryNode.id,
        kind: summaryNode.kind,
        tokenCount: summaryNode.tokenCount.value,
        artifactIds: Object.freeze([...summaryNode.artifactIds].sort((left, right) => left.localeCompare(right))),
      })),
    ),
    summaryMessageEdges: Object.freeze(summaryMessageEdges.sort((left, right) => left.localeCompare(right))),
    summaryParentEdges: Object.freeze(summaryParentEdges.sort((left, right) => left.localeCompare(right))),
    contextItems: Object.freeze(
      [...contextSnapshot.items]
        .sort((left, right) => left.position - right.position)
        .map((item) => ({
          position: item.position,
          ref: item.ref.type === 'summary' ? `summary:${item.ref.summaryId}` : `message:${item.ref.messageId}`,
        })),
    ),
    artifacts,
    expandedMessageIdsBySummary: Object.freeze(expandedMessageIdsBySummary),
    integrity: toIntegrityStepOutput(integrity.report),
  };
};

export const runGoldenScenario = async (input: {
  readonly fixture: CoreUseCasesFixture;
  readonly adapter: GoldenAdapterName;
}): Promise<GoldenScenarioResult> => {
  const tokenizer = new SimpleTokenizer();

  const runtime =
    input.adapter === 'in-memory'
      ? await createInMemoryRuntime(input.fixture)
      : await createPostgresRuntime(input.fixture);

  try {
    const appendOutput = await runtime.appendUseCase.execute({
      conversationId: runtime.conversationId,
      events: input.fixture.events.map((event) => ({
        role: event.role,
        content: event.content,
        tokenCount: tokenizer.countTokens(event.content),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      })),
    });

    const steps: GoldenScenarioStep[] = [
      {
        type: 'append',
        output: {
          appendedEventIds: Object.freeze(appendOutput.appendedEvents.map((event) => event.id)),
          contextTokenCount: appendOutput.contextTokenCount.value,
        },
      },
    ];

    for (const action of input.fixture.actions) {
      if (action.type === 'runCompaction') {
        const output = await runtime.runCompactionUseCase.execute({
          conversationId: runtime.conversationId,
          trigger: action.trigger,
          ...(action.targetTokens === undefined ? {} : { targetTokens: createTokenCount(action.targetTokens) }),
        });

        steps.push({
          type: 'runCompaction',
          output: {
            rounds: output.rounds,
            nodesCreated: Object.freeze([...output.nodesCreated]),
            tokensFreed: output.tokensFreed.value,
            converged: output.converged,
          },
        });
        continue;
      }

      if (action.type === 'materialize') {
        const output = await runtime.materializeUseCase.execute({
          conversationId: runtime.conversationId,
          budgetTokens: action.budgetTokens,
          overheadTokens: action.overheadTokens,
        });

        steps.push({
          type: 'materialize',
          output: {
            budgetUsed: output.budgetUsed.value,
            systemPreamble: output.systemPreamble,
            modelMessages: Object.freeze(output.modelMessages.map((message) => `${message.role}:${message.content}`)),
            summaryReferences: Object.freeze(
              output.summaryReferences.map((reference) => ({
                id: reference.id,
                kind: reference.kind,
                tokenCount: reference.tokenCount.value,
              })),
            ),
            artifactReferences: Object.freeze(
              output.artifactReferences.map((reference) => ({
                id: reference.id,
                mimeType: reference.mimeType,
                tokenCount: reference.tokenCount.value,
              })),
            ),
          },
        });
        continue;
      }

      const output = await runtime.checkIntegrityUseCase.execute({
        conversationId: runtime.conversationId,
      });

      steps.push({
        type: 'checkIntegrity',
        output: toIntegrityStepOutput(output.report),
      });
    }

    return {
      steps: Object.freeze(steps),
      signature: await buildSignature(runtime, steps),
    };
  } finally {
    await runtime.destroy();
  }
};
