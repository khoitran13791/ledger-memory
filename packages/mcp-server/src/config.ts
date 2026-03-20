export type McpServerStorageConfig =
  | { readonly type: 'in-memory' }
  | { readonly type: 'postgres'; readonly connectionString: string };

export interface McpServerConfig {
  readonly storage: McpServerStorageConfig;
  readonly bindingStorePath?: string;
  readonly enableWriteTools: boolean;
  readonly readOnly: boolean;
}

interface ParseMcpServerConfigOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const readFlagValue = (
  argv: readonly string[],
  index: number,
  flag: string,
): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
};

const parseBooleanEnv = (value: string | undefined): boolean =>
  value === undefined ? false : TRUE_VALUES.has(value.trim().toLowerCase());

export const formatMcpServerHelp = (): string => `Usage: ledgermind-mcp-server [options]

Options:
  --db <connection-string>         Use postgres storage with the given connection string.
  --storage <in-memory|postgres>   Explicitly set the storage type.
  --binding-store <path>           Persist runtime/session bindings to a local file.
  --enable-write-tools             Opt in to write-capable memory tools.
  --help                           Show this help text.
`;

export const parseMcpServerConfig = ({
  argv,
  env = process.env,
}: ParseMcpServerConfigOptions): McpServerConfig => {
  let storageType: 'in-memory' | 'postgres' = 'in-memory';
  let connectionString = env.LEDGERMIND_DB_URL;
  let bindingStorePath = env.LEDGERMIND_MCP_BINDING_STORE;
  let enableWriteTools = parseBooleanEnv(env.LEDGERMIND_MCP_ENABLE_WRITE_TOOLS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case '--db': {
        connectionString = readFlagValue(argv, index, '--db');
        storageType = 'postgres';
        index += 1;
        break;
      }
      case '--storage': {
        const value = readFlagValue(argv, index, '--storage');
        if (value !== 'in-memory' && value !== 'postgres') {
          throw new Error(`Unsupported storage type "${value}".`);
        }

        storageType = value;
        index += 1;
        break;
      }
      case '--binding-store': {
        bindingStorePath = readFlagValue(argv, index, '--binding-store');
        index += 1;
        break;
      }
      case '--enable-write-tools': {
        enableWriteTools = true;
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

  const storage: McpServerStorageConfig =
    storageType === 'postgres'
      ? (() => {
          if (connectionString === undefined || connectionString.trim().length === 0) {
            throw new Error('Postgres storage requires a non-empty connection string via --db or LEDGERMIND_DB_URL.');
          }

          return {
            type: 'postgres',
            connectionString,
          };
        })()
      : {
          type: 'in-memory',
        };

  return {
    storage,
    ...(bindingStorePath === undefined ? {} : { bindingStorePath }),
    enableWriteTools,
    readOnly: !enableWriteTools,
  };
};
