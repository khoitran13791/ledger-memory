import { performance } from 'node:perf_hooks';

import type {
  LongMemEvalBaselineSummary,
  LongMemEvalBenchmarkConfig,
  LongMemEvalConfigSnapshot,
  LongMemEvalEvidenceDiagnostics,
  LongMemEvalExample,
  LongMemEvalFailureClassification,
  LongMemEvalPerExampleRecord,
  LongMemEvalRunSummary,
  LongMemEvalTraceRecord,
} from './types.js';
import { createBaselineStrategies } from './baselines.js';
import { writeBenchmarkArtifacts, type LongMemEvalArtifactPaths } from './report.js';
import { scorePrediction } from './scorer.js';
import { mean } from './utils.js';

export interface RunLongMemEvalBenchmarkResult extends LongMemEvalArtifactPaths {
  readonly runSummary: LongMemEvalRunSummary;
}

const buildConfigSnapshot = (config: LongMemEvalBenchmarkConfig): LongMemEvalConfigSnapshot => {
  return {
    runId: config.runId,
    smoke: config.smoke,
    canary: config.canary,
    baselines: config.baselines,
    runtimeMode: config.runtimeMode,
    datasetPath: config.datasetPath,
    scorerPath: config.scorerPath,
    fairness: config.fairness,
  };
};

const summarizeBaseline = (input: {
  readonly baseline: LongMemEvalPerExampleRecord['baseline'];
  readonly rows: readonly LongMemEvalPerExampleRecord[];
}): LongMemEvalBaselineSummary => {
  const first = input.rows[0];
  if (first === undefined) {
    throw new Error(`Cannot summarize baseline ${input.baseline} without rows`);
  }

  return {
    baseline: input.baseline,
    parityMode: first.parityMode,
    averageScore: mean(input.rows.map((row) => row.score)),
    averagePromptTokens: mean(input.rows.map((row) => row.promptTokens)),
    averageCompletionTokens: mean(input.rows.map((row) => row.completionTokens)),
    averageLatencyMs: mean(input.rows.map((row) => row.latencyMs)),
    averageCostUsd: mean(input.rows.map((row) => row.estimatedCostUsd)),
    scorerMode: first.scorerMode,
  };
};

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const deriveGoldEvidenceIds = (example: LongMemEvalExample): readonly string[] => {
  const answerTurns = example.history.flatMap((session) =>
    session.turns.filter((turn) => turn.hasAnswer).flatMap((turn) => [turn.turnId, session.sessionId]),
  );

  return unique([...(example.goldEvidenceIds ?? []), ...answerTurns]);
};

const toEvidenceDiagnostics = (input: {
  readonly example: LongMemEvalExample;
  readonly contextIds: readonly string[];
}): LongMemEvalEvidenceDiagnostics => {
  const goldEvidenceIds = deriveGoldEvidenceIds(input.example);
  const matchedEvidenceIds = goldEvidenceIds.filter((id) => input.contextIds.includes(id));
  const missingEvidenceIds = goldEvidenceIds.filter((id) => !matchedEvidenceIds.includes(id));
  const recall = goldEvidenceIds.length === 0 ? 1 : matchedEvidenceIds.length / goldEvidenceIds.length;

  return {
    goldEvidenceIds,
    matchedEvidenceIds,
    missingEvidenceIds,
    recall,
    hasGoldEvidenceInContext: matchedEvidenceIds.length > 0,
    hasAllGoldEvidenceInContext: missingEvidenceIds.length === 0,
  };
};

