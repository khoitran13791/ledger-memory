import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  BaselineAggregateSummary,
  BaselineExecutionProvenanceSummary,
  LocomoConfigSnapshot,
  LocomoPredictionSource,
  LocomoRunSummary,
  LocomoTraceRecord,
  LocomoRuntimeProvenance,
  PerExampleRecord,
  PredictionSourceCountSummary,
  PromotionGateResult,
  SeedScoreSummary,
  StatsSummary,
} from './types.js';
import { formatNumber, mean, sampleStd, stableJson } from './utils.js';

const CATEGORY_ORDER = [1, 2, 3, 4, 5] as const;

const toStats = (values: readonly number[]): StatsSummary => ({
  mean: mean(values),
  std: sampleStd(values),
});

const categoryLabel = (category: number): string => {
  switch (category) {
    case 1:
      return 'multi-hop';
    case 2:
      return 'temporal';
    case 3:
      return 'single-hop / inferential';
    case 4:
      return 'open-domain';
    case 5:
      return 'adversarial';
    default:
      return `category-${category}`;
  }
};

export const ensureOutputDir = async (outputDir: string): Promise<void> => {
  await mkdir(outputDir, { recursive: true });
};

export const writeConfigSnapshot = async (input: {
  readonly outputDir: string;
  readonly snapshot: LocomoConfigSnapshot;
}): Promise<string> => {
  const pathName = path.resolve(input.outputDir, 'config_snapshot.json');
  await writeFile(pathName, `${JSON.stringify(input.snapshot, null, 2)}\n`, 'utf8');
  return pathName;
};

