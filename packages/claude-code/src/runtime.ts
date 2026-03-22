import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MemoryEngine, NewLedgerEvent } from '@ledgermind/application';
import { createTokenCount } from '@ledgermind/domain';
import {
  createFileSessionBindingStore,
  createInMemorySessionBindingStore,
  resolveSessionBinding,
  type SessionBindingRecord,
  type SessionBindingStore,
} from '@ledgermind/mcp-server';
import { createInMemoryMemoryEngine, createPostgresMemoryEngine } from '@ledgermind/sdk';

import { parseClaudeCodeConfig, type ClaudeCodeConfig } from './config';
import { parseClaudeHookContext, type ClaudeHookContext, type ClaudeHookName } from './context';
import {
  createFileTranscriptCheckpointStore,
  type TranscriptCheckpointStore,
} from './transcript-checkpoint-store';

type WritableLike = Pick<NodeJS.WritableStream, 'write'>;

export interface ClaudeCommandOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: WritableLike;
  readonly stderr?: WritableLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly engine?: MemoryEngine;
  readonly sessionBindingStore?: SessionBindingStore;
}

export interface ClaudeCommandRuntime {
  readonly config: ClaudeCodeConfig;
  readonly engine: MemoryEngine;
  readonly stderr: WritableLike;
  readonly stdout: WritableLike;
  readonly transcriptCheckpointStore: TranscriptCheckpointStore;
  expectHookContext<T extends ClaudeHookName>(hookName: T): Extract<ClaudeHookContext, { readonly hookName: T }>;
  resolveBinding(context: ClaudeHookContext): Promise<SessionBindingRecord>;
  estimateTokenCount(content: string): ReturnType<typeof createTokenCount>;
  warn(message: string): void;
  writeJson(value: unknown): void;
}

const createEngine = (config: ClaudeCodeConfig): MemoryEngine =>
  config.storage === 'postgres'
    ? createPostgresMemoryEngine({
        connectionString: config.connectionString ?? '',
      })
    : createInMemoryMemoryEngine();

const deriveWorkspaceStatePath = (workspaceRoot: string, fileName: string): string =>
  join(workspaceRoot, '.ledgermind', fileName);

const readStreamToString = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }

  return chunks.join('').trim();
};

const readPayload = async (stdin: NodeJS.ReadableStream, env: NodeJS.ProcessEnv): Promise<unknown> => {
  const inlinePayload = env.LEDGERMIND_CLAUDE_HOOK_PAYLOAD;
  const serialized = inlinePayload === undefined ? await readStreamToString(stdin) : inlinePayload;

  if (serialized.trim().length === 0) {
    throw new Error('Claude hook command received no payload on stdin.');
  }

  return JSON.parse(serialized);
};

const resolveUserScope = (env: NodeJS.ProcessEnv): string =>
  env.LEDGERMIND_CLAUDE_USER_SCOPE ?? env.USER ?? env.LOGNAME ?? 'local-user';

const estimateTokenCount = (content: string) => createTokenCount(Math.max(1, Math.ceil(content.length / 4)));

export const buildCommandRuntime = async (
  options: ClaudeCommandOptions = {},
): Promise<ClaudeCommandRuntime> => {
  const env = options.env ?? process.env;
  const baseConfig = parseClaudeCodeConfig(env);
  const payload = await readPayload(options.stdin ?? process.stdin, env);
  const context = parseClaudeHookContext(payload);
  const resolvedBindingStorePath =
    baseConfig.bindingStorePath ?? deriveWorkspaceStatePath(context.workspaceRoot, 'session-bindings.json');
  const config: ClaudeCodeConfig = {
    ...baseConfig,
    bindingStorePath: resolvedBindingStorePath,
  };
  const engine = options.engine ?? createEngine(config);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const sessionBindingStore =
    options.sessionBindingStore ??
    (resolvedBindingStorePath === undefined
      ? createInMemorySessionBindingStore()
      : createFileSessionBindingStore(resolvedBindingStorePath));
  const transcriptCheckpointStore = createFileTranscriptCheckpointStore(
    join(dirname(resolvedBindingStorePath), 'transcript-checkpoints.json'),
  );

  return {
    config,
    engine,
    stderr,
    stdout,
    transcriptCheckpointStore,
    expectHookContext(hookName) {
      if (context.hookName !== hookName) {
        throw new Error(`Expected Claude hook payload for ${hookName}, received ${context.hookName}.`);
      }

      return context as Extract<ClaudeHookContext, { readonly hookName: typeof hookName }>;
    },
    async resolveBinding(currentContext) {
      return resolveSessionBinding(sessionBindingStore, {
        runtime: 'claude-code',
        runtimeSessionId: currentContext.sessionId,
        userScope: resolveUserScope(env),
        workspaceScope: env.LEDGERMIND_CLAUDE_WORKSPACE_SCOPE ?? currentContext.workspaceRoot,
        ...(env.LEDGERMIND_CLAUDE_BRANCH_SCOPE === undefined
          ? {}
          : { branchScope: env.LEDGERMIND_CLAUDE_BRANCH_SCOPE }),
        ...(env.LEDGERMIND_CLAUDE_PARENT_SESSION_ID === undefined
          ? {}
          : { parentRuntimeSessionId: env.LEDGERMIND_CLAUDE_PARENT_SESSION_ID }),
      });
    },
    estimateTokenCount,
    warn(message) {
      stderr.write(`LedgerMind Claude hook warning: ${message}\n`);
    },
    writeJson(value) {
      stdout.write(`${JSON.stringify(value)}\n`);
    },
  };
};

export const withEstimatedTokenCount = (event: Omit<NewLedgerEvent, 'tokenCount'>): NewLedgerEvent => ({
  ...event,
  tokenCount: estimateTokenCount(event.content),
});

export const isDirectExecution = (importMetaUrl: string): boolean => {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && pathToFileURL(entryPoint).href === importMetaUrl;
};