const classifyFailure = (input: {
  readonly initialEvidenceDiagnostics: LongMemEvalEvidenceDiagnostics;
  readonly finalEvidenceDiagnostics: LongMemEvalEvidenceDiagnostics;
  readonly score: number;
}): LongMemEvalFailureClassification => {
  const goldEvidenceReachable = input.finalEvidenceDiagnostics.hasGoldEvidenceInContext;

  if (!goldEvidenceReachable && input.finalEvidenceDiagnostics.goldEvidenceIds.length > 0) {
    return {
      category: 'reachability_failure',
      reason: 'Gold evidence never became reachable in the final context.',
      goldEvidenceReachable,
      hasGoldEvidenceInContext: input.initialEvidenceDiagnostics.hasGoldEvidenceInContext,
      hasAllGoldEvidenceInContext: input.initialEvidenceDiagnostics.hasAllGoldEvidenceInContext,
    };
  }

  if (input.score < 1) {
    return {
      category: 'answer_synthesis_failure',
      reason: 'Gold evidence was reachable, but the predicted answer still missed the reference.',
      goldEvidenceReachable,
      hasGoldEvidenceInContext: input.initialEvidenceDiagnostics.hasGoldEvidenceInContext,
      hasAllGoldEvidenceInContext: input.initialEvidenceDiagnostics.hasAllGoldEvidenceInContext,
    };
  }

  return {
    category: 'none',
    reason: 'Answer matched after evidence became reachable.',
    goldEvidenceReachable,
    hasGoldEvidenceInContext: input.initialEvidenceDiagnostics.hasGoldEvidenceInContext,
    hasAllGoldEvidenceInContext: input.initialEvidenceDiagnostics.hasAllGoldEvidenceInContext,
  };
};

export const runLongMemEvalBenchmark = async (input: {
  readonly config: LongMemEvalBenchmarkConfig;
  readonly examples: readonly LongMemEvalExample[];
}): Promise<RunLongMemEvalBenchmarkResult> => {
  const perExampleRows: LongMemEvalPerExampleRecord[] = [];
  const traceRows: LongMemEvalTraceRecord[] = [];

  for (const strategy of createBaselineStrategies(input.config)) {
    for (const example of input.examples) {
      const startedAt = performance.now();
      const execution = await strategy.run(example);
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      const estimatedCostUsd =
        (execution.promptTokens / 1000) * input.config.costPer1kPromptUsd +
        (execution.completionTokens / 1000) * input.config.costPer1kCompletionUsd;
      const scoring = await scorePrediction({
        baseline: strategy.baseline,
        prediction: execution.prediction,
        answer: example.answer,
        promptTokens: execution.promptTokens,
        parityTokenBudget: input.config.fairness.tokenBudget,
        scorerPath: input.config.scorerPath,
      });
      const initialEvidenceDiagnostics = toEvidenceDiagnostics({
        example,
        contextIds: execution.initialContextIds,
      });
      const finalEvidenceDiagnostics = toEvidenceDiagnostics({
        example,
        contextIds: execution.postToolContextIds,
      });
      const failureClassification = classifyFailure({
        initialEvidenceDiagnostics,
        finalEvidenceDiagnostics,
        score: scoring.score,
      });

      perExampleRows.push({
        exampleId: example.exampleId,
        baseline: strategy.baseline,
        parityMode: scoring.parityMode,
        prediction: execution.prediction,
        answer: example.answer,
        score: scoring.score,
        latencyMs,
        promptTokens: execution.promptTokens,
        completionTokens: execution.completionTokens,
        estimatedCostUsd,
        scorerMode: scoring.scorerMode,
        evidenceDiagnostics: finalEvidenceDiagnostics,
        failureClassification,
      });

      traceRows.push({
        traceSchemaVersion: 'longmemeval_trace_v1',
        exampleId: example.exampleId,
        baseline: strategy.baseline,
        parityMode: scoring.parityMode,
        initialContextIds: execution.initialContextIds,
        postToolContextIds: execution.postToolContextIds,
        summaryReferenceIds: execution.summaryReferenceIds,
        describedIds: execution.describedIds,
        expandedIds: execution.expandedIds,
        grepQueries: execution.grepQueries,
        toolSteps: execution.toolSteps,
        evidenceDiagnostics: finalEvidenceDiagnostics,
        failureClassification,
        latencyMs,
        promptTokens: execution.promptTokens,
        completionTokens: execution.completionTokens,
        estimatedCostUsd,
      });
    }
  }

  const baselines = [...new Set(perExampleRows.map((row) => row.baseline))].map((baseline) =>
    summarizeBaseline({
      baseline,
      rows: perExampleRows.filter((row) => row.baseline === baseline),
    }),
  );

  const runSummary: LongMemEvalRunSummary = {
    runId: input.config.runId,
    exampleCount: input.examples.length,
    baselines,
  };

  const artifactPaths = await writeBenchmarkArtifacts({
    outputDir: input.config.outputDir,
    configSnapshot: buildConfigSnapshot(input.config),
    perExampleRows,
    traceRows,
    runSummary,
  });

  return {
    ...artifactPaths,
    runSummary,
  };
};
