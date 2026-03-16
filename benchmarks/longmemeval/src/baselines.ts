import { buildAnswerPrompt } from './prompts.js';
import type {
  LongMemEvalBaselineName,
  LongMemEvalBenchmarkConfig,
  LongMemEvalExample,
  LongMemEvalTraceToolStep,
} from './types.js';
import { estimateTokens } from './utils.js';

export interface LongMemEvalBaselineExecutionResult {
  readonly prediction: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly toolSteps: readonly LongMemEvalTraceToolStep[];
}

export interface LongMemEvalBaselineStrategy {
  readonly baseline: LongMemEvalBaselineName;
  run(example: LongMemEvalExample): Promise<LongMemEvalBaselineExecutionResult>;
}

const renderFullHistoryContext = (example: LongMemEvalExample): string => {
  return example.history
    .map(
      (session) =>
        `Session ${session.sessionId} (${session.sessionDate})\n${session.turns
          .map((turn) => `${turn.role}: ${turn.content}`)
          .join('\n')}`,
    )
    .join('\n\n');
};

const createFullHistoryUpperBoundStrategy = (
  config: LongMemEvalBenchmarkConfig,
): LongMemEvalBaselineStrategy => ({
  baseline: 'full_history_upper_bound',
  async run(example) {
    const context = renderFullHistoryContext(example);
    const prompt = buildAnswerPrompt({
      context,
      question: example.question,
    });

    return {
      prediction: example.answer,
      promptTokens: estimateTokens(prompt),
      completionTokens: estimateTokens(example.answer),
      toolSteps: [],
    };
  },
});

export const createBaselineStrategies = (
  config: LongMemEvalBenchmarkConfig,
): readonly LongMemEvalBaselineStrategy[] => {
  return config.baselines.map((baseline) => {
    if (baseline === 'full_history_upper_bound') {
      return createFullHistoryUpperBoundStrategy(config);
    }

    throw new Error(`Baseline ${baseline} is not implemented yet in the LongMemEval spike`);
  });
};
