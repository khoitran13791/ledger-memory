#!/usr/bin/env node

import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';

export const runSessionStartCommand = async (options: ClaudeCommandOptions = {}): Promise<void> => {
  const runtime = await buildCommandRuntime(options);
  try {
    const context = runtime.expectHookContext('SessionStart');
    const binding = await runtime.resolveBinding(context);
    const resumedMessage = `LedgerMind resumed conversation ${String(binding.conversationId)} for this Claude Code session.`;
    const currentState = await runtime.engine.getCurrentState({
      conversationId: binding.conversationId,
    });

    if (currentState.activeRecordCount === 0) {
      runtime.writeJson({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: resumedMessage,
        },
      });
      return;
    }

    const recall = await runtime.engine.recallForTask({
      conversationId: binding.conversationId,
      task: 'Resume this coding session',
      budgetTokens: runtime.config.continuityRecallBudgetTokens,
      includeHandoff: true,
      includeEvidence: true,
    });

    runtime.writeJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${resumedMessage}\n\n${recall.contextBlock}`,
      },
    });
  } finally {
    await runtime.close();
  }
};

if (isDirectExecution(import.meta.url)) {
  await runSessionStartCommand();
}
