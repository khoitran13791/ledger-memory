import { mkdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { aggregateBaselineSummary, createTraceWriter, writeSummaryMarkdown } from './report.js';
import type {
  LocomoConfigSnapshot,
  LocomoRunSummary,
  LocomoTraceErrorRecord,
  LocomoTraceSuccessRecord,
  PerExampleRecord,
  SeedScoreSummary,
} from './types.js';

const seedScores: readonly SeedScoreSummary[] = [
  {
    seed: 0,
    aggregate: 0.5,
    categoryScores: {
      1: 0.4,
      2: 0.5,
      3: 0.6,
      4: 0.7,
      5: 0.8,
    },
    countByCategory: {
      1: 1,
      2: 1,
      3: 1,
      4: 1,
      5: 1,
    },
  },
];

const baseRow: PerExampleRecord = {
  runId: 'run-1',
  baseline: 'ledgermind_static_materialize',
  parityMode: 'parity',
  seed: 0,
  sampleId: 'sample-1',
  qaIndex: 0,
  category: 1,
  question: 'Q',
  answer: 'A',
  evidence: [],
  prediction: 'A',
  predictionKey: 'locomo_ledgermind_seed_0_prediction',
  officialScore: 1,
  latencyMs: 10,
  promptTokens: 100,
  completionTokens: 5,
  totalTokens: 105,
  contextTokenEstimate: 90,
  contextIds: ['ctx-1'],
  evidenceInContext: {
    goldEvidenceIds: ['D1:1'],
    matchedEvidenceIds: ['D1:1'],
    missingEvidenceIds: [],
    recall: 1,
    hasGoldEvidenceInContext: true,
    hasAllGoldEvidenceInContext: true,
  },
  costUsd: 0,
  fairnessFingerprint: 'fp',
  status: 'ok',
};

describe('aggregateBaselineSummary provenance', () => {
  it('summarizes actual prediction source counts and runtime provenance from new fields', () => {
    const rows: readonly PerExampleRecord[] = [
      {
        ...baseRow,
        predictionSource: 'llm',
        provenance: {
          requestedPredictionMode: 'llm',
          actualPredictionSource: 'llm',
          runtime: {
            runtimeMode: 'static_materialize',
            summarizerType: 'locomo_deterministic_head_tail_v1',
            artifactsEnabled: true,
            artifactBearingExampleCount: 2,
          },
        },
      },
      {
        ...baseRow,
        qaIndex: 1,
        predictionSource: 'heuristic',
        provenance: {
          requestedPredictionMode: 'llm',
          actualPredictionSource: 'heuristic',
          runtime: {
            runtimeMode: 'static_materialize',
            summarizerType: 'locomo_deterministic_head_tail_v1',
            artifactsEnabled: true,
            artifactBearingExampleCount: 2,
          },
        },
      },
      {
        ...baseRow,
        qaIndex: 2,
      },
    ];

    const summary = aggregateBaselineSummary({
      baseline: 'ledgermind_static_materialize',
      parityMode: 'parity',
      rows,
      seedScores,
    });

    expect(summary.provenance).toBeDefined();
    expect(summary.provenance?.actualPredictionSourceCounts).toEqual({
      totalRows: 3,
      heuristicRows: 1,
      llmRows: 1,
      unknownRows: 1,
    });
    expect(summary.provenance?.runtime).toEqual({
      runtimeMode: 'static_materialize',
      summarizerType: 'locomo_deterministic_head_tail_v1',
      artifactsEnabled: true,
      artifactBearingExampleCount: 2,
    });
    expect(summary.evidenceRecall.overall).toEqual({ mean: 1, std: 0 });
    expect(summary.evidenceRecall.hasAnyEvidenceInContextRate).toEqual({ mean: 1, std: 0 });
    expect(summary.evidenceRecall.hasAllEvidenceInContextRate).toEqual({ mean: 1, std: 0 });
  });

  it('stays backward compatible with legacy rows that only include predictionSource', () => {
    const rows: readonly PerExampleRecord[] = [
      {
        ...baseRow,
        predictionSource: 'heuristic',
      },
      {
        ...baseRow,
        qaIndex: 1,
        predictionSource: 'llm',
      },
    ];

    const summary = aggregateBaselineSummary({
      baseline: 'truncation',
      parityMode: 'parity',
      rows,
      seedScores,
    });

    expect(summary.provenance?.actualPredictionSourceCounts).toEqual({
      totalRows: 2,
      heuristicRows: 1,
      llmRows: 1,
      unknownRows: 0,
    });
    expect(summary.provenance?.runtime).toBeNull();
    expect(summary.evidenceRecall.overall).toEqual({ mean: 1, std: 0 });
  });
});

describe('createTraceWriter', () => {
  it('appends stable jsonl rows for both success and error traces', async () => {
    const outputDir = `${process.cwd()}/.tmp/locomo-trace-writer-test`;
    await mkdir(outputDir, { recursive: true });

    const writer = await createTraceWriter(outputDir);

    const success: LocomoTraceSuccessRecord = {
      traceSchemaVersion: 'locomo_trace_v2',
      runId: 'run-1',
      executionIndex: 1,
      totalExecutionsPlanned: 2,
      baseline: 'ledgermind_static_materialize',
      parityMode: 'parity',
      seed: 0,
      sampleId: 'sample-1',
      qaIndex: 0,
      exampleId: 'sample-1::0',
      category: 1,
      question: 'Q1',
      answer: 'A1',
      answerSource: 'llm',
      status: 'ok',
      finalAnswer: 'pred',
      latencyMs: 123,
      tokens: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        contextTokens: 9,
      },
      contextSelection: {
        contextIds: ['ctx-1'],
        summaryReferenceIds: ['sum-1'],
        artifactReferenceIds: ['art-1'],
        artifactBearingExample: true,
      },
      evidenceDiagnostics: {
        goldEvidenceIds: ['D1:1'],
        matchedEvidenceIds: ['D1:1'],
        missingEvidenceIds: [],
        recall: 1,
        hasGoldEvidenceInContext: true,
        hasAllGoldEvidenceInContext: true,
      },
      retrievalDiagnostics: {
        query: 'who said x',
        hintCount: 1,
        matchCount: 2,
        addedCount: 1,
        hints: [
          {
            hintQuery: 'who said x',
            scopeSummaryId: 'sum-1',
            limit: 1,
            stageQueries: [
              {
                stage: 'primary',
                query: 'who said x',
                matchCount: 2,
              },
            ],
            candidateDecisions: [
              {
                summaryId: 'sum-1',
                score: 120,
                stageHits: 1,
                overlapCount: 2,
                tokenCount: 14,
                selected: true,
                reason: 'selected',
              },
            ],
            selectedSummaryIds: ['sum-1'],
          },
        ],
      },
      materializationDiagnostics: {
        attempted: true,
        contextSource: 'materialized',
      },
      toolLoopDiagnostics: {
        enabled: true,
        maxSteps: 6,
        maxDescribeCalls: 3,
        maxExploreArtifactCalls: 2,
        maxExpandCalls: 2,
        maxGrepCalls: 2,
        maxAddedTokens: 256,
        stepsUsed: 2,
        describedIds: ['sum-1'],
        exploredArtifactIds: [],
        expandedSummaryIds: ['sum-1'],
        grepQueries: ['who said x'],
        addedMessageCount: 1,
        addedTokens: 30,
        preToolEvidenceIds: ['D1:1'],
        postToolEvidenceIds: ['D1:1'],
        describeSignals: [
          {
            id: 'sum-1',
            kind: 'summary',
            entities: ['Alice'],
            dates: ['1 Jan 2026'],
            commitments: ['Alice promised status update'],
            outcomes: ['Checklist approved'],
            lexicalAnchors: ['ZX-41'],
            evidenceIds: ['D1:1'],
          },
        ],
        expandSelection: [
          {
            targetId: 'sum-1',
            score: 9,
            reasons: ['signal_evidence:1'],
          },
        ],
        artifactSelection: [],
        grepSelection: [
          {
            query: 'who said x',
            score: 2,
            reasons: ['global_scope'],
          },
        ],
        steps: [
          {
            step: 1,
            tool: 'describe',
            status: 'ok',
            targetId: 'sum-1',
          },
          {
            step: 2,
            tool: 'expand',
            status: 'ok',
            targetId: 'sum-1',
            addedCount: 1,
            addedTokens: 30,
          },
        ],
      },
      summarizationTrace: [
        {
          summarizerType: 'locomo_deterministic_head_tail_v1',
          mode: 'normal',
          messageCount: 3,
          outputContent: '[Summary]\nassistant | DATE | speaker | fact',
          outputTokenCount: 12,
          preservedArtifactIds: ['file_1'],
        },
      ],
      failureClassification: {
        category: 'none',
        reason: 'Answer aligned with reference and evidence was reachable.',
        goldEvidenceReachable: true,
        hasGoldEvidenceInContext: true,
        hasAllGoldEvidenceInContext: true,
      },
      provenance: {
        requestedPredictionMode: 'llm',
        actualPredictionSource: 'llm',
      },
    };

    const failure: LocomoTraceErrorRecord = {
      traceSchemaVersion: 'locomo_trace_v2',
      runId: 'run-1',
      executionIndex: 2,
      totalExecutionsPlanned: 2,
      baseline: 'rag',
      parityMode: 'parity',
      seed: 0,
      sampleId: 'sample-1',
      qaIndex: 1,
      exampleId: 'sample-1::1',
      category: 2,
      question: 'Q2',
      answer: 'A2',
      answerSource: 'unknown',
      status: 'error',
      latencyMs: 50,
      error: {
        name: 'Error',
        message: 'boom',
      },
      contextSelection: {
        contextIds: [],
        summaryReferenceIds: [],
        artifactReferenceIds: [],
      },
      evidenceDiagnostics: {
        goldEvidenceIds: ['D1:2'],
        matchedEvidenceIds: [],
        missingEvidenceIds: ['D1:2'],
        recall: 0,
        hasGoldEvidenceInContext: false,
        hasAllGoldEvidenceInContext: false,
      },
      failureClassification: {
        category: 'reachability_failure',
        reason: 'Execution failed before answer synthesis completed.',
        goldEvidenceReachable: false,
        hasGoldEvidenceInContext: false,
        hasAllGoldEvidenceInContext: false,
      },
      provenance: {
        requestedPredictionMode: 'llm',
      },
    };

    await writer.writeTraceRow(success);
    await writer.writeTraceRow(failure);

    const text = await readFile(writer.tracePath, 'utf8');
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly status: string;
            readonly traceSchemaVersion: string;
            readonly exampleId: string;
          },
      );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      status: 'ok',
      traceSchemaVersion: 'locomo_trace_v2',
      exampleId: 'sample-1::0',
    });
    expect(lines[1]).toMatchObject({
      status: 'error',
      traceSchemaVersion: 'locomo_trace_v2',
      exampleId: 'sample-1::1',
    });
  });
});

