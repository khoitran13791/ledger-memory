import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildBenchmarkConfig } from './config.js';
import { runLongMemEvalBenchmark } from './runner.js';
import type { LongMemEvalExample } from './types.js';

const example: LongMemEvalExample = {
  exampleId: 'q-001',
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
      ],
    },
  ],
  metadata: {
    questionType: 'multi-session',
    questionDate: '2024-03-10',
    haystackSessionIds: ['sess-100'],
    haystackDates: ['2024-02-01'],
  },
};

describe('runLongMemEvalBenchmark', () => {
  it('writes the full artifact contract for a tiny upper-bound run', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'longmemeval-runner-'));
    const config = buildBenchmarkConfig(['--out-dir', outputDir]);

    const result = await runLongMemEvalBenchmark({
      config: {
        ...config,
        fairness: {
          ...config.fairness,
          tokenBudget: 8,
        },
      },
      examples: [example],
    });

    const summaryMarkdown = await readFile(result.summaryPath, 'utf8');
    const traceJsonl = await readFile(result.tracePerExamplePath, 'utf8');
    const perExampleJsonl = await readFile(result.perExamplePath, 'utf8');
    const configSnapshot = await readFile(result.configSnapshotPath, 'utf8');

    expect(summaryMarkdown).toContain('Aggregate Score');
    expect(summaryMarkdown).toContain('Prompt Tokens');
    expect(summaryMarkdown).toContain('full_history_upper_bound');
    expect(summaryMarkdown).toContain('upper_bound');
    expect(perExampleJsonl).toContain('"exampleId":"q-001"');
    expect(traceJsonl).toContain('"latencyMs"');
    expect(traceJsonl).toContain('"promptTokens"');
    expect(traceJsonl).toContain('"completionTokens"');
    expect(traceJsonl).toContain('"estimatedCostUsd"');
    expect(configSnapshot).toContain('"runId"');
  });
});
