export interface ClaudeCodeConfig {
  readonly storage: 'in-memory' | 'postgres';
  readonly connectionString?: string;
  readonly bindingStorePath?: string;
  readonly injectedContextBudgetChars: number;
  readonly artifactIndexingEnabled: boolean;
}

export const parseClaudeCodeConfig = (env: NodeJS.ProcessEnv = process.env): ClaudeCodeConfig => ({
  storage: env.LEDGERMIND_DB_URL === undefined ? 'in-memory' : 'postgres',
  ...(env.LEDGERMIND_DB_URL === undefined ? {} : { connectionString: env.LEDGERMIND_DB_URL }),
  ...(env.LEDGERMIND_MCP_BINDING_STORE === undefined
    ? {}
    : { bindingStorePath: env.LEDGERMIND_MCP_BINDING_STORE }),
  injectedContextBudgetChars: Number(env.LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS ?? 4000),
  artifactIndexingEnabled: env.LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING === 'true',
});
