# Memory Cockpit CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local `ledgermind` cockpit CLI that lets humans and coding agents inspect, recall, and write useful memory without learning the internal DAG vocabulary first.

**Architecture:** Add a thin `packages/cli` package at the outer edge of the monorepo. It reuses the existing SDK engine, MCP session binding store, and Postgres infrastructure. The only shared plumbing change is making session binding able to create a real backing conversation when a caller supplies a conversation factory.

**Tech Stack:** TypeScript strict ESM, Node.js 22, pnpm workspaces, Vitest, existing `@ledgermind/sdk`, `@ledgermind/mcp-server` session binding store, `@ledgermind/infrastructure` Postgres adapters.

---

## Product Scope

V1 commands:

- `ledgermind status` shows storage, binding store, active workspace binding, and memory health.
- `ledgermind doctor` checks Node version, storage config, Postgres reachability, binding-store readability/writability, and gives concrete fixes.
- `ledgermind remember <text>` appends a manual memory note to the active workspace conversation.
- `ledgermind recall <query>` searches the active workspace conversation.
- `ledgermind timeline` shows recent remembered events using a broad regex search over the ledger.
- `ledgermind explain <id>` describes a summary or artifact reference.
- `ledgermind source <summary-id> --yes` expands raw source messages behind a summary, with an explicit confirmation flag.

Not in V1:

- No dashboard UI.
- No new storage backend.
- No HTTP server.
- No general workflow engine.
- No broad refactor of `MemoryEngine`.
- No automatic Claude `UserPromptSubmit` injection. That is the next product step after cockpit CLI.

## UX Contract

Default human output is compact, readable text. Every command supports `--json` for coding agents.

All commands share these options:

```text
--db <connection-string>          Use Postgres storage.
--storage <postgres|in-memory>    Select storage. Commands that persist memory require Postgres in V1.
--binding-store <path>            Binding store path. Defaults to .ledgermind/session-bindings.json.
--runtime-session <id>            Stable session key. Defaults to workspace.
--workspace <path>                Workspace scope. Defaults to process.cwd().
--branch <name>                   Optional branch scope.
--json                            Emit machine-readable JSON.
--help                            Show help.
```

V1 persistence rule:

- `status` and `doctor` can run with no database.
- `remember`, `recall`, `timeline`, `explain`, and `source` require Postgres unless a test injects a fake runtime.
- If no database is configured, the CLI prints: `Memory commands need --db or LEDGERMIND_DB_URL for durable storage. Run ledgermind doctor for setup help.`

## File Structure

Create:

- `packages/cli/package.json` - package metadata, scripts, and `ledgermind` bin.
- `packages/cli/tsconfig.json` - project references to domain, application, mcp-server, sdk, infrastructure.
- `packages/cli/src/cli.ts` - Node entrypoint and top-level dispatch.
- `packages/cli/src/index.ts` - public exports for tests and future package consumers.
- `packages/cli/src/config.ts` - shared option parser and help text.
- `packages/cli/src/runtime.ts` - creates engine, binding store, Postgres conversation store, and active binding.
- `packages/cli/src/commands/status.ts` - `status` command.
- `packages/cli/src/commands/doctor.ts` - `doctor` command.
- `packages/cli/src/commands/remember.ts` - `remember` command.
- `packages/cli/src/commands/recall.ts` - `recall` command.
- `packages/cli/src/commands/timeline.ts` - `timeline` command.
- `packages/cli/src/commands/explain.ts` - `explain` command.
- `packages/cli/src/commands/source.ts` - `source` command.
- `packages/cli/src/formatters.ts` - human and JSON output helpers.
- `packages/cli/src/__tests__/config.test.ts`
- `packages/cli/src/__tests__/runtime.test.ts`
- `packages/cli/src/__tests__/cli.test.ts`
- `packages/cli/src/__tests__/commands.test.ts`

Modify:

- `package.json` - add root scripts `cockpit:dev` and `cockpit:smoke`.
- `tsconfig.base.json` - add `@ledgermind/cli` path alias.
- `packages/mcp-server/src/session-binding.ts` - allow optional conversation creation during binding resolution.
- `packages/mcp-server/src/__tests__/session-binding.test.ts` - cover real-conversation binding.
- `README.md` - add cockpit CLI quickstart.
- `docs/claude-code-integration.md` - point users to `ledgermind status`, `recall`, and `doctor`.

## Task 1: Scaffold `@ledgermind/cli`

**Files:**

- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/cli.ts`
- Modify: `package.json`
- Modify: `tsconfig.base.json`
- Test: `packages/cli/src/__tests__/cli.test.ts`

- [ ] **Step 1: Create the package metadata**

Create `packages/cli/package.json`:

```json
{
  "name": "@ledgermind/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "ledgermind": "dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "lint": "eslint src --ext .ts",
    "test": "vitest run --passWithNoTests",
    "dev": "node --experimental-strip-types src/cli.ts",
    "smoke": "node --experimental-strip-types src/cli.ts --help",
    "clean": "rm -rf dist tsconfig.tsbuildinfo"
  },
  "dependencies": {
    "@ledgermind/application": "workspace:*",
    "@ledgermind/domain": "workspace:*",
    "@ledgermind/infrastructure": "workspace:*",
    "@ledgermind/mcp-server": "workspace:*",
    "@ledgermind/sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.18.0",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create the TypeScript project**

Create `packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../domain" },
    { "path": "../application" },
    { "path": "../infrastructure" },
    { "path": "../mcp-server" },
    { "path": "../sdk" }
  ]
}
```

- [ ] **Step 3: Add the root package alias**

Modify `tsconfig.base.json` paths:

```json
"@ledgermind/cli": ["packages/cli/src/index.ts"]
```

- [ ] **Step 4: Add root scripts**

Modify root `package.json` scripts:

```json
"cockpit:dev": "pnpm --filter @ledgermind/cli dev",
"cockpit:smoke": "pnpm --filter @ledgermind/cli smoke"
```

- [ ] **Step 5: Add the initial entrypoint**

Create `packages/cli/src/cli.ts`:

```ts
#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly stdout?: Pick<NodeJS.WritableStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WritableStream, 'write'>;
}

const HELP = `Usage: ledgermind <command> [options]

Commands:
  status              Show memory cockpit status.
  doctor              Check local LedgerMind setup.
  remember <text>     Append a manual memory note.
  recall <query>      Search remembered work.
  timeline            Show recent memory events.
  explain <id>        Describe a summary or artifact.
  source <summary-id> Expand raw source messages with --yes.
  help                Show this help text.
`;

export const runCli = async ({
  argv = process.argv.slice(2),
  stdout = process.stdout,
}: RunCliOptions = {}): Promise<number> => {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    stdout.write(HELP);
    return 0;
  }

  stdout.write(`Command "${argv[0]}" is not implemented yet.\n`);
  return 1;
};

const main = async (): Promise<void> => {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
```

Create `packages/cli/src/index.ts`:

```ts
export { runCli } from './cli';
```

- [ ] **Step 6: Add the first smoke test**

Create `packages/cli/src/__tests__/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { runCli } from '../cli';

const createWritable = () => {
  let output = '';
  return {
    stream: {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    },
    read: () => output,
  };
};

describe('ledgermind CLI', () => {
  it('prints help when no command is provided', async () => {
    const stdout = createWritable();

    const exitCode = await runCli({ argv: [], stdout: stdout.stream });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain('Usage: ledgermind <command>');
    expect(stdout.read()).toContain('remember <text>');
  });

  it('returns non-zero for an unknown command', async () => {
    const stdout = createWritable();

    const exitCode = await runCli({ argv: ['wat'], stdout: stdout.stream });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toContain('Command "wat" is not implemented yet.');
  });
});
```

- [ ] **Step 7: Verify scaffold**

Run:

```bash
pnpm --filter @ledgermind/cli test
pnpm --filter @ledgermind/cli typecheck
pnpm --filter @ledgermind/cli lint
pnpm cockpit:smoke
```

Expected:

- CLI package tests pass.
- Typecheck passes.
- Lint passes.
- Smoke prints help.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.base.json packages/cli
git commit -m "feat: scaffold memory cockpit cli"
```

## Task 2: Make Session Bindings Able To Create Real Conversations

**Files:**

- Modify: `packages/mcp-server/src/session-binding.ts`
- Modify: `packages/mcp-server/src/__tests__/session-binding.test.ts`

The problem: current binding resolution can mint a `conversationId` that does not exist in storage. `remember` cannot append to a missing conversation. Fix this once in the shared binding utility.

- [ ] **Step 1: Add a failing binding test**

Append to `packages/mcp-server/src/__tests__/session-binding.test.ts`:

```ts
it('uses a supplied conversation factory for new bindings', async () => {
  const store = createInMemorySessionBindingStore();
  const createdIds: string[] = [];

  const first = await resolveSessionBinding(store, {
    ...createBaseInput(),
    createConversation: async () => {
      createdIds.push('conv_real_001');
      return createConversationId('conv_real_001');
    },
  });

  const second = await resolveSessionBinding(store, {
    ...createBaseInput(),
    createConversation: async () => {
      createdIds.push('conv_real_002');
      return createConversationId('conv_real_002');
    },
  });

  expect(first.conversationId).toBe(createConversationId('conv_real_001'));
  expect(second.conversationId).toBe(createConversationId('conv_real_001'));
  expect(createdIds).toEqual(['conv_real_001']);
});

it('passes parent conversation id into the supplied conversation factory', async () => {
  const store = createInMemorySessionBindingStore();
  const parent = await resolveSessionBinding(store, {
    ...createBaseInput({ runtimeSessionId: 'thread-parent' }),
    createConversation: async () => createConversationId('conv_parent_real'),
  });

  const child = await resolveSessionBinding(store, {
    ...createBaseInput({
      runtimeSessionId: 'thread-child',
      parentRuntimeSessionId: 'thread-parent',
    }),
    createConversation: async ({ parentConversationId }) => {
      expect(parentConversationId).toBe(parent.conversationId);
      return createConversationId('conv_child_real');
    },
  });

  expect(child.parentConversationId).toBe(parent.conversationId);
  expect(child.conversationId).toBe(createConversationId('conv_child_real'));
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/session-binding.test.ts
```

Expected: FAIL because `createConversation` is not accepted yet.

- [ ] **Step 3: Extend `ResolveSessionBindingInput`**

Modify `packages/mcp-server/src/session-binding.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { createConversationId, type ConversationId } from '@ledgermind/domain';

export interface ResolveConversationBindingInput {
  readonly parentConversationId?: ConversationId;
}

export interface ResolveSessionBindingInput extends SessionBindingLookup {
  readonly parentRuntimeSessionId?: string;
  createConversation?(input: ResolveConversationBindingInput): Promise<ConversationId>;
}
```

Then replace the generated `conversationId` in `resolveSessionBinding`:

```ts
  const conversationId =
    input.createConversation === undefined
      ? createConversationId(`conv_${randomUUID()}`)
      : await input.createConversation({
          ...(parentConversationId === undefined ? {} : { parentConversationId }),
        });

  const nextBinding: SessionBindingRecord = {
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId,
    userScope: input.userScope,
    workspaceScope: input.workspaceScope,
    ...(input.branchScope === undefined ? {} : { branchScope: input.branchScope }),
    conversationId,
    ...(parentConversationId === undefined ? {} : { parentConversationId }),
  };
```

- [ ] **Step 4: Verify binding tests pass**

Run:

```bash
pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/session-binding.test.ts
pnpm --filter @ledgermind/mcp-server typecheck
pnpm --filter @ledgermind/mcp-server lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/session-binding.ts packages/mcp-server/src/__tests__/session-binding.test.ts
git commit -m "fix: bind sessions to real conversations"
```

## Task 3: Add CLI Config Parsing

**Files:**

- Create: `packages/cli/src/config.ts`
- Create: `packages/cli/src/__tests__/config.test.ts`

- [ ] **Step 1: Write config parser tests**

Create `packages/cli/src/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseCockpitConfig, splitCommand } from '../config';

describe('splitCommand', () => {
  it('separates command args from shared options', () => {
    expect(splitCommand(['recall', 'bridge selection', '--json'])).toEqual({
      command: 'recall',
      commandArgs: ['bridge selection'],
      optionArgs: ['--json'],
    });
  });
});

describe('parseCockpitConfig', () => {
  it('defaults to workspace binding store and workspace runtime session', () => {
    const config = parseCockpitConfig({
      argv: [],
      env: { USER: 'khoi' },
      cwd: '/repo',
    });

    expect(config.bindingStorePath).toBe('/repo/.ledgermind/session-bindings.json');
    expect(config.runtimeSessionId).toBe('workspace');
    expect(config.userScope).toBe('khoi');
    expect(config.workspaceScope).toBe('/repo');
    expect(config.output).toBe('human');
  });

  it('parses postgres storage from --db', () => {
    const config = parseCockpitConfig({
      argv: ['--db', 'postgres://localhost/ledgermind', '--json'],
      env: {},
      cwd: '/repo',
    });

    expect(config.storage).toEqual({
      type: 'postgres',
      connectionString: 'postgres://localhost/ledgermind',
    });
    expect(config.output).toBe('json');
  });

  it('rejects unsupported storage', () => {
    expect(() =>
      parseCockpitConfig({
        argv: ['--storage', 'sqlite'],
        env: {},
        cwd: '/repo',
      }),
    ).toThrow('Unsupported storage type "sqlite".');
  });
});
```

- [ ] **Step 2: Implement config parsing**

Create `packages/cli/src/config.ts`:

```ts
import { resolve } from 'node:path';

export type CockpitStorageConfig =
  | { readonly type: 'in-memory' }
  | { readonly type: 'postgres'; readonly connectionString: string };

export interface CockpitConfig {
  readonly storage: CockpitStorageConfig;
  readonly bindingStorePath: string;
  readonly runtimeSessionId: string;
  readonly userScope: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
  readonly output: 'human' | 'json';
}

export interface SplitCommandOutput {
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly optionArgs: readonly string[];
}

interface ParseCockpitConfigOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const readFlagValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

export const splitCommand = (argv: readonly string[]): SplitCommandOutput => {
  const command = argv[0] ?? 'help';
  const commandArgs: string[] = [];
  const optionArgs: string[] = [];

  for (const arg of argv.slice(1)) {
    if (arg.startsWith('--')) {
      optionArgs.push(arg);
    } else if (optionArgs.length > 0 && optionArgs.at(-1)?.startsWith('--') === true) {
      optionArgs.push(arg);
    } else {
      commandArgs.push(arg);
    }
  }

  return { command, commandArgs, optionArgs };
};

export const parseCockpitConfig = ({
  argv,
  env = process.env,
  cwd = process.cwd(),
}: ParseCockpitConfigOptions): CockpitConfig => {
  let storageType: 'in-memory' | 'postgres' = env.LEDGERMIND_DB_URL ? 'postgres' : 'in-memory';
  let connectionString = env.LEDGERMIND_DB_URL;
  let bindingStorePath = env.LEDGERMIND_MCP_BINDING_STORE ?? resolve(cwd, '.ledgermind/session-bindings.json');
  let runtimeSessionId = env.LEDGERMIND_COCKPIT_RUNTIME_SESSION ?? 'workspace';
  let workspaceScope = env.LEDGERMIND_COCKPIT_WORKSPACE ?? cwd;
  let branchScope = env.LEDGERMIND_COCKPIT_BRANCH;
  let output: 'human' | 'json' = 'human';

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
      case '--runtime-session': {
        runtimeSessionId = readFlagValue(argv, index, '--runtime-session');
        index += 1;
        break;
      }
      case '--workspace': {
        workspaceScope = readFlagValue(argv, index, '--workspace');
        index += 1;
        break;
      }
      case '--branch': {
        branchScope = readFlagValue(argv, index, '--branch');
        index += 1;
        break;
      }
      case '--json': {
        output = 'json';
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

  if (storageType === 'postgres' && (connectionString === undefined || connectionString.trim().length === 0)) {
    throw new Error('Postgres storage requires --db or LEDGERMIND_DB_URL.');
  }

  return {
    storage:
      storageType === 'postgres'
        ? { type: 'postgres', connectionString: connectionString ?? '' }
        : { type: 'in-memory' },
    bindingStorePath,
    runtimeSessionId,
    userScope: env.LEDGERMIND_COCKPIT_USER ?? env.USER ?? env.LOGNAME ?? 'local-user',
    workspaceScope,
    ...(branchScope === undefined ? {} : { branchScope }),
    output,
  };
};
```

- [ ] **Step 3: Verify config**

Run:

```bash
pnpm --filter @ledgermind/cli test -- --run src/__tests__/config.test.ts
pnpm --filter @ledgermind/cli typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/__tests__/config.test.ts
git commit -m "feat: parse memory cockpit cli config"
```

## Task 4: Add Cockpit Runtime And Binding Creation

**Files:**

- Create: `packages/cli/src/runtime.ts`
- Create: `packages/cli/src/__tests__/runtime.test.ts`

- [ ] **Step 1: Write runtime tests with fake dependencies**

Create `packages/cli/src/__tests__/runtime.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createConversationId } from '@ledgermind/domain';
import { createInMemorySessionBindingStore } from '@ledgermind/mcp-server';

import { resolveCockpitBinding } from '../runtime';

describe('resolveCockpitBinding', () => {
  it('creates a real conversation for a new workspace binding', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi.fn(async () => createConversationId('conv_cli_001'));

    const binding = await resolveCockpitBinding({
      store,
      config: {
        storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
        bindingStorePath: '.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'human',
      },
      createConversation,
    });

    expect(binding.conversationId).toBe(createConversationId('conv_cli_001'));
    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing workspace binding', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi.fn(async () => createConversationId('conv_cli_001'));

    await resolveCockpitBinding({
      store,
      config: {
        storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
        bindingStorePath: '.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'human',
      },
      createConversation,
    });
    await resolveCockpitBinding({
      store,
      config: {
        storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
        bindingStorePath: '.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'human',
      },
      createConversation,
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement runtime helpers**

Create `packages/cli/src/runtime.ts`:

```ts
import type { MemoryEngine } from '@ledgermind/application';
import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  type ConversationId,
} from '@ledgermind/domain';
import { createPgPool, PgConversationStore, asPgExecutor } from '@ledgermind/infrastructure';
import {
  createFileSessionBindingStore,
  resolveSessionBinding,
  type SessionBindingRecord,
  type SessionBindingStore,
} from '@ledgermind/mcp-server';
import { createPostgresMemoryEngine } from '@ledgermind/sdk';

import type { CockpitConfig } from './config';

export interface CockpitRuntime {
  readonly engine: MemoryEngine;
  readonly bindingStore: SessionBindingStore;
  readonly resolveBinding: () => Promise<SessionBindingRecord>;
  close(): Promise<void>;
}

export interface ResolveCockpitBindingInput {
  readonly store: SessionBindingStore;
  readonly config: CockpitConfig;
  createConversation(input: { readonly parentConversationId?: ConversationId }): Promise<ConversationId>;
}

const createDefaultConversationConfig = () =>
  createConversationConfig({
    modelName: 'ledgermind-cli',
    contextWindow: createTokenCount(32_768),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });

export const resolveCockpitBinding = ({
  store,
  config,
  createConversation,
}: ResolveCockpitBindingInput): Promise<SessionBindingRecord> =>
  resolveSessionBinding(store, {
    runtime: 'ledgermind-cli',
    runtimeSessionId: config.runtimeSessionId,
    userScope: config.userScope,
    workspaceScope: config.workspaceScope,
    ...(config.branchScope === undefined ? {} : { branchScope: config.branchScope }),
    createConversation,
  });

export const createCockpitRuntime = (config: CockpitConfig): CockpitRuntime => {
  if (config.storage.type !== 'postgres') {
    throw new Error('Memory commands need --db or LEDGERMIND_DB_URL for durable storage. Run ledgermind doctor for setup help.');
  }

  const pool = createPgPool({ connectionString: config.storage.connectionString });
  const executor = asPgExecutor(pool);
  const conversations = new PgConversationStore(executor);
  const engine = createPostgresMemoryEngine({ connectionString: config.storage.connectionString });
  const bindingStore = createFileSessionBindingStore(config.bindingStorePath);

  return {
    engine,
    bindingStore,
    resolveBinding: () =>
      resolveCockpitBinding({
        store: bindingStore,
        config,
        createConversation: async ({ parentConversationId }) => {
          const conversation = await conversations.create(
            createDefaultConversationConfig(),
            parentConversationId,
          );
          return conversation.id;
        },
      }),
    async close() {
      await pool.end();
    },
  };
};
```

- [ ] **Step 3: Verify runtime**

Run:

```bash
pnpm --filter @ledgermind/cli test -- --run src/__tests__/runtime.test.ts
pnpm --filter @ledgermind/cli typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/runtime.ts packages/cli/src/__tests__/runtime.test.ts
git commit -m "feat: create memory cockpit runtime"
```

## Task 5: Implement `status` And `doctor`

**Files:**

- Create: `packages/cli/src/formatters.ts`
- Create: `packages/cli/src/commands/status.ts`
- Create: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/src/__tests__/commands.test.ts`

- [ ] **Step 1: Write command tests**

Create `packages/cli/src/__tests__/commands.test.ts` with the first command cases:

```ts
import { describe, expect, it } from 'vitest';

import { runStatusCommand } from '../commands/status';
import { runDoctorCommand } from '../commands/doctor';

describe('status command', () => {
  it('renders human status without requiring postgres', async () => {
    const output = await runStatusCommand({
      config: {
        storage: { type: 'in-memory' },
        bindingStorePath: '/repo/.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'human',
      },
      listBindings: async () => [],
    });

    expect(output).toContain('LedgerMind status');
    expect(output).toContain('Storage: in-memory');
    expect(output).toContain('Bindings: 0');
  });

  it('renders JSON status for agents', async () => {
    const output = await runStatusCommand({
      config: {
        storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
        bindingStorePath: '/repo/.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'json',
      },
      listBindings: async () => [],
    });

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      storage: { type: 'postgres' },
      bindingCount: 0,
    });
  });
});

describe('doctor command', () => {
  it('reports missing durable storage as actionable setup guidance', async () => {
    const output = await runDoctorCommand({
      config: {
        storage: { type: 'in-memory' },
        bindingStorePath: '/repo/.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'human',
      },
      checkPostgres: async () => ({ ok: false, message: 'not configured' }),
    });

    expect(output).toContain('Postgres: not configured');
    expect(output).toContain('Set LEDGERMIND_DB_URL or pass --db');
  });
});
```

- [ ] **Step 2: Implement formatters**

Create `packages/cli/src/formatters.ts`:

```ts
export const asJsonLine = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const bullet = (label: string, value: string | number): string => `${label}: ${value}\n`;

export const okLabel = (ok: boolean): string => (ok ? 'ok' : 'not configured');
```

- [ ] **Step 3: Implement `status`**

Create `packages/cli/src/commands/status.ts`:

```ts
import { createFileSessionBindingStore, type SessionBindingRecord } from '@ledgermind/mcp-server';

import type { CockpitConfig } from '../config';
import { asJsonLine, bullet } from '../formatters';

export interface RunStatusCommandInput {
  readonly config: CockpitConfig;
  listBindings?(): Promise<readonly SessionBindingRecord[]>;
}

export const runStatusCommand = async ({
  config,
  listBindings = () => createFileSessionBindingStore(config.bindingStorePath).list(),
}: RunStatusCommandInput): Promise<string> => {
  const bindings = await listBindings();

  if (config.output === 'json') {
    return asJsonLine({
      ok: true,
      storage: { type: config.storage.type },
      bindingStorePath: config.bindingStorePath,
      bindingCount: bindings.length,
      runtimeSessionId: config.runtimeSessionId,
      workspaceScope: config.workspaceScope,
      ...(config.branchScope === undefined ? {} : { branchScope: config.branchScope }),
    });
  }

  return [
    'LedgerMind status\n',
    bullet('Storage', config.storage.type),
    bullet('Binding store', config.bindingStorePath),
    bullet('Bindings', bindings.length),
    bullet('Runtime session', config.runtimeSessionId),
    bullet('Workspace', config.workspaceScope),
    config.branchScope === undefined ? '' : bullet('Branch', config.branchScope),
  ].join('');
};
```

- [ ] **Step 4: Implement `doctor`**

Create `packages/cli/src/commands/doctor.ts`:

```ts
import type { CockpitConfig } from '../config';
import { asJsonLine } from '../formatters';

export interface DoctorCheck {
  readonly ok: boolean;
  readonly message: string;
  readonly fix?: string;
}

export interface RunDoctorCommandInput {
  readonly config: CockpitConfig;
  checkPostgres?(): Promise<DoctorCheck>;
}

const checkNodeVersion = (): DoctorCheck => {
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  return major >= 22
    ? { ok: true, message: `Node ${process.versions.node}` }
    : { ok: false, message: `Node ${process.versions.node}`, fix: 'Install Node.js >=22.' };
};

export const runDoctorCommand = async ({
  config,
  checkPostgres = async () =>
    config.storage.type === 'postgres'
      ? { ok: true, message: 'configured' }
      : {
          ok: false,
          message: 'not configured',
          fix: 'Set LEDGERMIND_DB_URL or pass --db <postgres-url>.',
        },
}: RunDoctorCommandInput): Promise<string> => {
  const checks = {
    node: checkNodeVersion(),
    postgres: await checkPostgres(),
    bindingStore: { ok: true, message: config.bindingStorePath },
  };

  if (config.output === 'json') {
    return asJsonLine({
      ok: Object.values(checks).every((check) => check.ok),
      checks,
    });
  }

  return [
    'LedgerMind doctor\n',
    `Node: ${checks.node.message}${checks.node.fix === undefined ? '' : `\n  Fix: ${checks.node.fix}`}\n`,
    `Postgres: ${checks.postgres.message}${checks.postgres.fix === undefined ? '' : `\n  Fix: ${checks.postgres.fix}`}\n`,
    `Binding store: ${checks.bindingStore.message}\n`,
  ].join('');
};
```

- [ ] **Step 5: Wire commands into `runCli`**

Modify `packages/cli/src/cli.ts` so it uses `splitCommand`, `parseCockpitConfig`, `runStatusCommand`, and `runDoctorCommand`.

Expected dispatch shape:

```ts
const { command, commandArgs, optionArgs } = splitCommand(argv);
const config = parseCockpitConfig({ argv: optionArgs });

switch (command) {
  case 'status':
    stdout.write(await runStatusCommand({ config }));
    return 0;
  case 'doctor':
    stdout.write(await runDoctorCommand({ config }));
    return 0;
}
```

- [ ] **Step 6: Verify status and doctor**

Run:

```bash
pnpm --filter @ledgermind/cli test -- --run src/__tests__/commands.test.ts
pnpm --filter @ledgermind/cli test
pnpm cockpit:dev -- status
pnpm cockpit:dev -- doctor
```

Expected: tests pass, `status` prints local config, `doctor` explains missing DB if `LEDGERMIND_DB_URL` is unset.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add memory cockpit status and doctor"
```

## Task 6: Implement `remember`

**Files:**

- Create: `packages/cli/src/commands/remember.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/__tests__/commands.test.ts`

- [ ] **Step 1: Add failing tests**

Append:

```ts
import { createConversationId, createTokenCount } from '@ledgermind/domain';
import { runRememberCommand } from '../commands/remember';

it('appends a manual memory note to the active conversation', async () => {
  const appended: unknown[] = [];

  const output = await runRememberCommand({
    config: {
      storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
      bindingStorePath: '/repo/.ledgermind/session-bindings.json',
      runtimeSessionId: 'workspace',
      userScope: 'khoi',
      workspaceScope: '/repo',
      output: 'human',
    },
    text: 'Bridge summaries should preserve exact evidence anchors.',
    runtime: {
      resolveBinding: async () => ({ conversationId: createConversationId('conv_cli_001') }),
      engine: {
        append: async (input: unknown) => {
          appended.push(input);
          return { appendedEvents: [], contextTokenCount: createTokenCount(12) };
        },
      },
      close: async () => undefined,
    },
  });

  expect(output).toContain('Remembered note in conv_cli_001');
  expect(appended).toHaveLength(1);
  expect(JSON.stringify(appended[0])).toContain('Bridge summaries should preserve exact evidence anchors.');
});
```

- [ ] **Step 2: Implement `remember`**

Create `packages/cli/src/commands/remember.ts`:

```ts
import { createTokenCount, type ConversationId } from '@ledgermind/domain';

import type { CockpitConfig } from '../config';
import { asJsonLine } from '../formatters';
import { createCockpitRuntime, type CockpitRuntime } from '../runtime';

interface MinimalRememberRuntime {
  readonly engine: Pick<CockpitRuntime['engine'], 'append'>;
  resolveBinding(): Promise<{ readonly conversationId: ConversationId }>;
  close(): Promise<void>;
}

export interface RunRememberCommandInput {
  readonly config: CockpitConfig;
  readonly text: string;
  readonly runtime?: MinimalRememberRuntime;
}

const estimateTokenCount = (content: string) => createTokenCount(Math.max(1, Math.ceil(content.length / 4)));

export const runRememberCommand = async ({
  config,
  text,
  runtime = createCockpitRuntime(config),
}: RunRememberCommandInput): Promise<string> => {
  if (text.trim().length === 0) {
    throw new Error('remember requires non-empty text.');
  }

  try {
    const binding = await runtime.resolveBinding();
    await runtime.engine.append({
      conversationId: binding.conversationId,
      idempotencyKey: `cli:remember:${config.workspaceScope}:${text}`,
      events: [
        {
          role: 'system',
          content: text,
          tokenCount: estimateTokenCount(text),
          metadata: {
            source: 'ledgermind-cli',
            kind: 'manual_note',
            workspaceScope: config.workspaceScope,
            ...(config.branchScope === undefined ? {} : { branchScope: config.branchScope }),
          },
        },
      ],
    });

    if (config.output === 'json') {
      return asJsonLine({ ok: true, conversationId: String(binding.conversationId) });
    }

    return `Remembered note in ${String(binding.conversationId)}.\n`;
  } finally {
    await runtime.close();
  }
};
```

- [ ] **Step 3: Wire into CLI**

Dispatch:

```ts
case 'remember': {
  stdout.write(await runRememberCommand({ config, text: commandArgs.join(' ') }));
  return 0;
}
```

- [ ] **Step 4: Verify remember**

Run:

```bash
pnpm --filter @ledgermind/cli test -- --run src/__tests__/commands.test.ts
pnpm --filter @ledgermind/cli typecheck
pnpm --filter @ledgermind/cli lint
```

Expected: PASS.

- [ ] **Step 5: Manual Postgres smoke**

Run with a local Postgres database:

```bash
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- remember "Memory cockpit CLI was introduced as the product-first surface."
```

Expected: `Remembered note in conv_...`

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add memory cockpit remember command"
```

## Task 7: Implement `recall` And `timeline`

**Files:**

- Create: `packages/cli/src/commands/recall.ts`
- Create: `packages/cli/src/commands/timeline.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/__tests__/commands.test.ts`

- [ ] **Step 1: Test recall formatting**

Add:

```ts
import { createConversationId, createEventId, createSequenceNumber } from '@ledgermind/domain';
import { runRecallCommand } from '../commands/recall';

it('recalls matching memory events with compact human output', async () => {
  const output = await runRecallCommand({
    config: {
      storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
      bindingStorePath: '/repo/.ledgermind/session-bindings.json',
      runtimeSessionId: 'workspace',
      userScope: 'khoi',
      workspaceScope: '/repo',
      output: 'human',
    },
    query: 'cockpit',
    runtime: {
      resolveBinding: async () => ({ conversationId: createConversationId('conv_cli_001') }),
      engine: {
        grep: async () => ({
          groups: [
            {
              matches: [
                {
                  eventId: createEventId('evt_001'),
                  sequence: createSequenceNumber(0),
                  excerpt: 'Memory cockpit CLI was introduced as the product-first surface.',
                },
              ],
            },
          ],
          page: { offset: 0, limit: 25, returnedMatchCount: 1, totalMatchCount: 1, hasMore: false },
        }),
      },
      close: async () => undefined,
    },
  });

  expect(output).toContain('1 match');
  expect(output).toContain('[0] evt_001');
  expect(output).toContain('product-first surface');
});
```

- [ ] **Step 2: Implement `recall`**

Create `packages/cli/src/commands/recall.ts`:

```ts
import type { GrepOutput } from '@ledgermind/application';

import type { CockpitConfig } from '../config';
import { asJsonLine } from '../formatters';
import { createCockpitRuntime, type CockpitRuntime } from '../runtime';

interface MinimalRecallRuntime {
  readonly engine: Pick<CockpitRuntime['engine'], 'grep'>;
  resolveBinding(): Promise<{ readonly conversationId: Awaited<ReturnType<CockpitRuntime['resolveBinding']>>['conversationId'] }>;
  close(): Promise<void>;
}

export interface RunRecallCommandInput {
  readonly config: CockpitConfig;
  readonly query: string;
  readonly runtime?: MinimalRecallRuntime;
  readonly limit?: number;
}

const formatRecallHuman = (output: GrepOutput): string => {
  const lines = [`${output.page.totalMatchCount} match${output.page.totalMatchCount === 1 ? '' : 'es'}\n`];

  for (const group of output.groups) {
    for (const match of group.matches) {
      lines.push(`[${match.sequence}] ${match.eventId}: ${match.excerpt}\n`);
    }
  }

  if (output.page.hasMore) {
    lines.push(`More results available at offset ${output.page.nextOffset}.\n`);
  }

  return lines.join('');
};

export const runRecallCommand = async ({
  config,
  query,
  runtime = createCockpitRuntime(config),
  limit = 25,
}: RunRecallCommandInput): Promise<string> => {
  if (query.trim().length === 0) {
    throw new Error('recall requires a non-empty query.');
  }

  try {
    const binding = await runtime.resolveBinding();
    const output = await runtime.engine.grep({
      conversationId: binding.conversationId,
      pattern: query,
      limit,
    });

    return config.output === 'json' ? asJsonLine({ ok: true, data: output }) : formatRecallHuman(output);
  } finally {
    await runtime.close();
  }
};
```

- [ ] **Step 3: Implement `timeline` as broad recall**

Create `packages/cli/src/commands/timeline.ts`:

```ts
import type { CockpitConfig } from '../config';
import { runRecallCommand } from './recall';

export const runTimelineCommand = (input: {
  readonly config: CockpitConfig;
  readonly limit?: number;
  readonly runtime?: Parameters<typeof runRecallCommand>[0]['runtime'];
}): Promise<string> =>
  runRecallCommand({
    config: input.config,
    query: '.+',
    limit: input.limit ?? 25,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  });
```

- [ ] **Step 4: Wire into CLI**

Dispatch:

```ts
case 'recall': {
  stdout.write(await runRecallCommand({ config, query: commandArgs.join(' ') }));
  return 0;
}
case 'timeline': {
  stdout.write(await runTimelineCommand({ config }));
  return 0;
}
```

- [ ] **Step 5: Verify recall and timeline**

Run:

```bash
pnpm --filter @ledgermind/cli test -- --run src/__tests__/commands.test.ts
pnpm --filter @ledgermind/cli typecheck
pnpm --filter @ledgermind/cli lint
```

Manual smoke after Task 6:

```bash
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- recall cockpit
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- timeline
```

Expected: the remembered cockpit note appears.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add memory cockpit recall and timeline"
```

## Task 8: Implement `explain` And Guarded `source`

**Files:**

- Create: `packages/cli/src/commands/explain.ts`
- Create: `packages/cli/src/commands/source.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/__tests__/commands.test.ts`

- [ ] **Step 1: Test `source` requires explicit confirmation**

Add:

```ts
import { runSourceCommand } from '../commands/source';

it('refuses source expansion without --yes', async () => {
  await expect(
    runSourceCommand({
      config: {
        storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
        bindingStorePath: '/repo/.ledgermind/session-bindings.json',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        output: 'human',
      },
      summaryId: 'sum_001',
      confirmed: false,
    }),
  ).rejects.toThrow('source reveals raw remembered messages; rerun with --yes to confirm.');
});
```

- [ ] **Step 2: Implement `explain`**

Create `packages/cli/src/commands/explain.ts`:

```ts
import type { DescribeOutput } from '@ledgermind/application';

import type { CockpitConfig } from '../config';
import { asJsonLine } from '../formatters';
import { createCockpitRuntime, type CockpitRuntime } from '../runtime';

interface MinimalExplainRuntime {
  readonly engine: Pick<CockpitRuntime['engine'], 'describe'>;
  close(): Promise<void>;
}

const formatDescribeHuman = (id: string, output: DescribeOutput): string =>
  [
    `Reference ${id}\n`,
    `Kind: ${output.kind}\n`,
    `Tokens: ${output.tokenCount.value}\n`,
    output.explorationSummary === undefined ? '' : `Summary: ${output.explorationSummary}\n`,
  ].join('');

export const runExplainCommand = async ({
  config,
  id,
  runtime = createCockpitRuntime(config),
}: {
  readonly config: CockpitConfig;
  readonly id: string;
  readonly runtime?: MinimalExplainRuntime;
}): Promise<string> => {
  if (id.trim().length === 0) {
    throw new Error('explain requires a summary or artifact id.');
  }

  try {
    const output = await runtime.engine.describe({ id: id as Parameters<CockpitRuntime['engine']['describe']>[0]['id'] });
    return config.output === 'json' ? asJsonLine({ ok: true, data: output }) : formatDescribeHuman(id, output);
  } finally {
    await runtime.close();
  }
};
```

- [ ] **Step 3: Implement guarded `source`**

Create `packages/cli/src/commands/source.ts`:

```ts
import { createSummaryNodeId } from '@ledgermind/domain';

import type { CockpitConfig } from '../config';
import { asJsonLine } from '../formatters';
import { createCockpitRuntime, type CockpitRuntime } from '../runtime';

interface MinimalSourceRuntime {
  readonly engine: Pick<CockpitRuntime['engine'], 'expand'>;
  resolveBinding(): Promise<Awaited<ReturnType<CockpitRuntime['resolveBinding']>>>;
  close(): Promise<void>;
}

export const runSourceCommand = async ({
  config,
  summaryId,
  confirmed,
  runtime = createCockpitRuntime(config),
}: {
  readonly config: CockpitConfig;
  readonly summaryId: string;
  readonly confirmed: boolean;
  readonly runtime?: MinimalSourceRuntime;
}): Promise<string> => {
  if (!confirmed) {
    throw new Error('source reveals raw remembered messages; rerun with --yes to confirm.');
  }

  try {
    const binding = await runtime.resolveBinding();
    const output = await runtime.engine.expand({
      summaryId: createSummaryNodeId(summaryId),
      callerContext: {
        conversationId: binding.conversationId,
        isSubAgent: true,
        ...(binding.parentConversationId === undefined ? {} : { parentConversationId: binding.parentConversationId }),
      },
    });

    if (config.output === 'json') {
      return asJsonLine({ ok: true, data: output });
    }

    return output.messages.map((message) => `[${message.sequence}] ${message.role}: ${message.content}\n`).join('');
  } finally {
    await runtime.close();
  }
};
```

- [ ] **Step 4: Wire commands**

Dispatch:

```ts
case 'explain': {
  stdout.write(await runExplainCommand({ config, id: commandArgs[0] ?? '' }));
  return 0;
}
case 'source': {
  stdout.write(
    await runSourceCommand({
      config,
      summaryId: commandArgs[0] ?? '',
      confirmed: optionArgs.includes('--yes'),
    }),
  );
  return 0;
}
```

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @ledgermind/cli test
pnpm --filter @ledgermind/cli typecheck
pnpm --filter @ledgermind/cli lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add memory cockpit explain and source"
```

## Task 9: Polish Help, Errors, And Agent JSON

**Files:**

- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/formatters.ts`
- Modify: `packages/cli/src/__tests__/cli.test.ts`

- [ ] **Step 1: Add tests for JSON error output**

Add:

```ts
it('prints JSON error envelopes when --json is present', async () => {
  const stdout = createWritable();
  const stderr = createWritable();

  const exitCode = await runCli({
    argv: ['remember', '', '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  expect(exitCode).toBe(1);
  expect(JSON.parse(stderr.read())).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('remember requires non-empty text') },
  });
});
```

- [ ] **Step 2: Add shared error envelope**

In `packages/cli/src/formatters.ts`:

```ts
export const errorJsonLine = (error: unknown): string =>
  asJsonLine({
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
    },
  });
```

- [ ] **Step 3: Make `runCli` catch command errors**

In `runCli`, wrap command dispatch:

```ts
try {
  // existing switch
} catch (error) {
  if (optionArgs.includes('--json')) {
    stderr.write(errorJsonLine(error));
  } else {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 1;
}
```

- [ ] **Step 4: Verify polish**

Run:

```bash
pnpm --filter @ledgermind/cli test
pnpm cockpit:smoke
```

Expected: PASS and help remains readable.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "feat: polish memory cockpit cli output"
```

## Task 10: Documentation And Examples

**Files:**

- Modify: `README.md`
- Modify: `docs/claude-code-integration.md`
- Create: `examples/cli/README.md`

- [ ] **Step 1: Add README quickstart**

Add a section:

````md
## Memory Cockpit CLI

LedgerMind includes a local cockpit CLI for inspecting and writing memory from a terminal:

```bash
pnpm cockpit:dev -- doctor
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- status
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- remember "We chose MCP-first integration for runtime portability."
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- recall MCP-first
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm cockpit:dev -- timeline
```

Use `--json` on any command for agent-readable output.
````

- [ ] **Step 2: Add CLI examples**

Create `examples/cli/README.md`:

````md
# LedgerMind CLI Examples

The cockpit CLI is the fastest way to inspect local memory.

## Check setup

```bash
pnpm cockpit:dev -- doctor
```

## Remember a decision

```bash
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm cockpit:dev -- remember "We expose memory.recall as the safe default and keep raw expansion explicit."
```

## Recall prior work

```bash
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm cockpit:dev -- recall "raw expansion"
```

## Agent-readable output

```bash
LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm cockpit:dev -- recall "raw expansion" --json
```
````

- [ ] **Step 3: Update Claude Code integration docs**

Add a "Debug with cockpit" subsection:

````md
### Debug with cockpit

Use the cockpit CLI when Claude Code memory feels stale or empty:

```bash
pnpm cockpit:dev -- doctor
pnpm cockpit:dev -- status
pnpm cockpit:dev -- recall "the thing I expected Claude to remember"
```

This checks the same binding-store path used by the MCP server and Claude hooks.
````

- [ ] **Step 4: Verify docs formatting**

Run:

```bash
pnpm exec prettier --check README.md docs/claude-code-integration.md examples/cli/README.md
```

Expected: Prettier reports all three files formatted.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/claude-code-integration.md examples/cli/README.md
git commit -m "docs: document memory cockpit cli"
```

## Task 11: Final Verification

**Files:**

- No new files unless verification exposes a bug.

- [x] **Step 1: Run focused package checks**

Run:

```bash
pnpm --filter @ledgermind/cli typecheck
pnpm --filter @ledgermind/cli lint
pnpm --filter @ledgermind/cli test
pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/session-binding.test.ts
```

Expected: all pass.

- [x] **Step 2: Run repo static checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass.

- [x] **Step 3: Run a Postgres-backed manual smoke**

With local Postgres running:

```bash
export LEDGERMIND_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
pnpm --filter @ledgermind/infrastructure migrate:up
pnpm cockpit:dev -- doctor
pnpm cockpit:dev -- remember "Cockpit smoke note: recall should find this."
pnpm cockpit:dev -- recall "Cockpit smoke"
pnpm cockpit:dev -- timeline
```

Expected:

- `doctor` reports Postgres configured.
- `remember` writes one note.
- `recall` returns that note.
- `timeline` includes that note.

- [x] **Step 4: Document root test caveat**

If `pnpm test` fails because local Postgres is not running, record:

```text
pnpm test was not a clean local verification because infrastructure tests require Postgres at 127.0.0.1:5432. Focused CLI, MCP session-binding, typecheck, and lint passed.
```

Observed on 2026-04-27: `pg_isready -h 127.0.0.1 -p 5432` returned no response, so the Postgres-backed smoke could not run. `pnpm test` failed after Postgres-backed infrastructure and regression suites attempted to connect to `127.0.0.1:5432`; focused CLI/MCP checks, `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed.

Re-tested after Postgres started on 2026-04-27: migrations completed, the cockpit smoke passed with a temporary binding store, and `pnpm test` passed with 18/18 turbo tasks successful.

If Postgres is running, run:

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 5: Final commit**

```bash
git status --short
git commit -m "feat: ship memory cockpit cli"
```

## Acceptance Criteria

- `pnpm cockpit:smoke` prints help.
- `ledgermind status` works without Postgres and shows binding-store state.
- `ledgermind doctor` gives concrete setup fixes when Postgres is missing.
- With `LEDGERMIND_DB_URL`, `remember -> recall -> timeline` works end to end.
- `--json` produces parseable envelopes for command success and errors.
- Session bindings used by the CLI point to real persisted conversations.
- `memory.source` equivalent behavior is available only through explicit `source <summary-id> --yes`.
- No raw SQL is introduced outside `packages/infrastructure`.
- Clean Architecture boundaries still pass lint.

## Self-Review

Spec coverage:

- Human cockpit: covered by `status`, `doctor`, `remember`, `recall`, `timeline`, `explain`, `source`.
- Agent cockpit: covered by `--json` and stable error envelopes.
- Existing architecture: package lives at outer edge and reuses SDK/MCP/infrastructure.
- First-run usefulness: `doctor` and `status` run without Postgres and explain the missing durable storage.

Placeholder scan:

- No banned placeholder phrases remain.
- Every code task names files, tests, commands, and expected results.

Type consistency:

- `CockpitConfig`, `CockpitRuntime`, `resolveCockpitBinding`, and command inputs are introduced before use.
- Command runtime injection uses minimal `Pick<>` shapes so tests do not need real Postgres.
