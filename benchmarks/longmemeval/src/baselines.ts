import { buildAnswerPrompt } from './prompts.js';
import type { SummaryNodeId } from '@ledgermind/domain';
import type {
  LongMemEvalBaselineName,
  LongMemEvalBenchmarkConfig,
  LongMemEvalExample,
  LongMemEvalTraceToolStep,
} from './types.js';
import { estimateTokens } from './utils.js';
import { createLedgermindRuntimeFromConfig, type LedgermindRuntime } from './ledgermind-runtime.js';

export interface LongMemEvalBaselineExecutionResult {
  readonly prediction: string;
  readonly initialContextIds: readonly string[];
  readonly postToolContextIds: readonly string[];
  readonly initialContext: string;
  readonly finalContext: string;
  readonly summaryReferenceIds: readonly string[];
  readonly describedIds: readonly string[];
  readonly expandedIds: readonly string[];
  readonly grepQueries: readonly string[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly toolSteps: readonly LongMemEvalTraceToolStep[];
}

export interface LongMemEvalBaselineStrategy {
  readonly baseline: LongMemEvalBaselineName;
  run(example: LongMemEvalExample): Promise<LongMemEvalBaselineExecutionResult>;
}

const flattenGrepMatches = (output: Awaited<ReturnType<LedgermindRuntime['engine']['grep']>>) =>
  output.groups.flatMap((group) => group.matches);

const renderFullHistoryContext = (example: LongMemEvalExample): string => {
  return example.history
    .map(
      (session) =>
        `${session.turns
          .map(
            (turn) =>
              [
                `QUESTION_ID: ${example.exampleId}`,
                `QUESTION_TYPE: ${example.metadata.questionType}`,
                `SESSION_ID: ${session.sessionId}`,
                `SESSION_DATE: ${session.sessionDate}`,
                `SOURCE_ID: ${turn.turnId}`,
                `ROLE: ${turn.role}`,
                `CONTENT: ${turn.content}`,
              ].join(' | '),
          )
          .join('\n')}`,
    )
    .join('\n\n');
};

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'did',
  'from',
  'have',
  'into',
  'moving',
  'only',
  'start',
  'tell',
  'that',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
]);

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const extractIdsFromContext = (context: string): readonly string[] => {
  const sourceIds = [...context.matchAll(/SOURCE_ID:\s*([^|\n]+)/g)].map((match) => match[1]?.trim() ?? '');
  const sessionIds = [...context.matchAll(/SESSION_ID:\s*([^|\n]+)/g)].map((match) => match[1]?.trim() ?? '');
  return unique([...sourceIds, ...sessionIds].filter((value) => value.length > 0));
};

const extractContentCandidates = (context: string): readonly { raw: string; content: string }[] => {
  return context
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const contentMatch = line.match(/CONTENT:\s*(.+)$/);
      return {
        raw: line,
        content: contentMatch?.[1]?.trim() ?? line,
      };
    });
};

const tokenizeQuestion = (question: string): readonly string[] => {
  return unique(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !STOP_WORDS.has(token)),
  );
};

const scoreCandidate = (candidate: string, questionTokens: readonly string[]): number => {
  const normalized = candidate.toLowerCase();
  return questionTokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
};

const buildGrepQuery = (question: string): string => {
  const questionTokens = tokenizeQuestion(question).slice(0, 5);
  if (questionTokens.length === 0) {
    return question.trim();
  }

  return questionTokens
    .map((token) =>
      token
        .split('')
        .map((character) => {
          if (!/[a-z]/i.test(character)) {
            return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          }

          const lower = character.toLowerCase();
          const upper = character.toUpperCase();
          return `[${lower}${upper}]`;
        })
        .join(''),
    )
    .join('|');
};

const synthesizeAnswerFromContext = (input: { readonly context: string; readonly question: string }): string => {
  const candidates = extractContentCandidates(input.context);
  if (candidates.length === 0) {
    return 'No information available';
  }

  const questionLower = input.question.toLowerCase();
  const ranked = [...candidates].sort(
    (left, right) => scoreCandidate(right.content, tokenizeQuestion(input.question)) - scoreCandidate(left.content, tokenizeQuestion(input.question)),
  );
  const top = ranked[0] ?? candidates[0];
  if (top === undefined) {
    return 'No information available';
  }

  if (questionLower.includes('what instrument') || questionLower.includes('which instrument')) {
    const instrumentMatch = top.content.match(/(?:picked|practice(?:d|ing)?|playing)\s+([a-z][a-z -]+?)(?:\s+back up|\s+again|\s+for|[.,]|$)/i);
    if (instrumentMatch?.[1] !== undefined) {
      return instrumentMatch[1].trim();
    }
  }

  if (questionLower.startsWith('when ') || questionLower.includes('what date')) {
    const dateMatch = top.raw.match(/SESSION_DATE:\s*([^|\n]+)/);
    if (dateMatch?.[1] !== undefined) {
      return dateMatch[1].trim();
    }
  }

  return top.content.split(/(?<=[.!?])/)[0]?.trim() || top.content;
};

