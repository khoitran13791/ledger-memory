import type {
  DelegationScopeResolverPort,
  JobQueuePort,
  OperatorConfig,
  StructuredGenerationPort,
  SubAgentExecutorPort,
} from '@ledgermind/application';

export type OperatorWorkerStorageConfig =
  | { readonly type: 'in-memory' }
  | { readonly type: 'postgres'; readonly connectionString: string };

export interface OperatorWorkerConfig {
  readonly storage: OperatorWorkerStorageConfig;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly workerId: string;
  readonly jobQueue?: JobQueuePort;
  readonly operators?: {
    readonly structuredGeneration?: StructuredGenerationPort;
    readonly subAgentExecutor?: SubAgentExecutorPort;
    readonly delegationScopeResolver?: DelegationScopeResolverPort;
    readonly config?: Partial<OperatorConfig>;
  };
}

interface ParseOperatorWorkerConfigOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

interface ValidateOperatorWorkerRuntimeOptions {
  readonly config: OperatorWorkerConfig;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_WORKER_ID = 'operator-worker';

const readFlagValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
};

const readPositiveInteger = (value: string, field: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }

  return parsed;
};

export const parseOperatorWorkerConfig = ({
  argv,
  env = process.env,
}: ParseOperatorWorkerConfigOptions): OperatorWorkerConfig => {
  let storage: OperatorWorkerStorageConfig = { type: 'in-memory' };
  let pollIntervalMs = readPositiveInteger(env.LEDGERMIND_OPERATOR_POLL_INTERVAL_MS ?? `${DEFAULT_POLL_INTERVAL_MS}`, 'pollIntervalMs');
  let batchSize = readPositiveInteger(env.LEDGERMIND_OPERATOR_BATCH_SIZE ?? `${DEFAULT_BATCH_SIZE}`, 'batchSize');
  let workerId = env.LEDGERMIND_OPERATOR_WORKER_ID?.trim() || DEFAULT_WORKER_ID;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case '--db': {
        const connectionString = readFlagValue(argv, index, '--db');
        storage = { type: 'postgres', connectionString };
        index += 1;
        break;
      }
      case '--poll-interval-ms': {
        pollIntervalMs = readPositiveInteger(readFlagValue(argv, index, '--poll-interval-ms'), 'pollIntervalMs');
        index += 1;
        break;
      }
      case '--batch-size': {
        batchSize = readPositiveInteger(readFlagValue(argv, index, '--batch-size'), 'batchSize');
        index += 1;
        break;
      }
      case '--worker-id': {
        workerId = readFlagValue(argv, index, '--worker-id').trim();
        if (workerId.length === 0) {
          throw new Error('workerId cannot be empty.');
        }
        index += 1;
        break;
      }
      case '--storage': {
        const storageType = readFlagValue(argv, index, '--storage');
        if (storageType === 'in-memory') {
          storage = { type: 'in-memory' };
        } else if (storageType === 'postgres') {
          const connectionString = env.LEDGERMIND_DB_URL;
          if (connectionString === undefined || connectionString.trim().length === 0) {
            throw new Error('Postgres storage requires a non-empty connection string via --db or LEDGERMIND_DB_URL.');
          }
          storage = { type: 'postgres', connectionString };
        } else {
          throw new Error(`Unsupported storage type "${storageType}".`);
        }
        index += 1;
        break;
      }
      case '--help': {
        break;
      }
      default: {
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option "${arg}".`);
        }
      }
    }
  }

  return {
    storage,
    pollIntervalMs,
    batchSize,
    workerId,
  };
};

export const validateOperatorWorkerRuntime = ({ config }: ValidateOperatorWorkerRuntimeOptions): void => {
  if (config.operators?.structuredGeneration === undefined) {
    throw new Error('Operator worker requires a structuredGeneration executor for llmMap tasks.');
  }
};

export const formatOperatorWorkerHelp = (): string => `Usage: ledgermind-operator-worker [options]

Options:
  --db <connection-string>         Use postgres storage with the given connection string.
  --storage <in-memory|postgres>   Explicitly set the storage type.
  --poll-interval-ms <ms>          Poll interval between idle iterations.
  --batch-size <count>             Maximum work items to process per poll iteration.
  --worker-id <id>                 Stable worker identifier for leases.
  --help                           Show this help text.
`;
