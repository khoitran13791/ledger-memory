#!/usr/bin/env node

import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';

export const runSessionStartCommand = async (options: ClaudeCommandOptions = {}): Promise<void> => {
  const runtime = await buildCommandRuntime(options);
  const context = runtime.expectHookContext('SessionStart');
  const binding = await runtime.resolveBinding(context);

  runtime.writeJson({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `LedgerMind resumed conversation ${String(binding.conversationId)} for this Claude Code session.`,
    },
  });
};

if (isDirectExecution(import.meta.url)) {
  await runSessionStartCommand();
}
