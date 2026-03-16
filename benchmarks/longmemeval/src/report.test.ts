import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeBenchmarkArtifacts } from './report.js';
import type {
  LongMemEvalPerExampleRecord,
  LongMemEvalRunSummary,
  LongMemEvalTraceRecord,
} from './types.js';

const perExampleRows: readonly LongMemEvalPerExampleRecord[] = [
  {
    exampleId: 'q-001',
    baseline: 'full_history_upper_bound',
    parityMode: 'upper_bound',
    prediction: 'violin',
    answer: 'violin',
    score: 1,
    latencyMs: 25,
    promptTokens: 2048,
    completionTokens: 12,
    estimatedCostUsd: 0.015,
    scorerMode: 'fallback_exact_match',
    evidenceDiagnostics: {
      goldEvidenceIds: ['sess-100#turn-0'],
      matchedEvidenceIds: ['sess-100#turn-0'],
      missingEvidenceIds: [],
      recall: 1,
      hasGoldEvidenceInContext: true,
      hasAllGoldEvidenceInContext: true,
    },
    failureClassification: {
      category: 'none',
      reason: 'Answer matched after evidence became reachable.',
      goldEvidenceReachable: true,
      hasGoldEvidenceInContext: true,
      hasAllGoldEvidenceInContext: true,
    },
  },
];

const traceRows: readonly LongMemEvalTraceRecord[] = [
  {
    traceSchemaVersion: 'longmemeval_trace_v1',
    exampleId: 'q-001',
    baseline: 'full_history_upper_bound',
    parityMode: 'upper_bound',
    initialContextIds: ['sess-100#turn-0'],
    postToolContextIds: ['sess-100#turn-0'],
    summaryReferenceIds: [],
    describedIds: [],
    expandedIds: [],
    grepQueries: [],
    toolSteps: [],
    evidenceDiagnostics: {
      goldEvidenceIds: ['sess-100#turn-0'],
      matchedEvidenceIds: ['sess-100#turn-0'],
      missingEvidenceIds: [],
      recall: 1,
      hasGoldEvidenceInContext: true,
      hasAllGoldEvidenceInContext: true,
    },
    failureClassification: {
      category: 'none',
      reason: 'Answer matched after evidence became reachable.',
      goldEvidenceReachable: true,
      hasGoldEvidenceInContext: true,
      hasAllGoldEvidenceInContext: true,
    },
    latencyMs: 25,
    promptTokens: 2048,
    completionTokens: 12,
    estimatedCostUsd: 0.015,
  },
];

const runSummary: LongMemEvalRunSummary = {
  runId: 'run-123',
  exampleCount: 1,
  baselines: [
    {
      baseline: 'full_history_upper_bound',
      parityMode: 'upper_bound',
      averageScore: 1,
      averagePromptTokens: 2048,
      averageCompletionTokens: 12,
      averageLatencyMs: 25,
      averageCostUsd: 0.015,
      scorerMode: 'fallback_exact_match',
    },
  ],
};

describe('writeBenchmarkArtifacts', () => {
  it('writes config, per-example, trace, and summary artifacts with the LongMemEval row contract', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'longmemeval-report-'));

    const paths = await writeBenchmarkArtifacts({
      outputDir,
      configSnapshot: {
        runId: 'run-123',
        smoke: true,
      },
      perExampleRows,
      traceRows,
      runSummary,
    });

    const configSnapshot = JSON.parse(await readFile(paths.configSnapshotPath, 'utf8')) as { readonly runId: string };
    const perExampleJsonl = await readFile(paths.perExamplePath, 'utf8');
    const traceJsonl = await readFile(paths.tracePerExamplePath, 'utf8');
    const summaryMarkdown = await readFile(paths.summaryPath, 'utf8');

    expect(configSnapshot.runId).toBe('run-123');
    expect(perExampleJsonl).toContain('"exampleId":"q-001"');
    expect(perExampleJsonl).toContain('"baseline":"full_history_upper_bound"');
    expect(perExampleJsonl).toContain('"score":1');
    expect(perExampleJsonl).toContain('"parityMode":"upper_bound"');
    expect(traceJsonl).toContain('"exampleId":"q-001"');
    expect(traceJsonl).toContain('"traceSchemaVersion":"longmemeval_trace_v1"');
    expect(summaryMarkdown).toContain('Aggregate Score');
    expect(summaryMarkdown).toContain('Retrieval Effectiveness');
    expect(summaryMarkdown).toContain('Failure Mix');
    expect(summaryMarkdown).toContain('full_history_upper_bound');
    expect(summaryMarkdown).toContain('upper_bound');
  });
});
