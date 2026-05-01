import { createHash } from 'node:crypto';

import {
  createIdService,
  createTimestamp,
  type HashPort,
  type IdService,
} from '@ledgermind/domain';

import type {
  AgenticMapInput,
  AppendLedgerEventsInput,
  ArtifactStorePort,
  CheckIntegrityInput,
  ClockPort,
  ContextProjectionPort,
  ConversationPort,
  CreateHandoffInput,
  GetCurrentStateInput,
  GetNextStepsInput,
  DelegationScopeResolverPort,
  DescribeInput,
  ExpandInput,
  ExploreArtifactInput,
  ExplorerRegistryPort,
  FileReaderPort,
  GetOperatorRunInput,
  GrepInput,
  JobQueuePort,
  LedgerReadPort,
  LLMMapInput,
  MaterializeContextInput,
  MemoryEngine,
  MarkContinuityRecordInput,
  OperatorConfig,
  RecallForTaskInput,
  RecordContinuityInput,
  OperatorExecutionPort,
  RunCompactionConfig,
  RunCompactionInput,
  StoreArtifactInput,
  StructuredGenerationPort,
  SubAgentExecutorPort,
  SummaryDagPort,
  TokenizerPort,
  UnitOfWorkPort,
} from '@ledgermind/application';

import {
  AgenticMapUseCase,
  AppendLedgerEventsUseCase,
  CheckIntegrityUseCase,
  CreateHandoffUseCase,
  DescribeUseCase,
  ExecuteOperatorTaskUseCase,
  ExpandUseCase,
  ExploreArtifactUseCase,
  FinalizeOperatorRunUseCase,
  GetOperatorRunUseCase,
  GetCurrentStateUseCase,
  GetNextStepsUseCase,
  GrepUseCase,
  LLMMapUseCase,
  MaterializeContextUseCase,
  MarkContinuityRecordUseCase,
  RecallForTaskUseCase,
  RecordContinuityUseCase,
  RunCompactionUseCase,
  StoreArtifactUseCase,
  TokenizerConfigurationError,
} from '@ledgermind/application';

import {
  createDefaultExplorerRegistry,
  createInMemoryPersistenceState,
  DeterministicSummarizerAdapter,
  InMemoryArtifactStore,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemoryOperatorExecutionStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SimpleTokenizerAdapter,
  SubAgentAuthorizationAdapter,
  TiktokenTokenizerAdapter,
  ValidatingTokenizerAdapter,
} from '@ledgermind/adapters';
import {
  createPgPool,
  createPgUnitOfWork,
  createSqliteUnitOfWork,
  NodeFileReader,
  PgArtifactStore,
  PgContextProjection,
  PgConversationStore,
  PgLedgerStore,
  PgOperatorExecutionStore,
  PgSummaryDag,
  SqliteArtifactStore,
  SqliteContextProjection,
  SqliteConversationStore,
  SqliteLedgerStore,
  SqliteOperatorExecutionStore,
  SqliteSummaryDag,
  asPgExecutor,
  openSqliteDatabaseSync,
  type PgExecutor,
} from '@ledgermind/infrastructure';

// ---------------------------------------------------------------------------
// Re-export key types consumers need
// ---------------------------------------------------------------------------

