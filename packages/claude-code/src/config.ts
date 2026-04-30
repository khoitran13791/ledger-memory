export interface ClaudeCodeConfig {
  readonly storage: 'in-memory' | 'postgres';
  readonly connectionString?: string;
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

export const parseClaudeCodeConfig = (env: NodeJS.ProcessEnv = process.env): ClaudeCodeConfig => ({
  storage: env.LEDGERMIND_DB_URL === undefined ? 'in-memory' : 'postgres',
  ...(env.LEDGERMIND_DB_URL === undefined ? {} : { connectionString: env.LEDGERMIND_DB_URL }),
  ...(env.LEDGERMIND_MCP_BINDING_STORE === undefined
    ? {}
    : { bindingStorePath: env.LEDGERMIND_MCP_BINDING_STORE }),
  injectedContextBudgetChars: parsePositiveInteger(
    env.LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS,
    4000,
  ),
  artifactIndexingEnabled: env.LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING === 'true',
  toolEvidenceEnabled: env.LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE === 'true',
  toolOutputBudgetChars: parsePositiveInteger(env.LEDGERMIND_CLAUDE_TOOL_OUTPUT_BUDGET_CHARS, 2000),
  continuityInjectionEnabled: env.LEDGERMIND_CLAUDE_ENABLE_CONTINUITY_INJECTION === 'true',
  continuityRecallBudgetTokens: parsePositiveInteger(
    env.LEDGERMIND_CLAUDE_RECALL_BUDGET_TOKENS,
    1200,
  ),
});
