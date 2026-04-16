import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  LongMemEvalConfigSnapshot,
  LongMemEvalPerExampleRecord,
  LongMemEvalRunSummary,
  LongMemEvalTraceRecord,
} from './types.js';
import { formatNumber, mean, stableJson } from './utils.js';

export interface LongMemEvalArtifactPaths {
  readonly configSnapshotPath: string;
  readonly perExamplePath: string;
  readonly tracePerExamplePath: string;
  readonly summaryPath: string;
}

export const ensureOutputDir = async (outputDir: string): Promise<void> => {
  await mkdir(outputDir, { recursive: true });
};

export const writeConfigSnapshot = async (input: {
  readonly outputDir: string;
  readonly configSnapshot: LongMemEvalConfigSnapshot;
}): Promise<string> => {
  const configSnapshotPath = path.join(input.outputDir, 'config_snapshot.json');
  await writeFile(configSnapshotPath, `${stableJson(input.configSnapshot)}\n`, 'utf8');
  return configSnapshotPath;
};

export const writePerExampleJsonl = async (input: {
  readonly outputDir: string;
  readonly perExampleRows: readonly LongMemEvalPerExampleRecord[];
}): Promise<string> => {
  const perExamplePath = path.join(input.outputDir, 'per_example.jsonl');
  await writeFile(perExamplePath, `${input.perExampleRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return perExamplePath;
};

export const writeTraceJsonl = async (input: {
  readonly outputDir: string;
  readonly traceRows: readonly LongMemEvalTraceRecord[];
}): Promise<string> => {
  const tracePerExamplePath = path.join(input.outputDir, 'trace_per_example.jsonl');
  await writeFile(tracePerExamplePath, `${input.traceRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return tracePerExamplePath;
};

export const writeSummaryMarkdown = async (input: {
  readonly outputDir: string;
  readonly runSummary: LongMemEvalRunSummary;
  readonly traceRows: readonly LongMemEvalTraceRecord[];
}): Promise<string> => {
  const summaryPath = path.join(input.outputDir, 'summary.md');
  const diagnosticsRowsByBaseline = new Map<
    string,
    {
      initialReachabilityRate: number;
      finalReachabilityRate: number;
      reachabilityFailures: number;
      answerSynthesisFailures: number;
      averageToolDepth: number;
    }
  >();

  for (const baseline of [...new Set(input.traceRows.map((row) => row.baseline))]) {
    const rows = input.traceRows.filter((row) => row.baseline === baseline);
    diagnosticsRowsByBaseline.set(baseline, {
      initialReachabilityRate: mean(
        rows.map((row) => (row.failureClassification.hasGoldEvidenceInContext ? 1 : 0)),
      ),
      finalReachabilityRate: mean(
        rows.map((row) => (row.failureClassification.goldEvidenceReachable ? 1 : 0)),
      ),
      reachabilityFailures: rows.filter(
        (row) => row.failureClassification.category === 'reachability_failure',
      ).length,
      answerSynthesisFailures: rows.filter(
        (row) => row.failureClassification.category === 'answer_synthesis_failure',
      ).length,
      averageToolDepth: mean(
        rows.map((row) => row.toolSteps.filter((step) => step.outcome !== 'skipped').length),
      ),
    });
  }

  const lines = [
    '# LongMemEval Run Summary',
    '',
    `Run ID: ${input.runSummary.runId}`,
    `Examples: ${input.runSummary.exampleCount}`,
    '',
    '## Aggregate Score',
    '',
    '| Baseline | Parity Mode | Average Score | Prompt Tokens | Completion Tokens | Latency ms | Cost USD | Scorer Mode |',
    '|---|---|---:|---:|---:|---:|---:|---|',
    ...input.runSummary.baselines.map((baseline) =>
      `| ${baseline.baseline} | ${baseline.parityMode} | ${formatNumber(baseline.averageScore)} | ${formatNumber(baseline.averagePromptTokens, 0)} | ${formatNumber(baseline.averageCompletionTokens, 0)} | ${formatNumber(baseline.averageLatencyMs, 0)} | ${formatNumber(baseline.averageCostUsd, 6)} | ${baseline.scorerMode} |`,
    ),
    '',
    '## Retrieval Effectiveness',
    '',
    '| Baseline | Reachability Before Tool Loop | Reachability After Tool Loop | Reachability Failures | Answer Synthesis Failures | Average Tool Depth |',
    '|---|---:|---:|---:|---:|---:|',
    ...input.runSummary.baselines.map((baseline) => {
      const diagnostics = diagnosticsRowsByBaseline.get(baseline.baseline);
      return `| ${baseline.baseline} | ${formatNumber((diagnostics?.initialReachabilityRate ?? 0) * 100, 1)}% | ${formatNumber((diagnostics?.finalReachabilityRate ?? 0) * 100, 1)}% | ${diagnostics?.reachabilityFailures ?? 0} | ${diagnostics?.answerSynthesisFailures ?? 0} | ${formatNumber(diagnostics?.averageToolDepth ?? 0, 1)} |`;
    }),
    '',
    '## Failure Mix',
    '',
    ...input.runSummary.baselines.map((baseline) => {
      const diagnostics = diagnosticsRowsByBaseline.get(baseline.baseline);
      return `- ${baseline.baseline}: reachability_failure=${diagnostics?.reachabilityFailures ?? 0}, answer_synthesis_failure=${diagnostics?.answerSynthesisFailures ?? 0}`;
    }),
  ];

  await writeFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  return summaryPath;
};

export const writeBenchmarkArtifacts = async (input: {
  readonly outputDir: string;
  readonly configSnapshot: LongMemEvalConfigSnapshot;
  readonly perExampleRows: readonly LongMemEvalPerExampleRecord[];
  readonly traceRows: readonly LongMemEvalTraceRecord[];
  readonly runSummary: LongMemEvalRunSummary;
}): Promise<LongMemEvalArtifactPaths> => {
  await ensureOutputDir(input.outputDir);

  const [configSnapshotPath, perExamplePath, tracePerExamplePath, summaryPath] = await Promise.all([
    writeConfigSnapshot({ outputDir: input.outputDir, configSnapshot: input.configSnapshot }),
    writePerExampleJsonl({ outputDir: input.outputDir, perExampleRows: input.perExampleRows }),
    writeTraceJsonl({ outputDir: input.outputDir, traceRows: input.traceRows }),
    writeSummaryMarkdown({
      outputDir: input.outputDir,
      runSummary: input.runSummary,
      traceRows: input.traceRows,
    }),
  ]);

  return {
    configSnapshotPath,
    perExamplePath,
    tracePerExamplePath,
    summaryPath,
  };
};
