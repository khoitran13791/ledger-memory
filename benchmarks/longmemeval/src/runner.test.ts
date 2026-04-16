import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildBenchmarkConfig } from './config.js';
import { runLongMemEvalBenchmark } from './runner.js';
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

const synthesisFailureExample: LongMemEvalExample = {
  exampleId: 'q-synthesis-001',
  question: 'Which city did I settle into after the move?',
  answer: 'Seattle',
  history: [
    {
      sessionId: 'sess-300',
      sessionDate: '2024-04-01',
      sourceIndex: 0,
      turns: [
        {
          turnId: 'sess-300#turn-0',
          role: 'assistant',
          content: 'That sounds like a great way to settle into Seattle.',
          sourceIndex: 0,
          hasAnswer: true,
        },
      ],
    },
  ],
  metadata: {
    questionType: 'single-session',
    questionDate: '2024-04-02',
    haystackSessionIds: ['sess-300'],
    haystackDates: ['2024-04-01'],
  },
};

describe('runLongMemEvalBenchmark', () => {
  it('writes the full artifact contract and classifies reachability versus answer synthesis failures', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'longmemeval-runner-'));
    const config = buildBenchmarkConfig(['--out-dir', outputDir]);

    const result = await runLongMemEvalBenchmark({
      config: {
        ...config,
        fairness: {
          ...config.fairness,
          tokenBudget: 64,
          maxAnswerTokens: 16,
        },
      },
      examples: [buriedEvidenceExample, synthesisFailureExample],
    });

    const summaryMarkdown = await readFile(result.summaryPath, 'utf8');
    const traceJsonl = await readFile(result.tracePerExamplePath, 'utf8');
    const perExampleJsonl = await readFile(result.perExamplePath, 'utf8');
    const configSnapshot = await readFile(result.configSnapshotPath, 'utf8');

    expect(summaryMarkdown).toContain('Aggregate Score');
    expect(summaryMarkdown).toContain('Prompt Tokens');
    expect(summaryMarkdown).toContain('Retrieval Effectiveness');
    expect(summaryMarkdown).toContain('Failure Mix');
    expect(summaryMarkdown).toContain('full_history_upper_bound');
    expect(summaryMarkdown).toContain('upper_bound');
    expect(perExampleJsonl).toContain('"failureClassification"');
    expect(traceJsonl).toContain('"latencyMs"');
    expect(traceJsonl).toContain('"promptTokens"');
    expect(traceJsonl).toContain('"completionTokens"');
    expect(traceJsonl).toContain('"estimatedCostUsd"');
    expect(traceJsonl).toContain('"reachability_failure"');
    expect(traceJsonl).toContain('"answer_synthesis_failure"');
    expect(configSnapshot).toContain('"runId"');

    const traceRows = traceJsonl
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { readonly exampleId: string; readonly baseline: string; readonly failureClassification: { readonly category: string; readonly goldEvidenceReachable: boolean } });
    expect(
      traceRows.find(
        (row) => row.exampleId === 'q-buried-001' && row.baseline === 'ledgermind_static_materialize',
      )?.failureClassification.category,
    ).toBe('reachability_failure');
    expect(
      traceRows.find(
        (row) => row.exampleId === 'q-buried-001' && row.baseline === 'ledgermind_agentic_loop',
      )?.failureClassification.goldEvidenceReachable,
    ).toBe(true);
    expect(
      traceRows.find((row) => row.exampleId === 'q-synthesis-001')?.failureClassification.category,
    ).toBe('answer_synthesis_failure');
  });
});
