import { describe, expect, it } from 'vitest';

import { UnauthorizedExpandError, type MemoryEngine } from '@ledgermind/application';
import { createSummaryNodeId } from '@ledgermind/domain';

import type { LongMemEvalExample } from './types.js';
import { createLedgermindRuntime } from './ledgermind-runtime.js';

const example: LongMemEvalExample = {
  exampleId: 'q-runtime-001',
  question: 'What instrument did I start practicing again after moving to Seattle?',
  answer: 'violin',
  goldEvidenceIds: ['sess-100'],
  history: [
    {
      sessionId: 'sess-100',
      sessionDate: '2024-02-01',
      sourceIndex: 0,
      turns: [
        {
          turnId: 'sess-100#turn-0',
          role: 'user',
          content: 'After the move I picked violin back up and joined a small ensemble.',
          sourceIndex: 0,
          hasAnswer: true,
        },
        {
          turnId: 'sess-100#turn-1',
          role: 'assistant',
          content: 'That sounds like a great way to settle into Seattle.',
          sourceIndex: 1,
          hasAnswer: false,
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
          content: 'I am also looking for a new bike route to the office.',
          sourceIndex: 0,
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

const fairness = {
  modelName: 'longmemeval-runtime-test',
  promptTemplate: 'Answer from context only.',
  temperature: 0,
  topP: 1,
  tokenBudget: 1024,
  maxAnswerTokens: 64,
} as const;

describe('createLedgermindRuntime', () => {
  it('preserves LongMemEval source ids, speaker roles, and ordering through materialization', async () => {
    const runtime = await createLedgermindRuntime({
      example,
      fairness,
      runtimeMode: 'static_materialize',
      precompact: false,
    });

    const materialized = await runtime.engine.materializeContext({
      conversationId: runtime.conversationId,
      budgetTokens: 1024,
      overheadTokens: 64,
    });

    expect(materialized.modelMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    const combined = materialized.modelMessages.map((message) => message.content).join('\n');
    expect(combined).toContain('SOURCE_ID: sess-100#turn-0');
    expect(combined).toContain('SOURCE_ID: sess-100#turn-1');
    expect(combined).toContain('SOURCE_ID: sess-200#turn-0');
    expect(combined.indexOf('sess-100#turn-0')).toBeLessThan(combined.indexOf('sess-100#turn-1'));
    expect(combined.indexOf('sess-100#turn-1')).toBeLessThan(combined.indexOf('sess-200#turn-0'));

    await runtime.destroy();
  });

  it('exposes the current memory engine contract and keeps expand authorization wired', async () => {
    const runtime = await createLedgermindRuntime({
      example,
      fairness,
      runtimeMode: 'static_materialize',
      precompact: false,
    });

    const engine: MemoryEngine = runtime.engine;

    expect(typeof engine.llmMap).toBe('function');
    expect(typeof engine.agenticMap).toBe('function');
    expect(typeof engine.getOperatorRun).toBe('function');

    const expandExecution = engine.expand({
      summaryId: createSummaryNodeId('sum_missing_benchmark_runtime'),
      callerContext: {
        conversationId: runtime.conversationId,
        isSubAgent: true,
        parentConversationId: runtime.conversationId,
      },
    });

    await expect(expandExecution).rejects.toBeInstanceOf(UnauthorizedExpandError);

    await expect(
      engine.llmMap({
        conversationId: runtime.conversationId,
        prompt: 'benchmark operator compatibility probe',
        outputSchema: {},
        concurrencyLimit: 1,
        retryPolicy: {
          maxRetries: 0,
          retryBackoffSeconds: 0,
        },
        items: [],
      }),
    ).rejects.toThrow('LongMemEval benchmark runtime does not support llmMap().');

    await expect(
      engine.agenticMap({
        conversationId: runtime.conversationId,
        taskPrompt: 'benchmark operator compatibility probe',
        delegatedScope: {},
        keptWork: {
          description: 'none',
          expectedOutput: 'none',
        },
        outputSchema: {},
        concurrencyLimit: 1,
        retryPolicy: {
          maxRetries: 0,
          retryBackoffSeconds: 0,
        },
        items: [],
      }),
    ).rejects.toThrow('LongMemEval benchmark runtime does not support agenticMap().');

    await expect(
      engine.getOperatorRun({
        runId: 'oprun_benchmark_probe',
      }),
    ).rejects.toThrow('LongMemEval benchmark runtime does not support getOperatorRun().');

    await runtime.destroy();
  });
});
