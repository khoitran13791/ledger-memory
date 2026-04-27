import { resolve } from 'node:path';

export type CockpitOutput = 'human' | 'json';

export interface InMemoryStorageConfig {
  readonly type: 'in-memory';
}

export interface PostgresStorageConfig {
  readonly type: 'postgres';
  readonly connectionString: string;
}

export type CockpitStorageConfig = InMemoryStorageConfig | PostgresStorageConfig;

export interface CockpitConfig {
  readonly storage: CockpitStorageConfig;
  readonly bindingStorePath: string;
  readonly runtimeSessionId: string;
  readonly parentRuntimeSessionId?: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
  readonly userScope: string;
  readonly output: CockpitOutput;
}

export interface ParseCockpitConfigOptions {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

export interface SplitCommandResult {
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly optionArgs: readonly string[];
}

const OPTIONS_WITH_VALUES = new Set([
  '--binding-store',
  '--branch',
  '--db',
  '--parent-runtime-session',
  '--runtime-session',
  '--storage',
  '--workspace',
]);

const FLAG_OPTIONS = new Set(['--help', '--json', '--yes']);

export const splitCommand = (argv: readonly string[]): SplitCommandResult => {
  const [command = 'help', ...args] = argv;
  const commandArgs: string[] = [];
  const optionArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      commandArgs.push(...args.slice(index + 1));
      break;
    }

    if (!arg.startsWith('--')) {
      commandArgs.push(arg);
      continue;
    }

    optionArgs.push(arg);

    if (OPTIONS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        optionArgs.push(value);
        index += 1;
      }
    }
  }

  return { command, commandArgs, optionArgs };
};

export const parseCockpitConfig = ({
  argv,
  env,
  cwd,
}: ParseCockpitConfigOptions): CockpitConfig => {
  let connectionString = env.LEDGERMIND_DB_URL;
  let storageType: string | undefined;
  let bindingStorePath =
    env.LEDGERMIND_MCP_BINDING_STORE ?? resolve(cwd, '.ledgermind/session-bindings.json');
  let runtimeSessionId = env.LEDGERMIND_COCKPIT_RUNTIME_SESSION ?? 'workspace';
  let parentRuntimeSessionId = env.LEDGERMIND_COCKPIT_PARENT_RUNTIME_SESSION;
  let workspaceScope = env.LEDGERMIND_COCKPIT_WORKSPACE ?? cwd;
  let branchScope = env.LEDGERMIND_COCKPIT_BRANCH;
  let output: CockpitOutput = 'human';

  const optionSourceArgs = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  const optionArgs = optionSourceArgs.filter((arg, index) => {
    if (arg.startsWith('--')) {
      return true;
    }

    const previous = optionSourceArgs[index - 1];
    return previous !== undefined && OPTIONS_WITH_VALUES.has(previous);
  });

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    if (option === undefined) {
      continue;
    }

    if (!option.startsWith('--')) {
      continue;
    }

    if (!OPTIONS_WITH_VALUES.has(option) && !FLAG_OPTIONS.has(option)) {
      throw new Error(`Unknown option "${option}".`);
    }

    if (option === '--help' || option === '--yes') {
      continue;
    }

    if (option === '--json') {
      output = 'json';
      continue;
    }

    const value = optionArgs[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a value.`);
    }

    index += 1;

    switch (option) {
      case '--binding-store':
        bindingStorePath = value;
        break;
      case '--branch':
        branchScope = value;
        break;
      case '--db':
        connectionString = value;
        storageType = 'postgres';
        break;
      case '--runtime-session':
        runtimeSessionId = value;
        break;
      case '--parent-runtime-session':
        parentRuntimeSessionId = value;
        break;
      case '--storage':
        storageType = value;
        break;
      case '--workspace':
        workspaceScope = value;
        break;
    }
  }

  const storage = createStorageConfig(storageType, connectionString);

  return {
    storage,
    bindingStorePath,
    runtimeSessionId,
    ...(parentRuntimeSessionId === undefined ? {} : { parentRuntimeSessionId }),
    workspaceScope,
    ...(branchScope === undefined ? {} : { branchScope }),
    userScope: env.LEDGERMIND_COCKPIT_USER ?? env.USER ?? env.LOGNAME ?? 'local-user',
    output,
  };
};

const createStorageConfig = (
  storageType: string | undefined,
  connectionString: string | undefined,
): CockpitStorageConfig => {
  if (storageType === undefined) {
    return connectionString === undefined || connectionString.trim().length === 0
      ? { type: 'in-memory' }
      : { type: 'postgres', connectionString };
  }

  if (storageType === 'in-memory') {
    return { type: 'in-memory' };
  }

  if (storageType !== 'postgres') {
    throw new Error(`Unsupported storage type "${storageType}".`);
  }

  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error('Postgres storage requires --db or LEDGERMIND_DB_URL.');
  }

  return { type: 'postgres', connectionString };
};
