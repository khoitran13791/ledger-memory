#!/usr/bin/env node

import { createHash } from 'node:crypto';

import type { StopHookContext } from '../context';
import { extractContinuityHandoffFromTranscript } from '../continuity/transcript-continuity-extractor';
import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';
import { parseTranscriptFile } from '../transcript';

const createStopIdempotencyKey = (context: StopHookContext): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        hook: context.hookName,
        sessionId: context.sessionId,
        transcriptPath: context.transcriptPath,
        lastAssistantMessage: context.lastAssistantMessage ?? null,
      }),
    )
    .digest('hex');

const truncateForBudget = (value: string, budgetChars: number): string => {
  const maxChars = Math.max(96, Math.min(400, Math.floor(budgetChars * 0.6)));
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
};

const buildStopEventContent = (context: StopHookContext, budgetChars: number): string => {
  const lines = ['Session closed in Claude Code.', `Transcript path: ${context.transcriptPath}`];

  if (context.lastAssistantMessage !== undefined) {
    lines.push(
      `Last assistant message excerpt: ${truncateForBudget(context.lastAssistantMessage, budgetChars)}`,
    );
  }

  if (!context.stopHookActive) {
    lines.push('Claude reported the stop hook as inactive; this record was written defensively.');
  }

  return lines.join('\n');
};

export const runStopCommand = async (options: ClaudeCommandOptions = {}): Promise<void> => {
  const runtime = await buildCommandRuntime(options);
  const context = runtime.expectHookContext('Stop') as StopHookContext;
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
    },
    parseOptions,
  );
  const stopEventContent = buildStopEventContent(
    context,
    runtime.config.injectedContextBudgetChars,
  );

  await runtime.engine.append({
    conversationId: binding.conversationId,
    idempotencyKey: createStopIdempotencyKey(context),
    events: [
      ...transcript.events,
      {
        role: 'system',
        content: stopEventContent,
        tokenCount: runtime.estimateTokenCount(stopEventContent),
        metadata: {
          source: 'claude-code',
          hook: context.hookName,
          transcriptPath: context.transcriptPath,
          sessionId: context.sessionId,
        },
      },
    ],
  });

  await runtime.transcriptCheckpointStore.save({
    sessionId: context.sessionId,
    transcriptPath: context.transcriptPath,
    lineCount: transcript.lineCount,
  });

  const extracted = await extractContinuityHandoffFromTranscript({
    transcriptPath: context.transcriptPath,
    sessionId: context.sessionId,
  });
  const handoffProvenance = {
    transcriptPath: context.transcriptPath,
  };

  await runtime.engine.createHandoff({
    conversationId: binding.conversationId,
    goal: extracted.goal,
    completed: extracted.completed,
    nextSteps: extracted.nextSteps.map((step) => ({
      title: step,
      content: step,
      provenance: handoffProvenance,
    })),
    decisions: extracted.decisions,
    constraints: extracted.constraints,
    openQuestions: extracted.openQuestions,
    verification: extracted.verification,
    risks: extracted.risks,
    changedFiles: extracted.changedFiles,
    provenance: handoffProvenance,
    idempotencyKey: `${createStopIdempotencyKey(context)}:handoff`,
  });

  await runtime.engine.runCompaction({
    conversationId: binding.conversationId,
    trigger: 'soft',
  });
};

if (isDirectExecution(import.meta.url)) {
  await runStopCommand();
}