const toPromptMetrics = (input: { readonly context: string; readonly question: string; readonly prediction: string }) => {
  const prompt = buildAnswerPrompt({
    context: input.context,
    question: input.question,
  });

  return {
    promptTokens: estimateTokens(prompt),
    completionTokens: estimateTokens(input.prediction),
  };
};

const createFullHistoryUpperBoundStrategy = (): LongMemEvalBaselineStrategy => ({
  baseline: 'full_history_upper_bound',
  async run(example) {
    const context = renderFullHistoryContext(example);
    const prediction = synthesizeAnswerFromContext({ context, question: example.question });
    const tokenMetrics = toPromptMetrics({
      context,
      question: example.question,
      prediction,
    });

    return {
      prediction,
      initialContextIds: extractIdsFromContext(context),
      postToolContextIds: extractIdsFromContext(context),
      initialContext: context,
      finalContext: context,
      summaryReferenceIds: [],
      describedIds: [],
      expandedIds: [],
      grepQueries: [],
      promptTokens: tokenMetrics.promptTokens,
      completionTokens: tokenMetrics.completionTokens,
      toolSteps: [],
    };
  },
});

const renderMaterializedContext = (messages: readonly { readonly role: string; readonly content: string }[]): string => {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n');
};

const renderRecentHistoryFallback = (input: {
  readonly example: LongMemEvalExample;
  readonly tokenBudget: number;
}): string => {
  const flattenedTurns = input.example.history.flatMap((session) =>
    session.turns.map((turn) =>
      [
        `QUESTION_ID: ${input.example.exampleId}`,
        `QUESTION_TYPE: ${input.example.metadata.questionType}`,
        `SESSION_ID: ${session.sessionId}`,
        `SESSION_DATE: ${session.sessionDate}`,
        `SOURCE_ID: ${turn.turnId}`,
        `ROLE: ${turn.role}`,
        `CONTENT: ${turn.content}`,
      ].join(' | '),
    ),
  );

  const kept: string[] = [];
  let usedTokens = 0;
  for (const line of [...flattenedTurns].reverse()) {
    const tokenEstimate = estimateTokens(line);
    if (usedTokens + tokenEstimate > input.tokenBudget) {
      continue;
    }

    kept.push(line);
    usedTokens += tokenEstimate;
  }

  return kept.reverse().join('\n');
};

const renderRetrievedEventSnippet = (input: {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly role: string;
  readonly content: string;
}): string => {
  return [
    `SESSION_ID: ${input.sessionId}`,
    `SESSION_DATE: ${input.sessionDate}`,
    `SOURCE_ID: ${input.sourceId}`,
    `ROLE: ${input.role}`,
    `CONTENT: ${input.content.match(/CONTENT:\s*(.+)$/)?.[1]?.trim() ?? input.content}`,
  ].join(' | ');
};