describe('writeSummaryMarkdown provenance section', () => {
  it('renders execution provenance table with requested mode and runtime details', async () => {
    const runSummary: LocomoRunSummary = {
      runId: 'run-1',
      startedAt: '2026-03-12T00:00:00.000Z',
      endedAt: '2026-03-12T00:01:00.000Z',
      fairnessFingerprint: 'fp',
      baselines: [
        {
          baseline: 'ledgermind_static_materialize',
          parityMode: 'parity',
          aggregate: { mean: 0.4, std: 0 },
          categoryScores: {
            1: { mean: 0.4, std: 0 },
            2: { mean: 0.4, std: 0 },
            3: { mean: 0.4, std: 0 },
            4: { mean: 0.4, std: 0 },
            5: { mean: 0.4, std: 0 },
          },
          tokens: {
            prompt: { mean: 100, std: 0 },
            completion: { mean: 5, std: 0 },
            total: { mean: 105, std: 0 },
          },
          latencyMs: { mean: 10, std: 0 },
          costUsd: { mean: 0, std: 0 },
          seedScores,
          evidenceRecall: {
            overall: { mean: 1, std: 0 },
            categoryRecall: {
              1: { mean: 1, std: 0 },
              2: { mean: 1, std: 0 },
              3: { mean: 1, std: 0 },
              4: { mean: 1, std: 0 },
              5: { mean: 1, std: 0 },
            },
            hasAnyEvidenceInContextRate: { mean: 1, std: 0 },
            hasAllEvidenceInContextRate: { mean: 1, std: 0 },
          },
          provenance: {
            actualPredictionSourceCounts: {
              totalRows: 2,
              heuristicRows: 0,
              llmRows: 2,
              unknownRows: 0,
            },
            runtime: {
              runtimeMode: 'static_materialize',
              summarizerType: 'locomo_deterministic_head_tail_v1',
              artifactsEnabled: true,
              artifactBearingExampleCount: 2,
            },
          },
        },
      ],
      executionProvenance: {
        requestedPredictionMode: 'llm',
        baselines: [
          {
            baseline: 'ledgermind_static_materialize',
            actualPredictionSourceCounts: {
              totalRows: 2,
              heuristicRows: 0,
              llmRows: 2,
              unknownRows: 0,
            },
            runtime: {
              runtimeMode: 'static_materialize',
              summarizerType: 'locomo_deterministic_head_tail_v1',
              artifactsEnabled: true,
              artifactBearingExampleCount: 2,
            },
          },
        ],
      },
    };

    const configSnapshot: LocomoConfigSnapshot = {
      runId: 'run-1',
      prediction: {
        mode: 'llm',
      },
      executionProvenance: {
        requestedPredictionMode: 'llm',
        baselines: [
          {
            baseline: 'ledgermind_static_materialize',
            actualPredictionSourceCounts: {
              totalRows: 2,
              heuristicRows: 0,
              llmRows: 2,
              unknownRows: 0,
            },
            runtime: {
              runtimeMode: 'static_materialize',
              summarizerType: 'locomo_deterministic_head_tail_v1',
              artifactsEnabled: true,
              artifactBearingExampleCount: 2,
            },
          },
        ],
      },
    };

    const outputDir = `${process.cwd()}/.tmp/locomo-report-test`;
    await mkdir(outputDir, { recursive: true });
    const traceRow: LocomoTraceSuccessRecord = {
      traceSchemaVersion: 'locomo_trace_v2',
      runId: 'run-1',
      executionIndex: 1,
      totalExecutionsPlanned: 1,
      baseline: 'ledgermind_static_materialize',
      parityMode: 'parity',
      seed: 0,
      sampleId: 'sample-1',
      qaIndex: 0,
      exampleId: 'sample-1::0',
      category: 1,
      question: 'Q1',
      answer: 'A1',
      answerSource: 'llm',
      status: 'ok',
      finalAnswer: 'A1',
      latencyMs: 10,
      tokens: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        contextTokens: 9,
      },
      contextSelection: {
        contextIds: ['D1:1'],
        summaryReferenceIds: ['sum-1'],
        artifactReferenceIds: [],
        artifactBearingExample: true,
      },
      evidenceDiagnostics: {
        goldEvidenceIds: ['D1:1'],
        matchedEvidenceIds: ['D1:1'],
        missingEvidenceIds: [],
        recall: 1,
        hasGoldEvidenceInContext: true,
        hasAllGoldEvidenceInContext: true,
      },
      toolLoopDiagnostics: {
        enabled: true,
        maxSteps: 6,
        maxDescribeCalls: 3,
        maxExploreArtifactCalls: 2,
        maxExpandCalls: 2,
        maxGrepCalls: 2,
        maxAddedTokens: 256,
        stepsUsed: 2,
        describedIds: ['sum-1'],
        exploredArtifactIds: [],
        expandedSummaryIds: ['sum-1'],
        grepQueries: ['Q1'],
        addedMessageCount: 1,
        addedTokens: 20,
        preToolEvidenceIds: ['D1:1'],
        postToolEvidenceIds: ['D1:1'],
        describeSignals: [
          {
            id: 'sum-1',
            kind: 'summary',
            entities: ['Alice'],
            dates: ['1 Jan 2026'],
            commitments: ['Alice promised status update'],
            outcomes: ['Checklist approved'],
            lexicalAnchors: ['ZX-41'],
            evidenceIds: ['D1:1'],
          },
        ],
        expandSelection: [
          {
            targetId: 'sum-1',
            score: 9,
            reasons: ['signal_evidence:1'],
          },
        ],
        artifactSelection: [],
        grepSelection: [
          {
            query: 'Q1',
            score: 2,
            reasons: ['global_scope'],
          },
        ],
        steps: [
          {
            step: 1,
            tool: 'describe',
            status: 'ok',
            targetId: 'sum-1',
          },
          {
            step: 2,
            tool: 'expand',
            status: 'ok',
            targetId: 'sum-1',
            addedCount: 1,
            addedTokens: 20,
          },
        ],
      },
      summarizationTrace: [
        {
          summarizerType: 'locomo_deterministic_head_tail_v1',
          mode: 'normal',
          messageCount: 4,
          outputContent: '[Summary]\nassistant | DATE | speaker | fact',
          outputTokenCount: 14,
          preservedArtifactIds: [],
        },
      ],
      failureClassification: {
        category: 'none',
        reason: 'Answer aligned with reference and evidence was reachable.',
        goldEvidenceReachable: true,
        hasGoldEvidenceInContext: true,
        hasAllGoldEvidenceInContext: true,
      },
      provenance: {
        requestedPredictionMode: 'llm',
        actualPredictionSource: 'llm',
      },
    };
    const writer = await createTraceWriter(outputDir);
    await writer.writeTraceRow(traceRow);

    const path = await writeSummaryMarkdown({
      outputDir,
      runSummary,
      configSnapshot,
    });

    const text = await readFile(path, 'utf8');

    expect(text).toContain('## Ablation Matrix');
    expect(text).toContain('## Score Movement Drivers');
    expect(text).toContain('Answer source (h / l / u / total)');
    expect(text).toContain('| ledgermind_static_materialize | 0.400 ± 0.000 | 0 / 2 / 0 / 2 | static_materialize | locomo_deterministic_head_tail_v1 |');
    expect(text).toContain('No comparable LedgerMind ablation variants in this run.');
    expect(text).toContain('## Execution Provenance');
    expect(text).toContain('Requested prediction mode');
    expect(text).toContain('static_materialize');
    expect(text).toContain('locomo_deterministic_head_tail_v1');
    expect(text).toContain('Artifact-bearing examples');
    expect(text).toContain('| ledgermind_static_materialize | llm | 0 / 2 / 0 / 2 | static_materialize | locomo_deterministic_head_tail_v1 | yes | 2 |');
    expect(text).toContain('Evidence recall');
    expect(text).toContain('Any evidence in context');
    expect(text).toContain('All evidence in context');
    expect(text).toContain('## Tool-loop effectiveness and failure classification');
    expect(text).toContain('Tool-loop executions');
    expect(text).toContain('Reachability failures');
    expect(text).toContain('0/1 (0.0%)');
    expect(text).toContain('## Artifact-bearing examples');
    expect(text).toContain('Artifact-bearing executions');
    expect(text).toContain('1/1 (100.0%)');
  });
});