export type {
  AgenticMapInput,
  AgenticMapOutput,
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  ArtifactReference,
  ArtifactSource,
  CheckIntegrityInput,
  CheckIntegrityOutput,
  ContinuityImportance,
  ContinuityProvenance,
  ContinuityRecord,
  ContinuityRecordKind,
  ContinuityRecordStatus,
  CreateHandoffInput,
  CreateHandoffOutput,
  DelegatedScopeInput,
  DescribeArtifactPlanningSignals,
  DescribeInput,
  DescribeOutput,
  DescribeSummaryPlanningSignals,
  ExpandInput,
  ExpandOutput,
  ExploreArtifactInput,
  ExploreArtifactOutput,
  ExplorerHints,
  GetOperatorRunInput,
  GetOperatorRunOutput,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  GetNextStepsInput,
  GetNextStepsOutput,
  GrepGroup,
  GrepInput,
  GrepMatch,
  GrepOutput,
  GrepPageInfo,
  HandoffNextStep,
  KeptWorkInput,
  LLMMapInput,
  LLMMapOutput,
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  MaterializeContextInput,
  MaterializeContextOutput,
  MemoryEngine,
  Metadata,
  ModelMessage,
  NewLedgerEvent,
  OperatorBootstrapState,
  OperatorFailureMetadata,
  OperatorFinalizationStage,
  OperatorKind,
  OperatorResultEntry,
  OperatorRunStatus,
  OperatorTaskInspection,
  OperatorTaskStatus,
  PinRule,
  RecallForTaskInput,
  RecallForTaskOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
  RetrievalHint,
  RetrievalHintDiagnostics,
  RetrievalStageLabel,
  RetrievalStageQueryDiagnostics,
  RetrievalCandidateDecisionReason,
  RetrievalCandidateDecisionDiagnostics,
  RetryPolicy,
  RunCompactionInput,
  RunCompactionOutput,
  StoreArtifactInput,
  StoreArtifactOutput,
  SummaryReference,
} from '@ledgermind/application';

// ---------------------------------------------------------------------------
// NodeCryptoHashPort — SHA-256 via Node.js crypto
// ---------------------------------------------------------------------------

class NodeCryptoHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    return createHash('sha256').update(input).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// WallClock — production clock backed by system time
// ---------------------------------------------------------------------------

class WallClock implements ClockPort {
  now() {
    return createTimestamp(new Date());
  }
}

