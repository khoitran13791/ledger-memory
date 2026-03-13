import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { LocomoBenchmarkConfig, LocomoConversationSample, LocomoExample } from './index.js';
import { runLocomoBenchmark } from './runner.js';

const sample: LocomoConversationSample = {
  sample_id: 'sample-1',
  conversation: {
    session_1_date_time: '1:00 pm on 1 Jan, 2026',
    session_1: [
      {
        speaker: 'Alice',
        dia_id: 'D1:1',
        text: 'I adopted a rescue dog named Comet yesterday.',
        blip_caption: 'a photo of Comet in the park',
      },
      {
        speaker: 'Bob',
        dia_id: 'D1:2',
        text: 'That is wonderful news.',
      },
    ],
  },
  qa: [
    {
      question: 'What is the name of the dog Alice adopted?',
      answer: 'Comet',
      evidence: ['D1:1'],
      category: 3,
    },
    {
      question: 'What photo did Alice share?',
      answer: 'A photo of Comet',
      evidence: ['D1:1'],
      category: 1,
    },
    {
      question: 'Did Alice mention a cat?',
      answer: 'Not mentioned in the conversation',
      evidence: ['D9:9'],
      category: 5,
    },
    {
      question: 'When did Bob mention this?',
      answer: '1 Jan 2026',
      evidence: [],
      category: 2,
    },
  ],
};

const examples: readonly LocomoExample[] = [
  {
    sampleId: 'sample-1',
    qaIndex: 0,
    category: 3,
    question: 'What is the name of the dog Alice adopted?',
    answer: 'Comet',
    evidence: ['D1:1'],
  },
  {
    sampleId: 'sample-1',
    qaIndex: 1,
    category: 1,
    question: 'What photo did Alice share?',
    answer: 'A photo of Comet',
    evidence: ['D1:1'],
  },
  {
    sampleId: 'sample-1',
    qaIndex: 2,
    category: 5,
    question: 'Did Alice mention a cat?',
    answer: 'Not mentioned in the conversation',
    evidence: ['D9:9'],
  },
  {
    sampleId: 'sample-1',
    qaIndex: 3,
    category: 2,
    question: 'When did Bob mention this?',
    answer: '1 Jan 2026',
    evidence: [],
  },
];

const makeConfig = (
  outputDir: string,
  baselines: LocomoBenchmarkConfig['baselines'] = ['truncation'],
  overrides?: Partial<LocomoBenchmarkConfig>,
): LocomoBenchmarkConfig => ({
  runId: 'run-evidence-metrics',
  datasetPath: 'benchmarks/locomo/data/locomo10.json',
  outputDir,
  baselines,
  seeds: [0],
  smoke: true,
  canary: false,
  fairness: {
    modelName: 'gpt-4o-mini',
    promptTemplate: 'Answer from the context.',
    temperature: 0,
    topP: 1,
    tokenBudget: 3000,
    overheadTokens: 300,
    maxAnswerTokens: 32,
  },
  predictionMode: 'heuristic',
  seedMode: 'ignored',
  llmBaseUrl: undefined,
  llmApiKey: undefined,
  llmTimeoutMs: 1000,
  maxExamples: undefined,
  scorerPath: 'benchmarks/locomo/vendor/locomo/task_eval/evaluation.py',
  scorerVersion: 'test',
  smokeExampleIdsPath: 'benchmarks/locomo/config/smoke-example-ids.json',
  canaryExampleIdsPath: 'benchmarks/locomo/config/canary-example-ids.json',
  retrievedSummaryLimit: 6,
  ragTopK: 8,
  ledgermindRawTurnInjectionTopK: 4,
  ledgermindRawTurnInjectionMaxTokens: 256,
  ledgermindToolLoopMaxSteps: 6,
  ledgermindToolLoopMaxDescribeCalls: 3,
  ledgermindToolLoopMaxExploreArtifactCalls: 2,
  ledgermindToolLoopMaxExpandCalls: 2,
  ledgermindToolLoopMaxGrepCalls: 2,
  ledgermindToolLoopMaxAddedTokens: 256,
  includeLedgermindDiagnostics: false,
  fairnessFingerprintInputs: {
    ledgermindRetrievalReserveFraction: 0.2,
    ledgermindRetrievalReserveMaxTokens: 256,
    ledgermindSummaryFormatter: 'structured_head_tail_v1',
    summarySearchScoring: 'staged_candidate_selection_v1',
    predictionExtractorVersion: 'llm_completion_v1',
    category5PromptVersion: 'no_answer_choices_v1',
    rawTurnInjectionFormatterVersion: 'plain_lines_v2',
    rawTurnInjectionSelectionVersion: 'question_overlap_topk_v2',
    ledgermindToolLoopMaxSteps: 6,
    ledgermindToolLoopMaxDescribeCalls: 3,
    ledgermindToolLoopMaxExploreArtifactCalls: 2,
    ledgermindToolLoopMaxExpandCalls: 2,
    ledgermindToolLoopMaxGrepCalls: 2,
    ledgermindToolLoopMaxAddedTokens: 256,
    locomoArtifactMappingVersion: 'blip_caption_text_artifact_v1',
  },
  runtimeMode: 'static_materialize',
  summarizerType: 'locomo_deterministic_head_tail_v1',
  artifactsEnabled: true,
  fairnessFingerprint: 'fp',
  promptHash: 'prompt-hash',
  costPer1kPromptUsd: 0,
  costPer1kCompletionUsd: 0,
  ...overrides,
});

