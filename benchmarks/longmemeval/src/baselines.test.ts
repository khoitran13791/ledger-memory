import { describe, expect, it } from 'vitest';

import { createBaselineStrategies } from './baselines.js';
import { buildBenchmarkConfig } from './config.js';
import type { LongMemEvalExample } from './types.js';

const buriedEvidenceExample: LongMemEvalExample = {
  exampleId: 'q-buried-001',
  question: 'What instrument did I start practicing again after moving to Seattle?',
  answer: 'violin',
  history: [
    {
      sessionId: 'sess-100',
      sessionDate: '2024-02-01',
      sourceIndex: 0,
      turns: [
        {
          turnId: 'sess-100#turn-0',
          role: 'user',
          content: 'After moving to Seattle I picked violin back up and joined a small ensemble.',
          sourceIndex: 0,
          hasAnswer: true,
        },
      ],
    },
    {
      sessionId: 'sess-200',
      sessionDate: '2024-03-01',
      sourceIndex: 1,
      turns: [
        {
          turnId: 'sess-200#turn-0',
          role: 'user',
          content:
            'I am also looking for a new bike route to the office and a coffee shop with long opening hours near the water.',
          sourceIndex: 0,
          hasAnswer: false,
        },
        {
          turnId: 'sess-200#turn-1',
          role: 'assistant',
          content: 'I can help you compare routes and coffee shops next time.',
          sourceIndex: 1,
          hasAnswer: false,
        },
      ],
    },
  ],
  metadata: {
    questionType: 'multi-session',
    questionDate: '2024-03-10',
    haystackSessionIds: ['sess-100', 'sess-200'],
    haystackDates: ['2024-02-01', '2024-03-01'],
  },
};

describe('createBaselineStrategies', () => {
  it('recovers buried evidence with the agentic loop after static materialization drops it', async () => {
    const config = {
      ...buildBenchmarkConfig([]),
      fairness: {
        ...buildBenchmarkConfig([]).fairness,
        tokenBudget: 64,
        maxAnswerTokens: 16,
      },
      baselines: ['ledgermind_static_materialize', 'ledgermind_agentic_loop'] as const,
    };

    const strategies = createBaselineStrategies(config);
    const staticExecution = await strategies.find((strategy) => strategy.baseline === 'ledgermind_static_materialize')?.run(
      buriedEvidenceExample,
    );
    const agenticExecution = await strategies.find((strategy) => strategy.baseline === 'ledgermind_agentic_loop')?.run(
      buriedEvidenceExample,
    );

    expect(staticExecution).toBeDefined();
    expect(agenticExecution).toBeDefined();
    expect(staticExecution?.initialContextIds).not.toContain('sess-100#turn-0');
    expect(agenticExecution?.postToolContextIds).toContain('sess-100#turn-0');
    expect(agenticExecution?.toolSteps.some((step) => step.kind === 'grep' && step.matchCount !== undefined && step.matchCount > 0)).toBe(
      true,
    );
    expect(agenticExecution?.prediction).toBe('violin');
  });
});
