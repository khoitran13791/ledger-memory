#!/usr/bin/env node

import { createHash } from 'node:crypto';

import { createTokenCount } from '@ledgermind/domain';

import type { PreCompactHookContext } from '../context';
import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';
import { parseTranscriptFile } from '../transcript';

const createPreCompactIdempotencyKey = (
  context: PreCompactHookContext,
  transcriptDigest: string,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        hook: context.hookName,
        sessionId: context.sessionId,
        transcriptDigest,
        trigger: context.trigger,
      }),
    )
    .digest('hex');

const budgetCharsToTokens = (budgetChars: number): number =>
  Math.max(128, Math.ceil(budgetChars / 4));

export const runPreCompactCommand = async (options: ClaudeCommandOptions = {}): Promise<void> => {
  const runtime = await buildCommandRuntime(options);
  try {
    const context = runtime.expectHookContext('PreCompact') as PreCompactHookContext;
    const binding = await runtime.resolveBinding(context);
    const checkpoint = await runtime.transcriptCheckpointStore.get(
      context.sessionId,
      context.transcriptPath,
    );
    const parseOptions = {
      ...(checkpoint?.lineCount === undefined ? {} : { startLine: checkpoint.lineCount }),
      onWarning: runtime.warn,
    };
    const transcript = await parseTranscriptFile(
      context.transcriptPath,
      {
        source: 'claude-code',
        hook: context.hookName,
        trigger: context.trigger,
      },
      parseOptions,
    );

    if (transcript.events.length > 0) {
      await runtime.engine.append({
        conversationId: binding.conversationId,
        events: transcript.events,
        idempotencyKey: createPreCompactIdempotencyKey(context, transcript.digest),
      });
    }

    await runtime.transcriptCheckpointStore.save({
      sessionId: context.sessionId,
      transcriptPath: context.transcriptPath,
      lineCount: transcript.lineCount,
    });

    await runtime.engine.runCompaction({
      conversationId: binding.conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(
        budgetCharsToTokens(runtime.config.injectedContextBudgetChars),
      ),
    });

    const recall = await runtime.engine.recallForTask({
      conversationId: binding.conversationId,
      task: 'Continue after Claude Code compaction',
      budgetTokens: runtime.config.continuityRecallBudgetTokens,
      includeHandoff: true,
      includeEvidence: true,
    });

    runtime.writeJson({
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: [
          'LedgerMind archived the full Claude Code transcript before compaction.',
          'Use the LedgerMind MCP tools to recover detailed history when needed.',
          recall.contextBlock,
        ].join('\n'),
      },
    });
  } finally {
    await runtime.close();
  }
};

if (isDirectExecution(import.meta.url)) {
  await runPreCompactCommand();
}