const SUPPORTED_TOKENIZER_TYPES = '"deterministic", "model-aligned"';
const SUPPORTED_STORAGE_TYPES = '"in-memory", "postgres", "sqlite"';
const SUPPORTED_SUMMARIZER_TYPES = '"deterministic"';
const DEFAULT_MODEL_FAMILY = 'gpt-4o-mini' as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRequiredNonEmptyString = (
  input: Record<string, unknown>,
  field: string,
  label: string,
): string => {
  const value = input[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required and cannot be empty.`);
  }

  return value;
};

const validateMemoryEngineConfig = (config: unknown): void => {
  if (!isRecord(config)) {
    throw new Error('MemoryEngine config must be an object.');
  }

  const storage = config['storage'];
  if (!isRecord(storage)) {
    throw new Error('MemoryEngine config must include a storage object.');
  }

  const storageType = storage['type'];

  if (storageType === 'postgres') {
    readRequiredNonEmptyString(storage, 'connectionString', 'Postgres connectionString');
  } else if (storageType === 'sqlite') {
    readRequiredNonEmptyString(storage, 'path', 'SQLite path');
  } else if (storageType === 'in-memory') {
    // no-op
  } else if (storageType === undefined) {
    throw new Error(`Missing storage type. Supported values: ${SUPPORTED_STORAGE_TYPES}.`);
  } else {
    throw new Error(
      `Unsupported storage type "${String(storageType)}". Supported values: ${SUPPORTED_STORAGE_TYPES}.`,
    );
  }

  const summarizer = config['summarizer'];
  if (summarizer !== undefined) {
    if (!isRecord(summarizer)) {
      throw new Error(
        `Summarizer config must be an object when provided. Supported values: ${SUPPORTED_SUMMARIZER_TYPES}.`,
      );
    }

    const summarizerType = summarizer['type'];
    if (summarizerType === 'deterministic') {
      // no-op
    } else if (summarizerType === undefined) {
      throw new Error(`Missing summarizer type. Supported values: ${SUPPORTED_SUMMARIZER_TYPES}.`);
    } else {
      throw new Error(
        `Unsupported summarizer type "${String(summarizerType)}". Supported values: ${SUPPORTED_SUMMARIZER_TYPES}.`,
      );
    }
  }

  const compaction = config['compaction'];
  if (compaction !== undefined && !isRecord(compaction)) {
    throw new Error('Compaction config must be an object when provided.');
  }
};

interface MemoryEnginePersistenceDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
  readonly conversations: ConversationPort;
  readonly operatorExecution: OperatorExecutionPort;
  readonly fileReader: FileReaderPort;
}

const createIdempotentClose = (
  closePersistence: () => Promise<void> | void,
): (() => Promise<void>) => {
  let closed = false;

  return async () => {
    if (closed) {
      return;
    }

    closed = true;
    await closePersistence();
  };
};

const resolveTokenizer = (tokenizerConfig: unknown): TokenizerPort => {
  if (tokenizerConfig === undefined) {
    return new ValidatingTokenizerAdapter(new SimpleTokenizerAdapter());
  }

  if (typeof tokenizerConfig !== 'object' || tokenizerConfig === null) {
    throw new TokenizerConfigurationError(
      'unknown',
      `Tokenizer config must be an object. Supported values: ${SUPPORTED_TOKENIZER_TYPES}.`,
    );
  }

  const rawType = (tokenizerConfig as { readonly type?: unknown }).type;

  if (rawType === 'deterministic') {
    return new ValidatingTokenizerAdapter(new SimpleTokenizerAdapter());
  }

  if (rawType === 'model-aligned') {
    const rawModelFamily = (tokenizerConfig as { readonly modelFamily?: unknown }).modelFamily;

    if (rawModelFamily !== undefined && typeof rawModelFamily !== 'string') {
      throw new TokenizerConfigurationError(
        'model-aligned',
        `modelFamily must be a string when provided. Received ${typeof rawModelFamily}.`,
      );
    }

    const modelFamily = (rawModelFamily as string | undefined) ?? DEFAULT_MODEL_FAMILY;

    if (modelFamily !== DEFAULT_MODEL_FAMILY) {
      throw new TokenizerConfigurationError(
        'model-aligned',
        `Unsupported modelFamily "${modelFamily}". Supported values: "${DEFAULT_MODEL_FAMILY}".`,
      );
    }

    return new ValidatingTokenizerAdapter(new TiktokenTokenizerAdapter({ model: modelFamily }), {
      tokenizerName: `TiktokenTokenizerAdapter(${modelFamily})`,
    });
  }

  if (rawType === undefined) {
    throw new TokenizerConfigurationError(
      'unknown',
      `Missing tokenizer type. Supported values: ${SUPPORTED_TOKENIZER_TYPES}.`,
    );
  }

  throw new TokenizerConfigurationError(
    String(rawType),
    `Unsupported tokenizer type "${String(rawType)}". Supported values: ${SUPPORTED_TOKENIZER_TYPES}.`,
  );
};

// ---------------------------------------------------------------------------
// MemoryEngineConfig
// ---------------------------------------------------------------------------

export type MemoryEngineTokenizerConfig =
  | { readonly type: 'deterministic' }
  | {
      readonly type: 'model-aligned';
      readonly modelFamily?: 'gpt-4o-mini';
    };

export interface MemoryEngineOperatorConfig {
  readonly structuredGeneration?: StructuredGenerationPort;
  readonly subAgentExecutor?: SubAgentExecutorPort;
  readonly delegationScopeResolver?: DelegationScopeResolverPort;
  readonly jobQueue?: JobQueuePort;
  readonly executionMode?: 'durable' | 'inline';
  readonly config?: Partial<OperatorConfig>;
}

export interface MemoryEngineConfig {
  readonly storage:
    | { readonly type: 'in-memory' }
    | {
        readonly type: 'postgres';
        readonly connectionString: string;
        readonly executor?: PgExecutor;
      }
    | {
        readonly type: 'sqlite';
        readonly path: string;
      };

  readonly summarizer?: {
    readonly type: 'deterministic';
  };
  // TODO: Add LLM-based summarizer config in Phase 2

  readonly tokenizer?: MemoryEngineTokenizerConfig;

  readonly compaction?: Partial<RunCompactionConfig>;
  readonly operators?: MemoryEngineOperatorConfig;
  readonly explorerRegistry?: ExplorerRegistryPort;
}

export type InMemoryPresetConfig = Omit<MemoryEngineConfig, 'storage'>;

export const createInMemoryMemoryEngine = (config: InMemoryPresetConfig = {}): MemoryEngine =>
  createMemoryEngine({
    storage: { type: 'in-memory' },
    ...config,
  });

export type PostgresPresetConfig = Omit<MemoryEngineConfig, 'storage'> & {
  readonly connectionString: string;
  readonly executor?: PgExecutor;
};

export const createPostgresMemoryEngine = ({
  connectionString,
  executor,
  ...config
}: PostgresPresetConfig): MemoryEngine => {
  if (connectionString.trim().length === 0) {
    throw new Error('Postgres connectionString is required and cannot be empty.');
  }

  return createMemoryEngine({
    storage: {
      type: 'postgres',
      connectionString,
      ...(executor === undefined ? {} : { executor }),
    },
    ...config,
  });
};

export type SqlitePresetConfig = Omit<MemoryEngineConfig, 'storage'> & {
  readonly path: string;
};

export const createSqliteMemoryEngine = ({ path, ...config }: SqlitePresetConfig): MemoryEngine => {
  if (path.trim().length === 0) {
    throw new Error('SQLite path is required and cannot be empty.');
  }

  return createMemoryEngine({
    storage: { type: 'sqlite', path },
    ...config,
  });
};

// ---------------------------------------------------------------------------
// createMemoryEngine — composition root
// ---------------------------------------------------------------------------

export function createMemoryEngine(config: MemoryEngineConfig): MemoryEngine {
  validateMemoryEngineConfig(config);

  const tokenizer = resolveTokenizer(config.tokenizer);

  let persistenceDeps: MemoryEnginePersistenceDeps;
  let closePersistence: () => Promise<void> | void = () => undefined;

  if (config.storage.type === 'in-memory') {
    const state = createInMemoryPersistenceState();

    persistenceDeps = {
      unitOfWork: new InMemoryUnitOfWork(state),
      ledgerRead: new InMemoryLedgerStore(state),
      contextProjection: new InMemoryContextProjection(state),
      summaryDag: new InMemorySummaryDag(state),
      artifactStore: new InMemoryArtifactStore(state),
      conversations: new InMemoryConversationStore(state),
      operatorExecution: new InMemoryOperatorExecutionStore(state),
      fileReader: new NodeFileReader(),
    };
  } else if (config.storage.type === 'postgres') {
    const executor =
      config.storage.executor ??
      (() => {
        const pool = createPgPool({ connectionString: config.storage.connectionString });
        closePersistence = () => pool.end();
        return asPgExecutor(pool);
      })();

    persistenceDeps = {
      unitOfWork: createPgUnitOfWork(executor),
      ledgerRead: new PgLedgerStore(executor),
      contextProjection: new PgContextProjection(executor),
      summaryDag: new PgSummaryDag(executor),
      artifactStore: new PgArtifactStore(executor),
      conversations: new PgConversationStore(executor),
      operatorExecution: new PgOperatorExecutionStore(executor),
      fileReader: new NodeFileReader(),
    };
  } else {
    const database = openSqliteDatabaseSync({ path: config.storage.path });
    const db = database.db;
    closePersistence = () => database.close();

    persistenceDeps = {
      unitOfWork: createSqliteUnitOfWork(db),
      ledgerRead: new SqliteLedgerStore(db),
      contextProjection: new SqliteContextProjection(db),
      summaryDag: new SqliteSummaryDag(db),
      artifactStore: new SqliteArtifactStore(db),
      conversations: new SqliteConversationStore(db),
      operatorExecution: new SqliteOperatorExecutionStore(db),
      fileReader: new NodeFileReader(),
    };
  }

  const summarizer = new DeterministicSummarizerAdapter(tokenizer);
  const authorization = new SubAgentAuthorizationAdapter();
  const explorerRegistry = config.explorerRegistry ?? createDefaultExplorerRegistry(tokenizer);

  const hashPort = new NodeCryptoHashPort();
  const idService: IdService = createIdService(hashPort);
  const clock = new WallClock();
  const close = createIdempotentClose(closePersistence);

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    ledgerRead: persistenceDeps.ledgerRead,
    summarizer,
    tokenizer,
    idService,
    clock,
    ...(config.compaction !== undefined ? { config: config.compaction } : {}),
  });

  const appendUseCase = new AppendLedgerEventsUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    ledgerRead: persistenceDeps.ledgerRead,
    idService,
    hashPort,
    clock,
  });

  const recordContinuityUseCase = new RecordContinuityUseCase({
    append: (input) => appendUseCase.execute(input),
    clock,
  });

  const createHandoffUseCase = new CreateHandoffUseCase({
    recordContinuity: (input) => recordContinuityUseCase.execute(input),
  });

  const getCurrentStateUseCase = new GetCurrentStateUseCase({
    ledgerRead: persistenceDeps.ledgerRead,
  });

  const getNextStepsUseCase = new GetNextStepsUseCase({
    getCurrentState: (input) => getCurrentStateUseCase.execute(input),
  });

  const materializeUseCase = new MaterializeContextUseCase({
    conversations: persistenceDeps.conversations,
    contextProjection: persistenceDeps.contextProjection,
    summaryDag: persistenceDeps.summaryDag,
    ledgerRead: persistenceDeps.ledgerRead,
    artifactStore: persistenceDeps.artifactStore,
    tokenizer,
    runCompaction: (input) => runCompactionUseCase.execute(input),
  });

  const recallForTaskUseCase = new RecallForTaskUseCase({
    getCurrentState: (input) => getCurrentStateUseCase.execute(input),
    materializeContext: (input) => materializeUseCase.execute(input),
    tokenizer,
  });

  const markContinuityRecordUseCase = new MarkContinuityRecordUseCase({
    recordContinuity: (input) => recordContinuityUseCase.execute(input),
  });

  const checkIntegrityUseCase = new CheckIntegrityUseCase({
    conversations: persistenceDeps.conversations,
    summaryDag: persistenceDeps.summaryDag,
  });

  const grepUseCase = new GrepUseCase({
    ledgerRead: persistenceDeps.ledgerRead,
    summaryDag: persistenceDeps.summaryDag,
  });

  const describeUseCase = new DescribeUseCase({
    summaryDag: persistenceDeps.summaryDag,
    artifactStore: persistenceDeps.artifactStore,
  });

  const expandUseCase = new ExpandUseCase({
    authorization,
    conversations: persistenceDeps.conversations,
    summaryDag: persistenceDeps.summaryDag,
  });

  const finalizeOperatorRunUseCase = new FinalizeOperatorRunUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    idService,
    hashPort,
    tokenizer,
    clock,
  });

  const llmMapUseCase = new LLMMapUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    idService,
    hashPort,
    tokenizer,
    clock,
    ...(config.operators?.jobQueue === undefined ? {} : { jobQueue: config.operators.jobQueue }),
    ...(config.operators?.config === undefined ? {} : { config: config.operators.config }),
  });

  const agenticMapUseCase = new AgenticMapUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    idService,
    hashPort,
    tokenizer,
    clock,
    ...(config.operators?.jobQueue === undefined ? {} : { jobQueue: config.operators.jobQueue }),
    ...(config.operators?.config === undefined ? {} : { config: config.operators.config }),
  });

  const getOperatorRunUseCase = new GetOperatorRunUseCase({
    operatorExecution: persistenceDeps.operatorExecution,
    artifactStore: persistenceDeps.artifactStore,
    ...(config.operators?.config === undefined ? {} : { config: config.operators.config }),
  });

  const executeOperatorTaskUseCase =
    config.operators?.structuredGeneration === undefined &&
    config.operators?.subAgentExecutor === undefined
      ? undefined
      : new ExecuteOperatorTaskUseCase({
          operatorExecution: persistenceDeps.operatorExecution,
          artifactStore: persistenceDeps.artifactStore,
          structuredGeneration: config.operators?.structuredGeneration ?? {
            async generate() {
              throw new Error('Inline llmMap execution requires operators.structuredGeneration.');
            },
          },
          finalizeOperatorRun: finalizeOperatorRunUseCase,
          clock,
          workerId: 'sdk-inline-worker',
          unitOfWork: persistenceDeps.unitOfWork,
          ...(config.operators?.subAgentExecutor === undefined
            ? {}
            : { subAgentExecutor: config.operators.subAgentExecutor }),
          ...(config.operators?.delegationScopeResolver === undefined
            ? {}
            : { delegationScopeResolver: config.operators.delegationScopeResolver }),
          tokenizer,
          idService,
          ...(config.operators?.config === undefined ? {} : { config: config.operators.config }),
        });

  const storeArtifactUseCase = new StoreArtifactUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    idService,
    hashPort,
    tokenizer,
    explorerRegistry,
    fileReader: persistenceDeps.fileReader,
  });

  const exploreArtifactUseCase = new ExploreArtifactUseCase({
    artifactStore: persistenceDeps.artifactStore,
    explorerRegistry,
  });

  const engine: MemoryEngine = {
    append: (input: AppendLedgerEventsInput) => appendUseCase.execute(input),
    materializeContext: (input: MaterializeContextInput) => materializeUseCase.execute(input),
    runCompaction: (input: RunCompactionInput) => runCompactionUseCase.execute(input),
    checkIntegrity: (input: CheckIntegrityInput) => checkIntegrityUseCase.execute(input),
    recordContinuity: (input: RecordContinuityInput) => recordContinuityUseCase.execute(input),
    createHandoff: (input: CreateHandoffInput) => createHandoffUseCase.execute(input),
    getCurrentState: (input: GetCurrentStateInput) => getCurrentStateUseCase.execute(input),
    getNextSteps: (input: GetNextStepsInput) => getNextStepsUseCase.execute(input),
    recallForTask: (input: RecallForTaskInput) => recallForTaskUseCase.execute(input),
    markContinuityRecord: (input: MarkContinuityRecordInput) =>
      markContinuityRecordUseCase.execute(input),
    grep: (input: GrepInput) => grepUseCase.execute(input),
    describe: (input: DescribeInput) => describeUseCase.execute(input),
    expand: (input: ExpandInput) => expandUseCase.execute(input),
    storeArtifact: (input: StoreArtifactInput) => storeArtifactUseCase.execute(input),
    exploreArtifact: (input: ExploreArtifactInput) => exploreArtifactUseCase.execute(input),
    llmMap: async (input: LLMMapInput) => {
      const submitted = await llmMapUseCase.execute(input);
      if (config.operators?.executionMode !== 'inline') {
        return submitted;
      }
      if (executeOperatorTaskUseCase === undefined) {
        throw new Error('Inline operator execution requires operators.structuredGeneration.');
      }

      for (;;) {
        const executed = await executeOperatorTaskUseCase.execute();
        if (executed === null) {
          break;
        }
      }

      return getOperatorRunUseCase.execute({ runId: submitted.runId }).then((run) => ({
        runId: run.runId,
        status: run.status,
        ...(submitted.inputArtifactId === undefined
          ? {}
          : { inputArtifactId: submitted.inputArtifactId }),
      }));
    },
    agenticMap: async (input: AgenticMapInput) => {
      const submitted = await agenticMapUseCase.execute(input);
      if (config.operators?.executionMode !== 'inline') {
        return submitted;
      }
      if (executeOperatorTaskUseCase === undefined) {
        throw new Error('Inline operator execution requires runtime executors.');
      }
      if (config.operators?.subAgentExecutor === undefined) {
        throw new Error('Inline agenticMap execution requires operators.subAgentExecutor.');
      }
      if (config.operators?.delegationScopeResolver === undefined) {
        throw new Error('Inline agenticMap execution requires operators.delegationScopeResolver.');
      }

      for (;;) {
        const executed = await executeOperatorTaskUseCase.execute();
        if (executed === null) {
          break;
        }
      }

      return getOperatorRunUseCase.execute({ runId: submitted.runId }).then((run) => ({
        runId: run.runId,
        status: run.status,
        ...(submitted.inputArtifactId === undefined
          ? {}
          : { inputArtifactId: submitted.inputArtifactId }),
      }));
    },
    getOperatorRun: (input: GetOperatorRunInput) => getOperatorRunUseCase.execute(input),
    close,
  };

  return engine;
}
