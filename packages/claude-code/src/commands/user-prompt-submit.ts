#!/usr/bin/env node

import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';

export const runUserPromptSubmitCommand = async (
  options: ClaudeCommandOptions = {},
): Promise<void> => {
  const runtime = await buildCommandRuntime(options);
  try {
    const context = runtime.expectHookContext('UserPromptSubmit');

    if (!runtime.config.continuityInjectionEnabled) {
      runtime.writeJson({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
        },
      });
      return;
    }

    const binding = await runtime.resolveBinding(context);
    const output = await runtime.engine.recallForTask({
      conversationId: binding.conversationId,
      task: context.prompt,
      budgetTokens: runtime.config.continuityRecallBudgetTokens,
      includeHandoff: true,
      includeEvidence: true,
    });

    runtime.writeJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: output.contextBlock,
      },
    });
  } finally {
    await runtime.close();
  }
};

if (isDirectExecution(import.meta.url)) {
  await runUserPromptSubmitCommand();
}