describe('runLocomoBenchmark evidence-in-context metrics', () => {
  it('writes per-example and trace evidence diagnostics and aggregates recall', async () => {
    const outputDir = `${process.cwd()}/.tmp/locomo-runner-evidence-test`;

    const result = await runLocomoBenchmark({
      config: makeConfig(outputDir),
      samples: [sample],
      examples,
    });

    const baselineSummary = result.runSummary.baselines.find((summary) => summary.baseline === 'truncation');
    expect(baselineSummary).toBeDefined();

    expect(baselineSummary?.evidenceRecall.overall.mean).toBeCloseTo((1 + 1 + 0 + 1) / 4, 6);
    expect(baselineSummary?.evidenceRecall.categoryRecall[1]?.mean).toBe(1);
    expect(baselineSummary?.evidenceRecall.categoryRecall[3]?.mean).toBe(1);
    expect(baselineSummary?.evidenceRecall.categoryRecall[5]?.mean).toBe(0);
    expect(baselineSummary?.evidenceRecall.categoryRecall[2]?.mean).toBe(1);
    expect(baselineSummary?.evidenceRecall.hasAnyEvidenceInContextRate.mean).toBeCloseTo(2 / 4, 6);
    expect(baselineSummary?.evidenceRecall.hasAllEvidenceInContextRate.mean).toBeCloseTo(3 / 4, 6);

    const perExampleRows = (await readFile(result.perExamplePath, 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly qaIndex: number;
            readonly evidenceInContext: { readonly recall: number };
            readonly artifactBearingExample?: boolean;
          },
      );
    expect(perExampleRows).toHaveLength(4);
    expect(perExampleRows.find((row) => row.qaIndex === 0)?.evidenceInContext.recall).toBe(1);
    expect(perExampleRows.find((row) => row.qaIndex === 1)?.evidenceInContext.recall).toBe(1);
    expect(perExampleRows.find((row) => row.qaIndex === 2)?.evidenceInContext.recall).toBe(0);
    expect(perExampleRows.find((row) => row.qaIndex === 3)?.evidenceInContext.recall).toBe(1);

    const traceRows = (await readFile(result.tracePerExamplePath, 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly qaIndex: number;
            readonly status: string;
            readonly traceSchemaVersion: string;
            readonly contextSelection?: { readonly artifactBearingExample?: boolean };
            readonly evidenceDiagnostics?: { readonly recall: number };
            readonly retrievalDiagnostics?: {
              readonly reservedForToolLoopTokens?: number;
              readonly reservedForRetrievalTokens?: number;
            };
            readonly failureClassification?: { readonly category: string; readonly goldEvidenceReachable: boolean };
          },
      );
    expect(traceRows).toHaveLength(4);
    expect(traceRows.every((row) => row.status === 'ok')).toBe(true);
    expect(traceRows.every((row) => row.traceSchemaVersion === 'locomo_trace_v2')).toBe(true);
    expect(traceRows.find((row) => row.qaIndex === 0)?.evidenceDiagnostics?.recall).toBe(1);
    expect(traceRows.find((row) => row.qaIndex === 1)?.evidenceDiagnostics?.recall).toBe(1);
    expect(traceRows.find((row) => row.qaIndex === 2)?.evidenceDiagnostics?.recall).toBe(0);
    expect(traceRows.find((row) => row.qaIndex === 3)?.evidenceDiagnostics?.recall).toBe(1);
    const retrievalTrace = traceRows.find((row) => row.qaIndex === 0)?.retrievalDiagnostics;
    if (retrievalTrace !== undefined) {
      expect(retrievalTrace.reservedForRetrievalTokens).toBeGreaterThan(0);
      expect(retrievalTrace.reservedForToolLoopTokens).toBeUndefined();
    }
    expect(traceRows.find((row) => row.qaIndex === 0)?.failureClassification?.category).toBe('answer_synthesis_failure');
    expect(traceRows.find((row) => row.qaIndex === 0)?.failureClassification?.goldEvidenceReachable).toBe(true);
    expect(traceRows.find((row) => row.qaIndex === 2)?.failureClassification?.category).toBe('reachability_failure');
    expect(traceRows.find((row) => row.qaIndex === 2)?.failureClassification?.goldEvidenceReachable).toBe(false);
  });
});
