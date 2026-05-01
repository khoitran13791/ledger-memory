export type McpServerStorageConfig =
  | { readonly type: 'in-memory' }
  | { readonly type: 'postgres'; readonly connectionString: string }
  | { readonly type: 'sqlite'; readonly path: string };

export interface McpServerConfig {
  readonly storage: McpServerStorageConfig;
  readonly bindingStorePath?: string;
  readonly enableWriteTools: boolean;
  readonly readOnly: boolean;
  readonly defaultRuntime?: string;
  readonly defaultUserScope?: string;
  readonly defaultWorkspaceScope?: string;
  readonly defaultBranchScope?: string;
}

interface ParseMcpServerConfigOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const readFlagValue = (argv: readonly string[], index: number, flag: string): string => {
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
  --sqlite <path>                  Use SQLite storage at the given host path.
  --storage <in-memory|postgres|sqlite>
                                   Explicitly set the storage type.
  --binding-store <path>           Persist runtime/session bindings to a local file.
  --enable-write-tools             Opt in to write-capable memory tools.
  --help                           Show this help text.
`;

export const parseMcpServerConfig = ({
  argv,
  env = process.env,
}: ParseMcpServerConfigOptions): McpServerConfig => {
  let storageType: 'in-memory' | 'postgres' | 'sqlite' | undefined;
  let sqlitePath = env.LEDGERMIND_SQLITE_PATH;
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
        if (value !== 'in-memory' && value !== 'postgres' && value !== 'sqlite') {
          throw new Error(`Unsupported storage type "${value}".`);
        }

        storageType = value;
        index += 1;
        break;
      }
      case '--sqlite': {
        sqlitePath = readFlagValue(argv, index, '--sqlite');
        storageType = 'sqlite';
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

  let storage: McpServerStorageConfig;
  if (storageType === 'postgres') {
    if (connectionString === undefined || connectionString.trim().length === 0) {
      throw new Error(
        'Postgres storage requires a non-empty connection string via --db or LEDGERMIND_DB_URL.',
      );
    }

    storage = {
      type: 'postgres',
      connectionString,
    };
  } else if (storageType === 'sqlite') {
    if (sqlitePath === undefined || sqlitePath.trim().length === 0) {
      throw new Error('SQLite storage requires --sqlite.');
    }

    storage = { type: 'sqlite', path: sqlitePath };
  } else if (storageType === 'in-memory') {
    storage = {
      type: 'in-memory',
    };
  } else {
    storage =
      sqlitePath === undefined || sqlitePath.trim().length === 0
        ? {
            type: 'in-memory',
          }
        : { type: 'sqlite', path: sqlitePath };
  }

  return {
    storage,
    ...(bindingStorePath === undefined ? {} : { bindingStorePath }),
    enableWriteTools,
    readOnly: !enableWriteTools,
    ...(env.LEDGERMIND_MCP_RUNTIME === undefined
      ? {}
      : { defaultRuntime: env.LEDGERMIND_MCP_RUNTIME }),
    ...(env.LEDGERMIND_MCP_USER_SCOPE === undefined
      ? {}
      : { defaultUserScope: env.LEDGERMIND_MCP_USER_SCOPE }),
    ...(env.LEDGERMIND_MCP_WORKSPACE_SCOPE === undefined
      ? {}
      : { defaultWorkspaceScope: env.LEDGERMIND_MCP_WORKSPACE_SCOPE }),
    ...(env.LEDGERMIND_MCP_BRANCH_SCOPE === undefined
      ? {}
      : { defaultBranchScope: env.LEDGERMIND_MCP_BRANCH_SCOPE }),
  };
};