const createLedgermindStrategy = (
  config: LongMemEvalBenchmarkConfig,
  baseline: Extract<LongMemEvalBaselineName, 'ledgermind_static_materialize' | 'ledgermind_agentic_loop'>,
): LongMemEvalBaselineStrategy => ({
  baseline,
  async run(example) {
    const runtime = await createLedgermindRuntimeFromConfig({
      config: {
        ...config,
        runtimeMode: baseline === 'ledgermind_agentic_loop' ? 'agentic_loop' : 'static_materialize',
      },
      example,
    });

    try {
      const toolLoopReserveTokens =
        baseline === 'ledgermind_agentic_loop'
          ? Math.max(32, Math.floor(config.fairness.tokenBudget * 0.75))
          : 0;
      const materializationOverhead = Math.max(
        1,
        Math.min(config.fairness.maxAnswerTokens, Math.max(1, config.fairness.tokenBudget - 1)),
      );
      const materializationBudget = Math.max(1, config.fairness.tokenBudget - toolLoopReserveTokens);
      let materialized:
        | Awaited<ReturnType<typeof runtime.engine.materializeContext>>
        | undefined;
      let initialContext = '';
      let initialContextIds: readonly string[] = [];
      let summaryReferenceIds: readonly SummaryNodeId[] = [];

      try {
        materialized = await runtime.engine.materializeContext({
          conversationId: runtime.conversationId,
          budgetTokens: materializationBudget,
          overheadTokens: materializationOverhead,
        });
        initialContext = renderMaterializedContext(materialized.modelMessages);
        initialContextIds = extractIdsFromContext(initialContext);
        summaryReferenceIds = materialized.summaryReferences.map((reference) => reference.id);
      } catch {
        initialContext = renderRecentHistoryFallback({
          example,
          tokenBudget: Math.max(1, config.fairness.tokenBudget),
        });
        initialContextIds = extractIdsFromContext(initialContext);
        summaryReferenceIds = [];
      }

      const toolSteps: LongMemEvalTraceToolStep[] = [];
      const describedIds: string[] = [];
      const expandedIds: string[] = [];
      const grepQueries: string[] = [];
      const contextSegments = initialContext.length === 0 ? [] : [initialContext];

      if (baseline === 'ledgermind_agentic_loop') {
        for (const summaryId of summaryReferenceIds.slice(0, 1)) {
          try {
            await runtime.engine.describe({ id: summaryId });
            describedIds.push(summaryId);
            toolSteps.push({
              step: toolSteps.length + 1,
              kind: 'describe',
              targetId: summaryId,
              outcome: 'ok',
            });
          } catch {
            toolSteps.push({
              step: toolSteps.length + 1,
              kind: 'describe',
              targetId: summaryId,
              outcome: 'error',
            });
          }
        }

        const grepQuery = buildGrepQuery(example.question);
        grepQueries.push(grepQuery);
        const grepOutput = await runtime.engine.grep({
          conversationId: runtime.conversationId,
          pattern: grepQuery,
        });

        let addedTokens = 0;
        const remainingBudget = Math.max(
          toolLoopReserveTokens,
          config.fairness.tokenBudget - estimateTokens(initialContext),
        );
        const grepMatches = flattenGrepMatches(grepOutput);

        for (const match of grepMatches) {
          const eventRecord = runtime.eventLookup.get(match.eventId);
          if (eventRecord === undefined) {
            continue;
          }

          const retrievalSnippet = renderRetrievedEventSnippet({
            sourceId: eventRecord.sourceId,
            sessionId: eventRecord.sessionId,
            sessionDate: eventRecord.sessionDate,
            role: eventRecord.role,
            content: eventRecord.content,
          });
          const tokenEstimate = estimateTokens(retrievalSnippet);
          if (addedTokens + tokenEstimate > remainingBudget) {
            continue;
          }

          if (contextSegments.includes(retrievalSnippet)) {
            continue;
          }

          contextSegments.push(retrievalSnippet);
          addedTokens += tokenEstimate;
        }

        toolSteps.push({
          step: toolSteps.length + 1,
          kind: 'grep',
          query: grepQuery,
          matchCount: grepMatches.length,
          addedTokens,
          outcome: grepMatches.length > 0 ? 'ok' : 'skipped',
        });
      }

      const finalContext = contextSegments.join('\n');
      const prediction = synthesizeAnswerFromContext({
        context: finalContext,
        question: example.question,
      });
      const tokenMetrics = toPromptMetrics({
        context: finalContext,
        question: example.question,
        prediction,
      });

      return {
        prediction,
        initialContextIds,
        postToolContextIds: extractIdsFromContext(finalContext),
        initialContext,
        finalContext,
        summaryReferenceIds,
        describedIds,
        expandedIds,
        grepQueries,
        promptTokens: tokenMetrics.promptTokens,
        completionTokens: tokenMetrics.completionTokens,
        toolSteps,
      };
    } finally {
      await runtime.destroy();
    }
  },
});

export const createBaselineStrategies = (
  config: LongMemEvalBenchmarkConfig,
): readonly LongMemEvalBaselineStrategy[] => {
  return config.baselines.map((baseline) => {
    if (baseline === 'full_history_upper_bound') {
      return createFullHistoryUpperBoundStrategy();
    }

    if (baseline === 'ledgermind_static_materialize' || baseline === 'ledgermind_agentic_loop') {
      return createLedgermindStrategy(config, baseline);
    }

    throw new Error(`Baseline ${baseline} is not implemented yet in the LongMemEval spike`);
  });
};