export const writePerExampleJsonl = async (input: {
  readonly outputDir: string;
  readonly rows: readonly PerExampleRecord[];
}): Promise<string> => {
  const pathName = path.resolve(input.outputDir, 'per_example.jsonl');
  const jsonl = `${input.rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await writeFile(pathName, jsonl, 'utf8');
  return pathName;
};

export const createTraceWriter = async (outputDir: string): Promise<{
  readonly tracePath: string;
  writeTraceRow(row: LocomoTraceRecord): Promise<void>;
}> => {
  const tracePath = path.resolve(outputDir, 'trace_per_example.jsonl');
  await writeFile(tracePath, '', 'utf8');

  return {
    tracePath,
    async writeTraceRow(row: LocomoTraceRecord): Promise<void> {
      await appendFile(tracePath, `${JSON.stringify(row)}\n`, 'utf8');
    },
  };
};

const normalizePredictionSource = (row: PerExampleRecord): LocomoPredictionSource | undefined => {
  return row.provenance?.actualPredictionSource ?? row.predictionSource;
};

const toPredictionSourceCounts = (rows: readonly PerExampleRecord[]): PredictionSourceCountSummary => {
  let heuristicRows = 0;
  let llmRows = 0;

  for (const row of rows) {
    const source = normalizePredictionSource(row);
    if (source === 'heuristic') {
      heuristicRows += 1;
      continue;
    }

    if (source === 'llm') {
      llmRows += 1;
    }
  }

  const totalRows = rows.length;
  const unknownRows = Math.max(0, totalRows - heuristicRows - llmRows);

  return {
    totalRows,
    heuristicRows,
    llmRows,
    unknownRows,
  };
};

const stableRuntimeKey = (runtime: LocomoRuntimeProvenance): string => {
  return JSON.stringify(runtime);
};

const toRuntimeProvenance = (rows: readonly PerExampleRecord[]): LocomoRuntimeProvenance | null => {
  const runtimes = rows
    .map((row) => row.provenance?.runtime)
    .filter((runtime): runtime is LocomoRuntimeProvenance => runtime !== undefined);

  if (runtimes.length === 0) {
    return null;
  }

  const uniqueRuntimeKeys = new Set(runtimes.map((runtime) => stableRuntimeKey(runtime)));
  if (uniqueRuntimeKeys.size > 1) {
    return null;
  }

  return runtimes[0] ?? null;
};

const toBaselineExecutionProvenanceSummary = (rows: readonly PerExampleRecord[]): BaselineExecutionProvenanceSummary => {
  return {
    actualPredictionSourceCounts: toPredictionSourceCounts(rows),
    runtime: toRuntimeProvenance(rows),
  };
};

export const aggregateBaselineSummary = (input: {
  readonly baseline: string;
  readonly parityMode: 'parity' | 'upper_bound';
  readonly rows: readonly PerExampleRecord[];
  readonly seedScores: readonly SeedScoreSummary[];
}): BaselineAggregateSummary => {
  const rowsBySeed = new Map<number, PerExampleRecord[]>();
  input.rows.forEach((row) => {
    const bucket = rowsBySeed.get(row.seed) ?? [];
    bucket.push(row);
    rowsBySeed.set(row.seed, bucket);
  });

  const promptBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => row.promptTokens));
  });
  const completionBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => row.completionTokens));
  });
  const totalBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => row.totalTokens));
  });
  const latencyBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => row.latencyMs));
  });
  const costBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => row.costUsd));
  });

  const categoryScores: Record<number, StatsSummary> = {};
  for (const category of CATEGORY_ORDER) {
    categoryScores[category] = toStats(
      input.seedScores.map((seedScore) => seedScore.categoryScores[category] ?? 0),
    );
  }

  const evidenceRecallBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => row.evidenceInContext.recall));
  });
  const hasAnyEvidenceInContextRateBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => (row.evidenceInContext.hasGoldEvidenceInContext ? 1 : 0)));
  });
  const hasAllEvidenceInContextRateBySeed = input.seedScores.map((seedScore) => {
    const rows = rowsBySeed.get(seedScore.seed) ?? [];
    return mean(rows.map((row) => (row.evidenceInContext.hasAllGoldEvidenceInContext ? 1 : 0)));
  });

  const evidenceRecallByCategory: Record<number, StatsSummary> = {};
  for (const category of CATEGORY_ORDER) {
    const bySeed = input.seedScores.map((seedScore) => {
      const rows = (rowsBySeed.get(seedScore.seed) ?? []).filter((row) => row.category === category);
      return mean(rows.map((row) => row.evidenceInContext.recall));
    });

    evidenceRecallByCategory[category] = toStats(bySeed);
  }

  const diagnosticsRows = input.rows.filter((row) => row.diagnostics !== undefined);

  const diagnostics =
    diagnosticsRows.length === 0
      ? undefined
      : (() => {
          const materializedRows = diagnosticsRows.filter(
            (row) => row.diagnostics?.contextSource === 'materialized',
          ).length;
          const fallbackRows = diagnosticsRows.filter(
            (row) => row.diagnostics?.contextSource === 'fallback_truncation',
          ).length;

          const errorCounts = new Map<string, number>();
          for (const row of diagnosticsRows) {
            const code = row.diagnostics?.materializationErrorCode;
            if (code === undefined || code.trim().length === 0) {
              continue;
            }
            errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
          }

          const topMaterializationErrorCodes = [...errorCounts.entries()]
            .sort((left, right) => {
              if (right[1] !== left[1]) {
                return right[1] - left[1];
              }

              return left[0].localeCompare(right[0]);
            })
            .slice(0, 5)
            .map(([code, count]) => ({ code, count }));

          return {
            totalRows: diagnosticsRows.length,
            materializedRows,
            fallbackRows,
            fallbackRate: diagnosticsRows.length === 0 ? 0 : fallbackRows / diagnosticsRows.length,
            averageSummaryReferenceCount: mean(
              diagnosticsRows.map((row) => row.diagnostics?.summaryReferenceCount ?? 0),
            ),
            averageArtifactReferenceCount: mean(
              diagnosticsRows.map((row) => row.diagnostics?.artifactReferenceCount ?? 0),
            ),
            averageRetrievalMatchCount: mean(
              diagnosticsRows.map((row) => row.diagnostics?.retrievalMatchCount ?? 0),
            ),
            averageRetrievalAddedCount: mean(
              diagnosticsRows.map((row) => row.diagnostics?.retrievalAddedCount ?? 0),
            ),
            averageRawTurnInjectionCandidateCount: mean(
              diagnosticsRows.map((row) => row.diagnostics?.rawTurnInjectionCandidateCount ?? 0),
            ),
            averageRawTurnInjectionAddedCount: mean(
              diagnosticsRows.map((row) => row.diagnostics?.rawTurnInjectionAddedCount ?? 0),
            ),
            artifactBearingExampleRate: mean(
              diagnosticsRows.map((row) => (row.diagnostics?.artifactBearingExample === true ? 1 : 0)),
            ),
            preCompactionEnabledRate: mean(
              diagnosticsRows.map((row) => (row.diagnostics?.preCompactionEnabled === true ? 1 : 0)),
            ),
            rawTurnInjectionEnabledRate: mean(
              diagnosticsRows.map((row) => (row.diagnostics?.rawTurnInjectionEnabled === true ? 1 : 0)),
            ),
            topMaterializationErrorCodes,
          };
        })();

  return {
    baseline: input.baseline as BaselineAggregateSummary['baseline'],
    parityMode: input.parityMode,
    aggregate: toStats(input.seedScores.map((seedScore) => seedScore.aggregate)),
    categoryScores,
    tokens: {
      prompt: toStats(promptBySeed),
      completion: toStats(completionBySeed),
      total: toStats(totalBySeed),
    },
    latencyMs: toStats(latencyBySeed),
    costUsd: toStats(costBySeed),
    seedScores: input.seedScores,
    evidenceRecall: {
      overall: toStats(evidenceRecallBySeed),
      categoryRecall: evidenceRecallByCategory,
      hasAnyEvidenceInContextRate: toStats(hasAnyEvidenceInContextRateBySeed),
      hasAllEvidenceInContextRate: toStats(hasAllEvidenceInContextRateBySeed),
    },
    provenance: toBaselineExecutionProvenanceSummary(input.rows),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
};

const renderSummaryTable = (summaries: readonly BaselineAggregateSummary[]): string => {
  const header =
    '| Baseline | Mode | Official score | Evidence recall | Any evidence in context | All evidence in context | Prompt tokens | Completion tokens | Total tokens | Latency ms | Cost USD |';
  const separator = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = summaries.map((summary) => {
    return `| ${summary.baseline} | ${summary.parityMode} | ${formatNumber(summary.aggregate.mean)} ± ${formatNumber(summary.aggregate.std)} | ${formatNumber(summary.evidenceRecall.overall.mean)} ± ${formatNumber(summary.evidenceRecall.overall.std)} | ${formatNumber(summary.evidenceRecall.hasAnyEvidenceInContextRate.mean * 100, 1)}% ± ${formatNumber(summary.evidenceRecall.hasAnyEvidenceInContextRate.std * 100, 1)}% | ${formatNumber(summary.evidenceRecall.hasAllEvidenceInContextRate.mean * 100, 1)}% ± ${formatNumber(summary.evidenceRecall.hasAllEvidenceInContextRate.std * 100, 1)}% | ${formatNumber(summary.tokens.prompt.mean)} ± ${formatNumber(summary.tokens.prompt.std)} | ${formatNumber(summary.tokens.completion.mean)} ± ${formatNumber(summary.tokens.completion.std)} | ${formatNumber(summary.tokens.total.mean)} ± ${formatNumber(summary.tokens.total.std)} | ${formatNumber(summary.latencyMs.mean)} ± ${formatNumber(summary.latencyMs.std)} | ${formatNumber(summary.costUsd.mean, 6)} ± ${formatNumber(summary.costUsd.std, 6)} |`;
  });

  return [header, separator, ...rows].join('\n');
};

const renderCategoryTable = (summaries: readonly BaselineAggregateSummary[]): string => {
  const header = '| Baseline | Category | Score (mean ± std) | Evidence recall (mean ± std) |';
  const separator = '|---|---|---:|---:|';

  const rows: string[] = [];

  for (const summary of summaries) {
    for (const category of CATEGORY_ORDER) {
      const stats = summary.categoryScores[category] ?? { mean: 0, std: 0 };
      const evidenceRecall = summary.evidenceRecall.categoryRecall[category] ?? { mean: 0, std: 0 };
      rows.push(
        `| ${summary.baseline} | ${categoryLabel(category)} (${category}) | ${formatNumber(stats.mean)} ± ${formatNumber(stats.std)} | ${formatNumber(evidenceRecall.mean)} ± ${formatNumber(evidenceRecall.std)} |`,
      );
    }
  }

  return [header, separator, ...rows].join('\n');
};

const renderDiagnosticsTable = (summaries: readonly BaselineAggregateSummary[]): string => {
  const diagnosticsRows = summaries.filter((summary) => summary.diagnostics !== undefined);
  if (diagnosticsRows.length === 0) {
    return '_No diagnostics captured._';
  }

  const header =
    '| Baseline | Materialized rows | Fallback rows | Fallback rate | Avg summary refs | Avg artifact refs | Avg retrieval matches | Avg retrieval added | Avg raw turn candidates | Avg raw turn added | Artifact-bearing rate | Precompact rate | Raw-turn injection rate | Top error codes |';
  const separator = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|';

  const rows = diagnosticsRows.map((summary) => {
    const diagnostics = summary.diagnostics;
    if (diagnostics === undefined) {
      return '';
    }

    const topErrors =
      diagnostics.topMaterializationErrorCodes.length === 0
        ? '-'
        : diagnostics.topMaterializationErrorCodes
            .map((entry) => `${entry.code} (${entry.count})`)
            .join(', ');

    const safeTopErrors = topErrors.replaceAll('|', '/');

    return `| ${summary.baseline} | ${diagnostics.materializedRows}/${diagnostics.totalRows} | ${diagnostics.fallbackRows}/${diagnostics.totalRows} | ${formatNumber(diagnostics.fallbackRate * 100, 1)}% | ${formatNumber(diagnostics.averageSummaryReferenceCount)} | ${formatNumber(diagnostics.averageArtifactReferenceCount)} | ${formatNumber(diagnostics.averageRetrievalMatchCount)} | ${formatNumber(diagnostics.averageRetrievalAddedCount)} | ${formatNumber(diagnostics.averageRawTurnInjectionCandidateCount)} | ${formatNumber(diagnostics.averageRawTurnInjectionAddedCount)} | ${formatNumber(diagnostics.artifactBearingExampleRate * 100, 1)}% | ${formatNumber(diagnostics.preCompactionEnabledRate * 100, 1)}% | ${formatNumber(diagnostics.rawTurnInjectionEnabledRate * 100, 1)}% | ${safeTopErrors} |`;
  });

  return [header, separator, ...rows.filter((row) => row.length > 0)].join('\n');
};

const renderExecutionProvenanceTable = (input: {
  readonly runSummary: LocomoRunSummary;
  readonly fallbackRequestedPredictionMode: string | undefined;
}): string => {
  const provenance = input.runSummary.executionProvenance;
  if (provenance === undefined) {
    return '_No execution provenance captured._';
  }

  const header =
    '| Baseline | Requested prediction mode | Actual prediction source counts (heuristic / llm / unknown / total) | Runtime mode | Summarizer type | Artifacts enabled | Artifact-bearing examples |';
  const separator = '|---|---|---|---|---|---|---:|';

  const requestedPredictionMode = provenance.requestedPredictionMode ?? input.fallbackRequestedPredictionMode ?? 'unknown';

  const rows = provenance.baselines.map((baseline) => {
    const runtime = baseline.runtime;
    const counts = baseline.actualPredictionSourceCounts;
    const runtimeMode = runtime?.runtimeMode ?? '-';
    const summarizerType = runtime?.summarizerType ?? '-';
    const artifactsEnabled = runtime === null ? '-' : runtime.artifactsEnabled ? 'yes' : 'no';
    const artifactBearingExampleCount = runtime?.artifactBearingExampleCount ?? '-';

    return `| ${baseline.baseline} | ${requestedPredictionMode} | ${counts.heuristicRows} / ${counts.llmRows} / ${counts.unknownRows} / ${counts.totalRows} | ${runtimeMode} | ${summarizerType} | ${artifactsEnabled} | ${artifactBearingExampleCount} |`;
  });

  return [header, separator, ...rows].join('\n');
};

type LocomoTraceSuccessRecord = Extract<LocomoTraceRecord, { status: 'ok' }>;

interface BaselineTraceAblationSummary {
  readonly avgToolStepsUsed: number;
  readonly avgToolAddedTokens: number;
  readonly topSelectionReasons: readonly string[];
}

const toSuccessTraceRows = (traceRows: readonly LocomoTraceRecord[]): readonly LocomoTraceSuccessRecord[] => {
  return traceRows.filter((row): row is LocomoTraceSuccessRecord => row.status === 'ok');
};

const collectSelectionReasons = (row: LocomoTraceSuccessRecord): readonly string[] => {
  const diagnostics = row.toolLoopDiagnostics;
  if (diagnostics === undefined) {
    return [];
  }

  return [
    ...(diagnostics.expandSelection ?? []).flatMap((selection) => selection.reasons),
    ...(diagnostics.artifactSelection ?? []).flatMap((selection) => selection.reasons),
    ...(diagnostics.grepSelection ?? []).flatMap((selection) => selection.reasons),
  ];
};

const summarizeTraceAblationByBaseline = (
  traceRows: readonly LocomoTraceRecord[],
): ReadonlyMap<string, BaselineTraceAblationSummary> => {
  const byBaseline = new Map<string, LocomoTraceSuccessRecord[]>();

  for (const row of toSuccessTraceRows(traceRows)) {
    const bucket = byBaseline.get(row.baseline) ?? [];
    bucket.push(row);
    byBaseline.set(row.baseline, bucket);
  }

  const summarized = new Map<string, BaselineTraceAblationSummary>();

  for (const [baseline, rows] of byBaseline.entries()) {
    const toolRows = rows.filter((row) => row.toolLoopDiagnostics?.enabled === true);
    const avgToolStepsUsed =
      toolRows.length === 0 ? 0 : mean(toolRows.map((row) => row.toolLoopDiagnostics?.stepsUsed ?? 0));
    const avgToolAddedTokens =
      toolRows.length === 0 ? 0 : mean(toolRows.map((row) => row.toolLoopDiagnostics?.addedTokens ?? 0));

    const reasonCounts = new Map<string, number>();
    for (const row of toolRows) {
      for (const reason of collectSelectionReasons(row)) {
        if (reason.trim().length === 0) {
          continue;
        }
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }

    const topSelectionReasons = [...reasonCounts.entries()]
      .sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }

        return left[0].localeCompare(right[0]);
      })
      .slice(0, 3)
      .map(([reason, count]) => `${reason} (${count})`);

    summarized.set(baseline, {
      avgToolStepsUsed,
      avgToolAddedTokens,
      topSelectionReasons,
    });
  }

  return summarized;
};

const toToggleLabel = (rate: number | undefined): string => {
  if (rate === undefined) {
    return '-';
  }

  if (rate >= 0.999) {
    return 'on';
  }

  if (rate <= 0.001) {
    return 'off';
  }

  return `mixed (${formatNumber(rate * 100, 1)}%)`;
};

const toPredictionSourceLabel = (counts: PredictionSourceCountSummary | undefined): string => {
  if (counts === undefined) {
    return '-';
  }

  return `${counts.heuristicRows} / ${counts.llmRows} / ${counts.unknownRows} / ${counts.totalRows}`;
};

const toLlmShare = (counts: PredictionSourceCountSummary | undefined): number => {
  if (counts === undefined || counts.totalRows === 0) {
    return 0;
  }

  return counts.llmRows / counts.totalRows;
};

const toRuntimeAnchor = (baseline: BaselineAggregateSummary['baseline']): BaselineAggregateSummary['baseline'] | undefined => {
  if (baseline.startsWith('ledgermind_static_materialize')) {
    return 'ledgermind_static_materialize';
  }

  if (baseline.startsWith('ledgermind_agentic_loop')) {
    return 'ledgermind_agentic_loop';
  }

  return undefined;
};

const formatSigned = (value: number, precision = 3): string => {
  return `${value >= 0 ? '+' : ''}${formatNumber(value, precision)}`;
};

const deriveMovementReason = (input: {
  readonly scoreDelta: number;
  readonly evidenceRecallDelta: number;
  readonly llmShareDelta: number;
  readonly retrievalAddedDelta: number;
  readonly fallbackRateDelta: number;
  readonly toolStepDelta: number;
  readonly topSelectionReasons: readonly string[];
}): string => {
  if (Math.abs(input.scoreDelta) < 0.005) {
    return 'No material score movement relative to anchor baseline.';
  }

  const reasons: string[] = [];

  if (input.scoreDelta > 0 && input.evidenceRecallDelta >= 0.02) {
    reasons.push('higher evidence recall');
  }

  if (input.scoreDelta < 0 && input.evidenceRecallDelta <= -0.02) {
    reasons.push('lower evidence recall');
  }

  if (input.scoreDelta < 0 && input.fallbackRateDelta >= 0.05) {
    reasons.push('more fallback truncation');
  }

  if (input.scoreDelta > 0 && input.retrievalAddedDelta >= 0.5) {
    reasons.push('more retrieval additions');
  }

  if (Math.abs(input.llmShareDelta) >= 0.05) {
    reasons.push(input.llmShareDelta > 0 ? 'more llm-sourced answers' : 'fewer llm-sourced answers');
  }

  if (Math.abs(input.toolStepDelta) >= 0.5) {
    reasons.push(input.toolStepDelta > 0 ? 'deeper tool-loop search' : 'shallower tool-loop search');
  }

  if (reasons.length === 0 && input.topSelectionReasons.length > 0) {
    reasons.push(`selection-signal shift (${input.topSelectionReasons.slice(0, 2).join(', ')})`);
  }

  if (reasons.length === 0) {
    reasons.push('mixed movement; inspect trace diagnostics');
  }

  return reasons.join('; ');
};

const renderAblationMatrixTable = (input: {
  readonly summaries: readonly BaselineAggregateSummary[];
  readonly traceByBaseline: ReadonlyMap<string, BaselineTraceAblationSummary>;
}): string => {
  if (input.summaries.length === 0) {
    return '_No baseline summaries captured._';
  }

  const header =
    '| Baseline | Official score | Answer source (h / l / u / total) | Runtime mode | Summarizer | Precompact | Artifacts | Raw-turn injection | Avg retrieval added | Avg tool steps | Top tool selection reasons |';
  const separator = '|---|---:|---|---|---|---|---|---|---:|---:|---|';

  const rows = input.summaries.map((summary) => {
    const provenance = summary.provenance;
    const diagnostics = summary.diagnostics;
    const runtime = provenance?.runtime;
    const traceSummary = input.traceByBaseline.get(summary.baseline);
    const topReasons =
      traceSummary === undefined || traceSummary.topSelectionReasons.length === 0
        ? '-'
        : traceSummary.topSelectionReasons.join(', ');

    return `| ${summary.baseline} | ${formatNumber(summary.aggregate.mean)} ± ${formatNumber(summary.aggregate.std)} | ${toPredictionSourceLabel(provenance?.actualPredictionSourceCounts)} | ${runtime?.runtimeMode ?? '-'} | ${runtime?.summarizerType ?? '-'} | ${toToggleLabel(diagnostics?.preCompactionEnabledRate)} | ${runtime === undefined || runtime === null ? '-' : runtime.artifactsEnabled ? 'on' : 'off'} | ${toToggleLabel(diagnostics?.rawTurnInjectionEnabledRate)} | ${diagnostics === undefined ? '-' : formatNumber(diagnostics.averageRetrievalAddedCount)} | ${traceSummary === undefined ? '-' : formatNumber(traceSummary.avgToolStepsUsed)} | ${topReasons} |`;
  });

  return [header, separator, ...rows].join('\n');
};

const renderScoreMovementDriversTable = (input: {
  readonly summaries: readonly BaselineAggregateSummary[];
  readonly traceByBaseline: ReadonlyMap<string, BaselineTraceAblationSummary>;
}): string => {
  const byBaseline = new Map(input.summaries.map((summary) => [summary.baseline, summary] as const));

  const header =
    '| Baseline | Anchor baseline | Δ score | Δ evidence recall | Δ llm-answer share | Δ retrieval added | Δ fallback rate | Δ avg tool steps | Reason for score movement |';
  const separator = '|---|---|---:|---:|---:|---:|---:|---:|---|';
  const rows: string[] = [];

  for (const summary of input.summaries) {
    const anchorBaseline = toRuntimeAnchor(summary.baseline);
    if (anchorBaseline === undefined || anchorBaseline === summary.baseline) {
      continue;
    }

    const anchor = byBaseline.get(anchorBaseline);
    if (anchor === undefined) {
      continue;
    }

    const scoreDelta = summary.aggregate.mean - anchor.aggregate.mean;
    const evidenceRecallDelta = summary.evidenceRecall.overall.mean - anchor.evidenceRecall.overall.mean;
    const llmShareDelta =
      toLlmShare(summary.provenance?.actualPredictionSourceCounts) -
      toLlmShare(anchor.provenance?.actualPredictionSourceCounts);
    const retrievalAddedDelta =
      (summary.diagnostics?.averageRetrievalAddedCount ?? 0) - (anchor.diagnostics?.averageRetrievalAddedCount ?? 0);
    const fallbackRateDelta = (summary.diagnostics?.fallbackRate ?? 0) - (anchor.diagnostics?.fallbackRate ?? 0);
    const toolStepDelta =
      (input.traceByBaseline.get(summary.baseline)?.avgToolStepsUsed ?? 0) -
      (input.traceByBaseline.get(anchor.baseline)?.avgToolStepsUsed ?? 0);
    const reason = deriveMovementReason({
      scoreDelta,
      evidenceRecallDelta,
      llmShareDelta,
      retrievalAddedDelta,
      fallbackRateDelta,
      toolStepDelta,
      topSelectionReasons: input.traceByBaseline.get(summary.baseline)?.topSelectionReasons ?? [],
    }).replaceAll('|', '/');

    rows.push(
      `| ${summary.baseline} | ${anchor.baseline} | ${formatSigned(scoreDelta)} | ${formatSigned(evidenceRecallDelta)} | ${formatSigned(llmShareDelta)} | ${formatSigned(retrievalAddedDelta)} | ${formatSigned(fallbackRateDelta)} | ${formatSigned(toolStepDelta)} | ${reason} |`,
    );
  }

  if (rows.length === 0) {
    return '_No comparable LedgerMind ablation variants in this run._';
  }

  return [header, separator, ...rows].join('\n');
};

const renderPromotionGatesTable = (gates: readonly PromotionGateResult[] | undefined): string => {
  if (gates === undefined || gates.length === 0) {
    return '_No promotion gates evaluated._';
  }

  const header =
    '| Baseline | Aggregate delta vs runtime LedgerMind baseline | Δ Cat 1 (multi-hop) | Δ Cat 3 (inferential) | Δ Cat 4 (open-domain) | Improved categories (>=0.05) | Aggregate gate (>=0.03) | Category gate (>=2) | Promoted |';
  const separator = '|---|---:|---:|---:|---:|---:|---:|---:|---:|';

  const rows = gates.map((gate) => {
    return `| ${gate.baseline} | ${formatNumber(gate.aggregateDelta)} | ${formatNumber(gate.categoryDeltas[1] ?? 0)} | ${formatNumber(gate.categoryDeltas[3] ?? 0)} | ${formatNumber(gate.categoryDeltas[4] ?? 0)} | ${gate.improvedCategoryCount} | ${gate.meetsAggregateGate ? 'yes' : 'no'} | ${gate.meetsCategoryGate ? 'yes' : 'no'} | ${gate.promoted ? 'yes' : 'no'} |`;
  });

  return [header, separator, ...rows].join('\n');
};

const renderToolLoopEffectivenessTable = (traceRows: readonly LocomoTraceRecord[]): string => {
  const successRows = traceRows.filter((row): row is Extract<LocomoTraceRecord, { status: 'ok' }> => row.status === 'ok');
  if (successRows.length === 0) {
    return '_No successful trace rows available._';
  }

  const withToolLoop = successRows.filter((row) => row.toolLoopDiagnostics?.enabled === true);
  if (withToolLoop.length === 0) {
    return '_No tool-loop rows captured in this run._';
  }

  const total = withToolLoop.length;
  const reachabilityFailures = withToolLoop.filter(
    (row) => row.failureClassification.category === 'reachability_failure',
  ).length;
  const synthesisFailures = withToolLoop.filter(
    (row) => row.failureClassification.category === 'answer_synthesis_failure',
  ).length;
  const unsupportedEvidence = withToolLoop.filter(
    (row) => row.failureClassification.category === 'unsupported_evidence',
  ).length;

  const goldReachable = withToolLoop.filter((row) => row.failureClassification.goldEvidenceReachable).length;
  const anyGoldInContext = withToolLoop.filter((row) => row.evidenceDiagnostics.hasGoldEvidenceInContext).length;
  const allGoldInContext = withToolLoop.filter((row) => row.evidenceDiagnostics.hasAllGoldEvidenceInContext).length;

  const stepCounts = withToolLoop.map((row) => row.toolLoopDiagnostics?.stepsUsed ?? 0);
  const addedTokens = withToolLoop.map((row) => row.toolLoopDiagnostics?.addedTokens ?? 0);

  const header = '| Metric | Value |';
  const separator = '|---|---:|';
  const rows = [
    `| Tool-loop executions | ${total} |`,
    `| Gold evidence became reachable | ${goldReachable}/${total} (${formatNumber((goldReachable / total) * 100, 1)}%) |`,
    `| Any gold evidence in context | ${anyGoldInContext}/${total} (${formatNumber((anyGoldInContext / total) * 100, 1)}%) |`,
    `| All gold evidence in context | ${allGoldInContext}/${total} (${formatNumber((allGoldInContext / total) * 100, 1)}%) |`,
    `| Reachability failures | ${reachabilityFailures}/${total} (${formatNumber((reachabilityFailures / total) * 100, 1)}%) |`,
    `| Answer synthesis failures | ${synthesisFailures}/${total} (${formatNumber((synthesisFailures / total) * 100, 1)}%) |`,
    `| Unsupported evidence | ${unsupportedEvidence}/${total} (${formatNumber((unsupportedEvidence / total) * 100, 1)}%) |`,
    `| Avg tool steps used | ${formatNumber(mean(stepCounts))} |`,
    `| Avg tokens added by tool loop | ${formatNumber(mean(addedTokens))} |`,
  ];

  return [header, separator, ...rows].join('\n');
};

const renderArtifactBearingExamplesTable = (traceRows: readonly LocomoTraceRecord[]): string => {
  const successRows = traceRows.filter((row): row is Extract<LocomoTraceRecord, { status: 'ok' }> => row.status === 'ok');
  if (successRows.length === 0) {
    return '_No successful trace rows available._';
  }

  const artifactRows = successRows.filter((row) => row.contextSelection.artifactBearingExample === true);
  if (artifactRows.length === 0) {
    return '_No artifact-bearing examples captured in this run._';
  }

  const total = artifactRows.length;
  const goldReachable = artifactRows.filter((row) => row.failureClassification.goldEvidenceReachable).length;
  const anyGoldInContext = artifactRows.filter((row) => row.evidenceDiagnostics.hasGoldEvidenceInContext).length;
  const allGoldInContext = artifactRows.filter((row) => row.evidenceDiagnostics.hasAllGoldEvidenceInContext).length;
  const avgArtifactRefs = mean(artifactRows.map((row) => row.contextSelection.artifactReferenceIds.length));

  const header = '| Metric | Value |';
  const separator = '|---|---:|';
  const rows = [
    `| Artifact-bearing executions | ${total} |`,
    `| Gold evidence became reachable | ${goldReachable}/${total} (${formatNumber((goldReachable / total) * 100, 1)}%) |`,
    `| Any gold evidence in context | ${anyGoldInContext}/${total} (${formatNumber((anyGoldInContext / total) * 100, 1)}%) |`,
    `| All gold evidence in context | ${allGoldInContext}/${total} (${formatNumber((allGoldInContext / total) * 100, 1)}%) |`,
    `| Avg artifact refs selected | ${formatNumber(avgArtifactRefs)} |`,
  ];

  return [header, separator, ...rows].join('\n');
};

export const writeSummaryMarkdown = async (input: {
  readonly outputDir: string;
  readonly runSummary: LocomoRunSummary;
  readonly configSnapshot: LocomoConfigSnapshot;
}): Promise<string> => {
  const pathName = path.resolve(input.outputDir, 'summary.md');
  const requestedPredictionMode =
    input.runSummary.executionProvenance?.requestedPredictionMode ?? input.configSnapshot.prediction?.mode ?? 'unknown';
  const runtimeMode = input.configSnapshot.runtime?.mode ?? 'unknown';
  const summarizerType = input.configSnapshot.runtime?.summarizerType ?? 'unknown';
  const artifactsEnabled = input.configSnapshot.runtime?.artifactsEnabled;

  const tracePath = path.resolve(input.outputDir, 'trace_per_example.jsonl');
  const traceRows = await readFile(tracePath, 'utf8')
    .then((content) =>
      content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LocomoTraceRecord),
    )
    .catch(() => [] as LocomoTraceRecord[]);

  const traceByBaseline = summarizeTraceAblationByBaseline(traceRows);

  const markdown = [
    '# LOCOMO Benchmark Summary',
    '',
    `- run_id: ${input.runSummary.runId}`,
    `- started_at: ${input.runSummary.startedAt}`,
    `- ended_at: ${input.runSummary.endedAt}`,
    `- fairness_fingerprint: ${input.runSummary.fairnessFingerprint}`,
    `- requested_prediction_mode: ${requestedPredictionMode}`,
    `- runtime_mode: ${runtimeMode}`,
    `- summarizer_type: ${summarizerType}`,
    `- artifacts_enabled: ${artifactsEnabled === undefined ? 'unknown' : artifactsEnabled ? 'yes' : 'no'}`,
    '',
    '## Aggregate Results (3-seed mean ± std)',
    '',
    renderSummaryTable(input.runSummary.baselines),
    '',
    '## Category Results (including adversarial)',
    '',
    renderCategoryTable(input.runSummary.baselines),
    '',
    '## Ledgermind Diagnostics',
    '',
    renderDiagnosticsTable(input.runSummary.baselines),
    '',
    '## Ablation Matrix',
    '',
    renderAblationMatrixTable({
      summaries: input.runSummary.baselines,
      traceByBaseline,
    }),
    '',
    '## Score Movement Drivers',
    '',
    renderScoreMovementDriversTable({
      summaries: input.runSummary.baselines,
      traceByBaseline,
    }),
    '',
    '## Execution Provenance',
    '',
    renderExecutionProvenanceTable({
      runSummary: input.runSummary,
      fallbackRequestedPredictionMode: input.configSnapshot.prediction?.mode,
    }),
    '',
    '## Notes',
    '',
    '- `full_context` and `oracle_full_conversation_llm` are labeled as upper-bound when they exceed parity budget.',
    '- `oracle_evidence` and `oracle_full_conversation_llm` are harness-validity baselines (gold-evidence and full-conversation controls), not product/leaderboard baselines.',
    '- Official scorer integration is used when available; fallback scoring uses official-style category logic.',
    '',
    '## Promotion Gates (phase 3 smoke)',
    '',
    renderPromotionGatesTable(input.runSummary.promotionGates),
    '',
    '## Tool-loop effectiveness and failure classification',
    '',
    renderToolLoopEffectivenessTable(traceRows),
    '',
    '## Artifact-bearing examples',
    '',
    renderArtifactBearingExamplesTable(traceRows),
    '',
    '## Config Snapshot (inline)',
    '',
    '```json',
    JSON.stringify(input.configSnapshot, null, 2),
    '```',
    '',
  ].join('\n');

  await writeFile(pathName, markdown, 'utf8');
  return pathName;
};

export const canonicalSnapshotJson = (snapshot: Readonly<Record<string, unknown>>): string => {
  return stableJson(snapshot);
};
