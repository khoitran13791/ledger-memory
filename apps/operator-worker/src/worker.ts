import { createHash } from 'node:crypto';

import {
  ExecuteOperatorTaskUseCase,
  FinalizeOperatorRunUseCase,
  createOperatorConfig,
  type ClockPort,
  type ExecuteOperatorTaskUseCaseDeps,
  type FinalizeOperatorRunUseCaseDeps,
  type JobQueuePort,
  type StructuredGenerationPort,
  type TokenizerPort,
  type UnitOfWorkPort,
} from '@ledgermind/application';
import {
  DeterministicSummarizerAdapter,
  InMemoryArtifactStore,
  InMemoryConversationStore,
  InMemoryContextProjection,
  InMemoryLedgerStore,
  InMemoryOperatorExecutionStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SimpleTokenizerAdapter,
  createInMemoryPersistenceState,
} from '@ledgermind/adapters';
import { createIdService, createTimestamp, type HashPort, type IdService } from '@ledgermind/domain';
import {
  PgArtifactStore,
  PgConversationStore,
  PgContextProjection,
  PgLedgerStore,
  PgOperatorExecutionStore,
  PgSummaryDag,
  asPgExecutor,
  createPgPool,
  createPgUnitOfWorkFromPool,
} from '@ledgermind/infrastructure';

import { createOperatorWorkerPollLoop, type OperatorWorkerPollLoop } from './poll-loop';
import { validateOperatorWorkerRuntime, type OperatorWorkerConfig } from './config';

class NodeCryptoHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    return createHash('sha256').update(input).digest('hex');
  }
}

class WallClock implements ClockPort {
  now() {
    return createTimestamp(new Date());
  }
}

interface WorkerPersistenceDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly artifactStore: InMemoryArtifactStore | PgArtifactStore;
  readonly operatorExecution: InMemoryOperatorExecutionStore | PgOperatorExecutionStore;
  readonly jobQueue: JobQueuePort | undefined;
}

export interface OperatorWorker {
  readonly config: OperatorWorkerConfig;
  readonly executeOperatorTaskUseCase: ExecuteOperatorTaskUseCase;
  readonly finalizeOperatorRunUseCase: FinalizeOperatorRunUseCase;
  readonly pollLoop: OperatorWorkerPollLoop;
}

export interface CreateOperatorWorkerOptions {
  readonly config: OperatorWorkerConfig;
  readonly clock?: ClockPort;
  readonly tokenizer?: TokenizerPort;
  readonly hashPort?: HashPort;
  readonly idService?: IdService;
  readonly wait?: (ms: number) => Promise<void>;
}

const createPersistenceDeps = (config: OperatorWorkerConfig): WorkerPersistenceDeps => {
  if (config.storage.type === 'in-memory') {
    const state = createInMemoryPersistenceState();
    return {
      unitOfWork: new InMemoryUnitOfWork(state),
      artifactStore: new InMemoryArtifactStore(state),
      operatorExecution: new InMemoryOperatorExecutionStore(state),
      jobQueue: config.jobQueue,
    };
  }

  const pool = createPgPool({ connectionString: config.storage.connectionString });
  const executor = asPgExecutor(pool);
  return {
    unitOfWork: createPgUnitOfWorkFromPool(pool),
    artifactStore: new PgArtifactStore(executor),
    operatorExecution: new PgOperatorExecutionStore(executor),
    jobQueue: config.jobQueue,
  };
};

export const createOperatorWorker = ({
  config,
  clock = new WallClock(),
  tokenizer = new SimpleTokenizerAdapter(),
  hashPort = new NodeCryptoHashPort(),
  idService = createIdService(hashPort),
  wait = async () => undefined,
}: CreateOperatorWorkerOptions): OperatorWorker => {
  validateOperatorWorkerRuntime({ config });

  const persistence = createPersistenceDeps(config);
  const operatorConfig = createOperatorConfig(config.operators?.config);

  const finalizeOperatorRunUseCaseDeps: FinalizeOperatorRunUseCaseDeps = {
    unitOfWork: persistence.unitOfWork,
    idService,
    hashPort,
    tokenizer,
    clock,
  };

  const finalizeOperatorRunUseCase = new FinalizeOperatorRunUseCase(finalizeOperatorRunUseCaseDeps);

  const executeOperatorTaskUseCaseDeps: ExecuteOperatorTaskUseCaseDeps = {
    operatorExecution: persistence.operatorExecution,
    artifactStore: persistence.artifactStore,
    structuredGeneration: config.operators!.structuredGeneration as StructuredGenerationPort,
    finalizeOperatorRun: finalizeOperatorRunUseCase,
    clock,
    workerId: config.workerId,
    ...(config.operators?.config === undefined ? {} : { config: operatorConfig }),
    ...(config.operators?.subAgentExecutor === undefined
      ? {}
      : { subAgentExecutor: config.operators.subAgentExecutor }),
    ...(config.operators?.delegationScopeResolver === undefined
      ? {}
      : { delegationScopeResolver: config.operators.delegationScopeResolver }),
    ...(config.operators?.subAgentExecutor === undefined || config.operators?.delegationScopeResolver === undefined
      ? {}
      : { unitOfWork: persistence.unitOfWork, tokenizer, idService }),
  };

  const executeOperatorTaskUseCase = new ExecuteOperatorTaskUseCase(executeOperatorTaskUseCaseDeps);

  const subscribeToWakeHints = (() => {
    const jobQueue = persistence.jobQueue;
    if (jobQueue === undefined) {
      return undefined;
    }

    return async (_type: string, handler: () => void) =>
      jobQueue.subscribe('operator-run-created', async () => {
        handler();
      });
  })();

  const pollLoop = createOperatorWorkerPollLoop({
    pollIntervalMs: config.pollIntervalMs,
    executeNextTask: async () => (await executeOperatorTaskUseCase.execute()) !== null,
    finalizeNextRun: async () => {
      try {
        await finalizeOperatorRunUseCase.execute();
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === 'OperatorRunNotFoundError') {
          return false;
        }

        throw error;
      }
    },
    wait,
    ...(subscribeToWakeHints === undefined ? {} : { subscribeToWakeHints }),
  });

  return {
    config,
    executeOperatorTaskUseCase,
    finalizeOperatorRunUseCase,
    pollLoop,
  };
};
