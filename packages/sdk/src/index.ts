import { createHash } from 'node:crypto';

import { createIdService, createTimestamp, type HashPort, type IdService } from '@ledgermind/domain';

import type {
  AppendLedgerEventsInput,
  ArtifactStorePort,
  CheckIntegrityInput,
  ClockPort,
  ContextProjectionPort,
  ConversationPort,
  DescribeInput,
  ExpandInput,
  ExploreArtifactInput,
  FileReaderPort,
  GrepInput,
  LedgerReadPort,
  MaterializeContextInput,
  MemoryEngine,
  RunCompactionConfig,
  RunCompactionInput,
  StoreArtifactInput,
  SummaryDagPort,
  TokenizerPort,
  UnitOfWorkPort,
} from '@ledgermind/application';

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
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SimpleTokenizerAdapter,
  SubAgentAuthorizationAdapter,
  TiktokenTokenizerAdapter,
  ValidatingTokenizerAdapter,
} from '@ledgermind/adapters';
import {
  createPgPool,
  createPgUnitOfWorkFromPool,
  NodeFileReader,
  PgArtifactStore,
  PgContextProjection,
  PgConversationStore,
  PgLedgerStore,
  PgSummaryDag,
  asPgExecutor,
} from '@ledgermind/infrastructure';

// ---------------------------------------------------------------------------
// Re-export key types consumers need
// ---------------------------------------------------------------------------

export type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  ArtifactReference,
  ArtifactSource,
  CheckIntegrityInput,
  CheckIntegrityOutput,
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  ExploreArtifactInput,
  ExploreArtifactOutput,
  ExplorerHints,
  GrepInput,
  GrepMatch,
  GrepOutput,
  MaterializeContextInput,
  MaterializeContextOutput,
  MemoryEngine,
  Metadata,
  ModelMessage,
  NewLedgerEvent,
  PinRule,
  RetrievalHint,
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
const SUPPORTED_STORAGE_TYPES = '"in-memory", "postgres"';
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
  readonly fileReader: FileReaderPort;
}

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

    return new ValidatingTokenizerAdapter(
      new TiktokenTokenizerAdapter({ model: modelFamily }),
      {
        tokenizerName: `TiktokenTokenizerAdapter(${modelFamily})`,
      },
    );
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

export interface MemoryEngineConfig {
  readonly storage:
    | { readonly type: 'in-memory' }
    | { readonly type: 'postgres'; readonly connectionString: string };

  readonly summarizer?: {
    readonly type: 'deterministic';
  };
  // TODO: Add LLM-based summarizer config in Phase 2

  readonly tokenizer?: MemoryEngineTokenizerConfig;

  readonly compaction?: Partial<RunCompactionConfig>;
}

export type InMemoryPresetConfig = Omit<MemoryEngineConfig, 'storage'>;

export const createInMemoryMemoryEngine = (
  config: InMemoryPresetConfig = {},
): MemoryEngine =>
  createMemoryEngine({
    storage: { type: 'in-memory' },
    ...config,
  });

export type PostgresPresetConfig = Omit<MemoryEngineConfig, 'storage'> & {
  readonly connectionString: string;
};

export const createPostgresMemoryEngine = ({
  connectionString,
  ...config
}: PostgresPresetConfig): MemoryEngine => {
  if (connectionString.trim().length === 0) {
    throw new Error('Postgres connectionString is required and cannot be empty.');
  }

  return createMemoryEngine({
    storage: { type: 'postgres', connectionString },
    ...config,
  });
};

// ---------------------------------------------------------------------------
// createMemoryEngine — composition root
// ---------------------------------------------------------------------------

export function createMemoryEngine(config: MemoryEngineConfig): MemoryEngine {
  validateMemoryEngineConfig(config);

  const tokenizer = resolveTokenizer(config.tokenizer);

  const persistenceDeps: MemoryEnginePersistenceDeps =
    config.storage.type === 'in-memory'
      ? (() => {
          const state = createInMemoryPersistenceState();

          return {
            unitOfWork: new InMemoryUnitOfWork(state),
            ledgerRead: new InMemoryLedgerStore(state),
            contextProjection: new InMemoryContextProjection(state),
            summaryDag: new InMemorySummaryDag(state),
            artifactStore: new InMemoryArtifactStore(state),
            conversations: new InMemoryConversationStore(state),
            fileReader: new NodeFileReader(),
          };
        })()
      : (() => {
          const pool = createPgPool({ connectionString: config.storage.connectionString });
          const executor = asPgExecutor(pool);

          return {
            unitOfWork: createPgUnitOfWorkFromPool(pool),
            ledgerRead: new PgLedgerStore(executor),
            contextProjection: new PgContextProjection(executor),
            summaryDag: new PgSummaryDag(executor),
            artifactStore: new PgArtifactStore(executor),
            conversations: new PgConversationStore(executor),
            fileReader: new NodeFileReader(),
          };
        })();

  const summarizer = new DeterministicSummarizerAdapter(tokenizer);
  const authorization = new SubAgentAuthorizationAdapter();
  const explorerRegistry = createDefaultExplorerRegistry(tokenizer);

  const hashPort = new NodeCryptoHashPort();
  const idService: IdService = createIdService(hashPort);
  const clock = new WallClock();

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

  const materializeUseCase = new MaterializeContextUseCase({
    conversations: persistenceDeps.conversations,
    contextProjection: persistenceDeps.contextProjection,
    summaryDag: persistenceDeps.summaryDag,
    ledgerRead: persistenceDeps.ledgerRead,
    artifactStore: persistenceDeps.artifactStore,
    runCompaction: (input) => runCompactionUseCase.execute(input),
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
    summaryDag: persistenceDeps.summaryDag,
  });

  const storeArtifactUseCase = new StoreArtifactUseCase({
    unitOfWork: persistenceDeps.unitOfWork,
    idService,
    hashPort,
    tokenizer,
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
    grep: (input: GrepInput) => grepUseCase.execute(input),
    describe: (input: DescribeInput) => describeUseCase.execute(input),
    expand: (input: ExpandInput) => expandUseCase.execute(input),
    storeArtifact: (input: StoreArtifactInput) => storeArtifactUseCase.execute(input),
    exploreArtifact: (input: ExploreArtifactInput) => exploreArtifactUseCase.execute(input),
  };

  return engine;
}

