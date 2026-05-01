import { resolve } from 'node:path';

export interface ClaudeCodeConfig {
  readonly storage: 'in-memory' | 'postgres' | 'sqlite';
  readonly connectionString?: string;
  readonly sqlitePath?: string;
  readonly bindingStorePath?: string;
  readonly injectedContextBudgetChars: number;
  readonly artifactIndexingEnabled: boolean;
  readonly toolEvidenceEnabled: boolean;
  readonly toolOutputBudgetChars: number;
  readonly continuityInjectionEnabled: boolean;
  readonly continuityRecallBudgetTokens: number;
}

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const parseClaudeCodeConfig = (
  env: NodeJS.ProcessEnv = process.env,
  cwd = env.LEDGERMIND_WORKSPACE_ROOT ?? process.cwd(),
): ClaudeCodeConfig => {
  const baseConfig = {
    ...(env.LEDGERMIND_MCP_BINDING_STORE === undefined
      ? {}
      : { bindingStorePath: env.LEDGERMIND_MCP_BINDING_STORE }),
    injectedContextBudgetChars: parsePositiveInteger(
      env.LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS,
      4000,
    ),
    artifactIndexingEnabled: env.LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING === 'true',
    toolEvidenceEnabled: env.LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE === 'true',
    toolOutputBudgetChars: parsePositiveInteger(
      env.LEDGERMIND_CLAUDE_TOOL_OUTPUT_BUDGET_CHARS,
      2000,
    ),
    continuityInjectionEnabled: env.LEDGERMIND_CLAUDE_ENABLE_CONTINUITY_INJECTION === 'true',
    continuityRecallBudgetTokens: parsePositiveInteger(
      env.LEDGERMIND_CLAUDE_RECALL_BUDGET_TOKENS,
      1200,
    ),
  };

  if (env.LEDGERMIND_DB_URL !== undefined && env.LEDGERMIND_DB_URL.trim().length > 0) {
    return {
      ...baseConfig,
      storage: 'postgres',
      connectionString: env.LEDGERMIND_DB_URL,
    };
  }

  if (env.LEDGERMIND_CLAUDE_STORAGE === 'in-memory') {
    return {
      ...baseConfig,
      storage: 'in-memory',
    };
  }

  return {
    ...baseConfig,
    storage: 'sqlite',
    sqlitePath: resolve(cwd, env.LEDGERMIND_SQLITE_PATH ?? '.ledgermind/memory.sqlite'),
  };
};
