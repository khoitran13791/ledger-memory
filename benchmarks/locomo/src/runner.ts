import { performance } from 'node:perf_hooks';

import type {
  BaselineAggregateSummary,
  BaselineStrategy,
  LocomoConfigSnapshot,
  LocomoConversationSample,
  LocomoExample,
  LocomoExecutionProvenance,
  LocomoFailureCategory,
  LocomoPredictionSource,
  LocomoRunSummary,
  LocomoTraceErrorRecord,
  LocomoTraceRecord,
  LocomoTraceSuccessRecord,
  PerExampleRecord,
  RunExecutionProvenanceSummary,
  RunExecutionProvenanceBaselineSummary,
  PromotionGateResult,
  SeedScoreSummary,
  LocomoEvidenceInContextMetrics,
} from './types.js';
import type { LocomoBenchmarkConfig } from './config.js';
import { createBaselineStrategies } from './baselines.js';
import { scoreAnswerOfficialStyle, scoreSeedWithOfficialScorer } from './scorer.js';
import {
  aggregateBaselineSummary,
  canonicalSnapshotJson,
  createTraceWriter,
  ensureOutputDir,
  writeConfigSnapshot,
  writePerExampleJsonl,
  writeSummaryMarkdown,
} from './report.js';
import { sha256Hex } from './utils.js';

const PROMOTION_GATE_AGGREGATE_DELTA = 0.03;
const PROMOTION_GATE_CATEGORY_DELTA = 0.05;
const PROMOTION_GATE_MIN_IMPROVED_CATEGORIES = 2;
const PROMOTION_GATE_CATEGORY_SET = [1, 3, 4] as const;
const PHASE3_DIAGNOSTIC_BASELINES_BY_RUNTIME = {
  static_materialize: [
    'ledgermind_static_materialize_no_precompaction',
    'ledgermind_static_materialize_raw_turn_injection',
    'ledgermind_static_materialize_no_precompaction_raw_turn_injection',
  ],
  agentic_loop: [
    'ledgermind_agentic_loop_no_precompaction',
    'ledgermind_agentic_loop_raw_turn_injection',
    'ledgermind_agentic_loop_no_precompaction_raw_turn_injection',
  ],
} as const satisfies Readonly<
  Record<LocomoBenchmarkConfig['runtimeMode'], readonly BaselineAggregateSummary['baseline'][]>
>;

const toExecutionProvenance = (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly execution: Awaited<ReturnType<BaselineStrategy['run']>>;
}): LocomoExecutionProvenance => {
  const actualPredictionSource =
    input.execution.provenance?.actualPredictionSource ??
    (input.execution.predictionSource as LocomoPredictionSource | undefined);

  return {
    requestedPredictionMode: input.execution.provenance?.requestedPredictionMode ?? input.config.predictionMode,
    ...(actualPredictionSource === undefined ? {} : { actualPredictionSource }),
    ...(input.execution.provenance?.runtime === undefined ? {} : { runtime: input.execution.provenance.runtime }),
  };
};

const toTraceAnswerSource = (input: {
  readonly execution: Awaited<ReturnType<BaselineStrategy['run']>>;
  readonly provenance: LocomoExecutionProvenance;
}): LocomoTraceRecord['answerSource'] => {
  return input.provenance.actualPredictionSource ?? input.execution.predictionSource ?? 'unknown';
};

const toTraceContextSelection = (
  execution: Awaited<ReturnType<BaselineStrategy['run']>>,
): LocomoTraceRecord['contextSelection'] => {
  const summaryReferenceIds = execution.diagnostics?.summaryReferenceIds ?? [];
  const artifactReferenceIds = execution.diagnostics?.artifactReferenceIds ?? [];
  const artifactBearingExample = execution.diagnostics?.artifactBearingExample;

  return {
    contextIds: execution.contextResult.contextIds,
    summaryReferenceIds,
    artifactReferenceIds,
    ...(artifactBearingExample === undefined ? {} : { artifactBearingExample }),
  };
};

const toTraceRetrievalDiagnostics = (
  execution: Awaited<ReturnType<BaselineStrategy['run']>>,
): LocomoTraceRecord['retrievalDiagnostics'] => {
  const query = execution.retrievalQuery;
  const hintCount = execution.diagnostics?.retrievalHintCount;
  const matchCount = execution.diagnostics?.retrievalMatchCount;
  const addedCount = execution.diagnostics?.retrievalAddedCount;
  const hints = execution.diagnostics?.retrievalHints;
  const reservedForToolLoopTokens = execution.diagnostics?.reservedForToolLoopTokens;
  const reservedForRetrievalTokens = execution.diagnostics?.reservedForRetrievalTokens;

  if (
    query === undefined &&
    hintCount === undefined &&
    matchCount === undefined &&
    addedCount === undefined &&
    hints === undefined &&
    reservedForToolLoopTokens === undefined &&
    reservedForRetrievalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(query === undefined ? {} : { query }),
    ...(hintCount === undefined ? {} : { hintCount }),
    ...(matchCount === undefined ? {} : { matchCount }),
    ...(addedCount === undefined ? {} : { addedCount }),
    ...(hints === undefined ? {} : { hints }),
    ...(reservedForToolLoopTokens === undefined ? {} : { reservedForToolLoopTokens }),
    ...(reservedForRetrievalTokens === undefined ? {} : { reservedForRetrievalTokens }),
  };
};

const toTraceToolLoopDiagnostics = (
  execution: Awaited<ReturnType<BaselineStrategy['run']>>,
): LocomoTraceRecord['toolLoopDiagnostics'] => {
  const toolLoop = execution.diagnostics?.toolLoop;
  if (toolLoop === undefined) {
    return undefined;
  }

  return {
    enabled: toolLoop.enabled,
    maxSteps: toolLoop.maxSteps,
    maxDescribeCalls: toolLoop.maxDescribeCalls,
    maxExploreArtifactCalls: toolLoop.maxExploreArtifactCalls,
    maxExpandCalls: toolLoop.maxExpandCalls,
    maxGrepCalls: toolLoop.maxGrepCalls,
    maxAddedTokens: toolLoop.maxAddedTokens,
    stepsUsed: toolLoop.stepsUsed,
    describedIds: toolLoop.describedIds,
    exploredArtifactIds: toolLoop.exploredArtifactIds,
    expandedSummaryIds: toolLoop.expandedSummaryIds,
    grepQueries: toolLoop.grepQueries,
    addedMessageCount: toolLoop.addedMessageCount,
    addedTokens: toolLoop.addedTokens,
    preToolEvidenceIds: toolLoop.preToolEvidenceIds,
    postToolEvidenceIds: toolLoop.postToolEvidenceIds,
    ...(toolLoop.describeSignals === undefined ? {} : { describeSignals: toolLoop.describeSignals }),
    ...(toolLoop.expandSelection === undefined ? {} : { expandSelection: toolLoop.expandSelection }),
    ...(toolLoop.artifactSelection === undefined ? {} : { artifactSelection: toolLoop.artifactSelection }),
    ...(toolLoop.grepSelection === undefined ? {} : { grepSelection: toolLoop.grepSelection }),
    steps: toolLoop.steps,
  };
};

const toTraceSummarizationTrace = (
  execution: Awaited<ReturnType<BaselineStrategy['run']>>,
): LocomoTraceRecord['summarizationTrace'] => {
  const entries = execution.diagnostics?.summarizationTrace;
  if (entries === undefined || entries.length === 0) {
    return undefined;
  }

  return entries;
};

const toTraceMaterializationDiagnostics = (
  execution: Awaited<ReturnType<BaselineStrategy['run']>>,
): LocomoTraceRecord['materializationDiagnostics'] => {
  const diagnostics = execution.diagnostics;
  if (diagnostics === undefined) {
    return undefined;
  }

  return {
    attempted: diagnostics.materializationAttempted,
    ...(diagnostics.contextSource === undefined ? {} : { contextSource: diagnostics.contextSource }),
    ...(diagnostics.materializationErrorStage === undefined
      ? {}
      : { errorStage: diagnostics.materializationErrorStage }),
    ...(diagnostics.materializationErrorCode === undefined ? {} : { errorCode: diagnostics.materializationErrorCode }),
  };
};

const classifyFailure = (input: {
  readonly example: LocomoExample;
  readonly execution: Awaited<ReturnType<BaselineStrategy['run']>>;
  readonly evidenceInContext: LocomoEvidenceInContextMetrics;
}): LocomoTraceRecord['failureClassification'] => {
  const rawEvidenceTokens = input.example.evidence
    .flatMap((value) => value.split(/[;\s]+/))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const unsupportedEvidenceIds = rawEvidenceTokens.filter((token) => {
    if (/^D\d+:\d+$/i.test(token)) {
      return false;
    }

    return token.includes(':');
  });

  if (unsupportedEvidenceIds.length > 0) {
    return {
      category: 'unsupported_evidence',
      reason: 'Gold evidence contains identifiers outside supported D#:## format.',
      goldEvidenceReachable: false,
      hasGoldEvidenceInContext: input.evidenceInContext.hasGoldEvidenceInContext,
      hasAllGoldEvidenceInContext: input.evidenceInContext.hasAllGoldEvidenceInContext,
      unsupportedEvidenceIds,
    };
  }

  const postToolEvidenceIds = input.execution.diagnostics?.toolLoop?.postToolEvidenceIds ?? [];
  const goldEvidenceReachable =
    input.evidenceInContext.hasGoldEvidenceInContext ||
    input.evidenceInContext.goldEvidenceIds.some((id) => postToolEvidenceIds.includes(id));

  if (!goldEvidenceReachable) {
    return {
      category: 'reachability_failure',
      reason: 'Gold evidence did not become reachable after retrieval/materialization/tool loop.',
      goldEvidenceReachable,
      hasGoldEvidenceInContext: input.evidenceInContext.hasGoldEvidenceInContext,
      hasAllGoldEvidenceInContext: input.evidenceInContext.hasAllGoldEvidenceInContext,
    };
  }

  const officialScore = scoreAnswerOfficialStyle({
    category: input.example.category,
    prediction: input.execution.prediction,
    answer: input.example.answer,
  });

  if (officialScore < 1) {
    return {
      category: 'answer_synthesis_failure',
      reason: 'Gold evidence was reachable, but final answer did not match reference answer.',
      goldEvidenceReachable,
      hasGoldEvidenceInContext: input.evidenceInContext.hasGoldEvidenceInContext,
      hasAllGoldEvidenceInContext: input.evidenceInContext.hasAllGoldEvidenceInContext,
    };
  }

  return {
    category: 'none',
    reason: 'Answer aligned with reference and evidence was reachable.',
    goldEvidenceReachable,
    hasGoldEvidenceInContext: input.evidenceInContext.hasGoldEvidenceInContext,
    hasAllGoldEvidenceInContext: input.evidenceInContext.hasAllGoldEvidenceInContext,
  };
};

const EVIDENCE_ID_REGEX = /D\d+:\d+/gi;

const toUnique = (values: readonly string[]): readonly string[] => {
  return [...new Set(values)];
};

const extractGoldEvidenceIds = (evidence: readonly string[]): readonly string[] => {
  const ids = evidence.flatMap((evidenceField) => {
    return [...evidenceField.matchAll(EVIDENCE_ID_REGEX)]
      .map((match) => match[0]?.trim().toUpperCase())
      .filter((id): id is string => id !== undefined && id.length > 0);
  });

  return toUnique(ids);
};

const toEvidenceInContextMetrics = (input: {
  readonly goldEvidence: readonly string[];
  readonly contextIds: readonly string[];
  readonly contextText: string;
}): LocomoEvidenceInContextMetrics => {
  const goldEvidenceIds = extractGoldEvidenceIds(input.goldEvidence);
  const normalizedContextIds = new Set(input.contextIds.map((id) => id.trim().toUpperCase()));
  const normalizedContextText = input.contextText.toUpperCase();

  const matchedEvidenceIds = toUnique(
    goldEvidenceIds.filter((id) => normalizedContextIds.has(id) || normalizedContextText.includes(id)),
  );
  const missingEvidenceIds = toUnique(goldEvidenceIds.filter((id) => !matchedEvidenceIds.includes(id)));
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

const rowForExecution = (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly baseline: BaselineStrategy;
  readonly seed: number;
  readonly sample: LocomoConversationSample;
  readonly example: LocomoExample;
  readonly execution: Awaited<ReturnType<BaselineStrategy['run']>>;
  readonly latencyMs: number;
  readonly executionIndex: number;
  readonly totalExecutionsPlanned: number;
}): { readonly row: PerExampleRecord; readonly trace: LocomoTraceSuccessRecord } => {
  const predictionKey = `locomo_${input.baseline.name}_seed_${input.seed}_prediction`;
  const officialScore = scoreAnswerOfficialStyle({
    category: input.example.category,
    prediction: input.execution.prediction,
    answer: input.example.answer,
  });
  const provenance = toExecutionProvenance({
    config: input.config,
    execution: input.execution,
  });

  const evidenceInContext = toEvidenceInContextMetrics({
    goldEvidence: input.example.evidence,
    contextIds: input.execution.contextResult.contextIds,
    contextText: input.execution.contextResult.context,
  });

  const artifactBearingExample = input.execution.diagnostics?.artifactBearingExample;

  const row: PerExampleRecord = {
    runId: input.config.runId,
    baseline: input.baseline.name,
    parityMode: input.execution.contextResult.parityMode,
    seed: input.seed,
    sampleId: input.sample.sample_id,
    qaIndex: input.example.qaIndex,
    category: input.example.category,
    question: input.example.question,
    answer: input.example.answer,
    evidence: input.example.evidence,
    prediction: input.execution.prediction,
    predictionKey,
    ...(input.execution.predictionSource === undefined
      ? {}
      : { predictionSource: input.execution.predictionSource }),
    ...(input.execution.abstentionRetried === undefined
      ? {}
      : { abstentionRetried: input.execution.abstentionRetried }),
    officialScore,
    latencyMs: input.latencyMs,
    promptTokens: input.execution.promptTokens,
    completionTokens: input.execution.completionTokens,
    totalTokens: input.execution.totalTokens,
    contextTokenEstimate: input.execution.contextResult.contextTokenEstimate,
    contextIds: input.execution.contextResult.contextIds,
    ...(artifactBearingExample === undefined ? {} : { artifactBearingExample }),
    evidenceInContext,
    costUsd: input.execution.costUsd,
    fairnessFingerprint: input.config.fairnessFingerprint,
    ...(input.execution.diagnostics === undefined ? {} : { diagnostics: input.execution.diagnostics }),
    provenance,
    status: 'ok',
  };

  const retrievalDiagnostics = toTraceRetrievalDiagnostics(input.execution);
  const materializationDiagnostics = toTraceMaterializationDiagnostics(input.execution);
  const toolLoopDiagnostics = toTraceToolLoopDiagnostics(input.execution);
  const summarizationTrace = toTraceSummarizationTrace(input.execution);
  const failureClassification = classifyFailure({
    example: input.example,
    execution: input.execution,
    evidenceInContext,
  });

  const trace: LocomoTraceSuccessRecord = {
    traceSchemaVersion: 'locomo_trace_v2',
    runId: input.config.runId,
    executionIndex: input.executionIndex,
    totalExecutionsPlanned: input.totalExecutionsPlanned,
    baseline: input.baseline.name,
    parityMode: input.execution.contextResult.parityMode,
    seed: input.seed,
    sampleId: input.sample.sample_id,
    qaIndex: input.example.qaIndex,
    exampleId: `${input.sample.sample_id}::${input.example.qaIndex}`,
    category: input.example.category,
    question: input.example.question,
    answer: input.example.answer,
    status: 'ok',
    finalAnswer: input.execution.prediction,
    answerSource: toTraceAnswerSource({ execution: input.execution, provenance }),
    latencyMs: input.latencyMs,
    tokens: {
      promptTokens: input.execution.promptTokens,
      completionTokens: input.execution.completionTokens,
      totalTokens: input.execution.totalTokens,
      contextTokens: input.execution.contextResult.contextTokenEstimate,
    },
    contextSelection: toTraceContextSelection(input.execution),
    evidenceDiagnostics: evidenceInContext,
    ...(retrievalDiagnostics === undefined ? {} : { retrievalDiagnostics }),
    ...(materializationDiagnostics === undefined ? {} : { materializationDiagnostics }),
    ...(toolLoopDiagnostics === undefined ? {} : { toolLoopDiagnostics }),
    ...(summarizationTrace === undefined ? {} : { summarizationTrace }),
    failureClassification,
    provenance,
  };

  return {
    row,
    trace,
  };
};

const buildConfigSnapshot = (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly datasetHash: string;
  readonly datasetSampleCount: number;
  readonly selectedExampleCount: number;
}): LocomoConfigSnapshot => {
  return {
    runId: input.config.runId,
    generatedAt: new Date().toISOString(),
    dataset: {
      path: input.config.datasetPath,
      sha256: input.datasetHash,
      sampleCount: input.datasetSampleCount,
      selectedExampleCount: input.selectedExampleCount,
      smoke: input.config.smoke,
      canary: input.config.canary,
    },
    scorer: {
      path: input.config.scorerPath,
      version: input.config.scorerVersion,
    },
    fairness: {
      modelName: input.config.fairness.modelName,
      promptTemplate: input.config.fairness.promptTemplate,
      promptHash: input.config.promptHash,
      temperature: input.config.fairness.temperature,
      topP: input.config.fairness.topP,
      tokenBudget: input.config.fairness.tokenBudget,
      overheadTokens: input.config.fairness.overheadTokens,
      maxAnswerTokens: input.config.fairness.maxAnswerTokens,
    },
    prediction: {
      mode: input.config.predictionMode,
      seedMode: input.config.seedMode,
      ...(input.config.llmBaseUrl === undefined ? {} : { llmBaseUrl: input.config.llmBaseUrl }),
      llmTimeoutMs: input.config.llmTimeoutMs,
    },
    ...(input.config.maxExamples === undefined ? {} : { maxExamples: input.config.maxExamples }),
    baselines: input.config.baselines,
    seeds: input.config.seeds,
    retrieval: {
      ragTopK: input.config.ragTopK,
      ledgermindHintLimit: input.config.retrievedSummaryLimit,
      ledgermindRawTurnInjectionTopK: input.config.ledgermindRawTurnInjectionTopK,
      ledgermindRawTurnInjectionMaxTokens: input.config.ledgermindRawTurnInjectionMaxTokens,
      ledgermindToolLoopMaxSteps: input.config.ledgermindToolLoopMaxSteps,
      ledgermindToolLoopMaxDescribeCalls: input.config.ledgermindToolLoopMaxDescribeCalls,
      ledgermindToolLoopMaxExploreArtifactCalls: input.config.ledgermindToolLoopMaxExploreArtifactCalls,
      ledgermindToolLoopMaxExpandCalls: input.config.ledgermindToolLoopMaxExpandCalls,
      ledgermindToolLoopMaxGrepCalls: input.config.ledgermindToolLoopMaxGrepCalls,
      ledgermindToolLoopMaxAddedTokens: input.config.ledgermindToolLoopMaxAddedTokens,
    },
    runtime: {
      mode: input.config.runtimeMode,
      summarizerType: input.config.summarizerType,
      artifactsEnabled: input.config.artifactsEnabled,
    },
    fairnessFingerprintInputs: input.config.fairnessFingerprintInputs,
    includeLedgermindDiagnostics: input.config.includeLedgermindDiagnostics,
    fairnessFingerprint: input.config.fairnessFingerprint,
  };
};

const groupRowsByBaseline = (rows: readonly PerExampleRecord[]): ReadonlyMap<string, readonly PerExampleRecord[]> => {
  const map = new Map<string, PerExampleRecord[]>();
  for (const row of rows) {
    const bucket = map.get(row.baseline) ?? [];
    bucket.push(row);
    map.set(row.baseline, bucket);
  }

  return map;
};

const groupRowsBySeed = (rows: readonly PerExampleRecord[]): ReadonlyMap<number, readonly PerExampleRecord[]> => {
  const map = new Map<number, PerExampleRecord[]>();
  for (const row of rows) {
    const bucket = map.get(row.seed) ?? [];
    bucket.push(row);
    map.set(row.seed, bucket);
  }
  return map;
};

const summarizeBaselines = async (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly allSamples: readonly LocomoConversationSample[];
  readonly examples: readonly LocomoExample[];
  readonly allRows: readonly PerExampleRecord[];
}): Promise<readonly BaselineAggregateSummary[]> => {
  const baselineRows = groupRowsByBaseline(input.allRows);
  const summaries: BaselineAggregateSummary[] = [];

  for (const baselineName of input.config.baselines) {
    const rows = baselineRows.get(baselineName) ?? [];
    const rowsBySeed = groupRowsBySeed(rows);
    const seedScores: SeedScoreSummary[] = [];

    for (const seed of input.config.seeds) {
      const seedRows = rowsBySeed.get(seed) ?? [];
      if (seedRows.length === 0) {
        continue;
      }

      const official = await scoreSeedWithOfficialScorer({
        scorerPath: input.config.scorerPath,
        outputDir: input.config.outputDir,
        baseline: baselineName,
        seed,
        allSamples: input.allSamples,
        examples: input.examples,
        rows: seedRows,
      });

      seedScores.push({
        seed,
        aggregate: official.official.aggregate,
        categoryScores: official.official.categoryScores,
        countByCategory: official.official.countByCategory,
      });
    }

    const parityMode =
      rows.some((row) => row.parityMode === 'upper_bound') ||
      baselineName === 'full_context' ||
      baselineName === 'oracle_full_conversation_llm'
        ? 'upper_bound'
        : 'parity';

    summaries.push(
      aggregateBaselineSummary({
        baseline: baselineName,
        parityMode,
        rows,
        seedScores,
      }),
    );
  }

  return summaries;
};

const buildExecutionProvenanceSummary = (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly summaries: readonly BaselineAggregateSummary[];
}): RunExecutionProvenanceSummary => {
  return {
    requestedPredictionMode: input.config.predictionMode,
    baselines: input.config.baselines.map((baselineName) => {
      const summary = input.summaries.find((item) => item.baseline === baselineName);
      const fallbackProvenance = {
        actualPredictionSourceCounts: {
          totalRows: 0,
          heuristicRows: 0,
          llmRows: 0,
          unknownRows: 0,
        },
        runtime: null,
      };

      return {
        baseline: baselineName,
        ...(summary?.provenance ?? fallbackProvenance),
      } satisfies RunExecutionProvenanceBaselineSummary;
    }),
  };
};

const toTraceError = (error: unknown): LocomoTraceErrorRecord['error'] => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...((error as { readonly code?: string }).code === undefined
        ? {}
        : { code: (error as { readonly code?: string }).code }),
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
};

const toErrorTraceRecord = (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly baseline: BaselineStrategy;
  readonly seed: number;
  readonly example: LocomoExample;
  readonly executionIndex: number;
  readonly totalExecutionsPlanned: number;
  readonly latencyMs: number;
  readonly error: unknown;
}): LocomoTraceErrorRecord => {
  const goldEvidenceIds = extractGoldEvidenceIds(input.example.evidence);

  const failureCategory: LocomoFailureCategory =
    goldEvidenceIds.length === 0 ? 'answer_synthesis_failure' : 'reachability_failure';

  return {
    traceSchemaVersion: 'locomo_trace_v2',
    runId: input.config.runId,
    executionIndex: input.executionIndex,
    totalExecutionsPlanned: input.totalExecutionsPlanned,
    baseline: input.baseline.name,
    parityMode: input.baseline.parityMode,
    seed: input.seed,
    sampleId: input.example.sampleId,
    qaIndex: input.example.qaIndex,
    exampleId: `${input.example.sampleId}::${input.example.qaIndex}`,
    category: input.example.category,
    question: input.example.question,
    answer: input.example.answer,
    answerSource: 'unknown',
    status: 'error',
    latencyMs: input.latencyMs,
    error: toTraceError(input.error),
    contextSelection: {
      contextIds: [],
      summaryReferenceIds: [],
      artifactReferenceIds: [],
    },
    evidenceDiagnostics: {
      goldEvidenceIds,
      matchedEvidenceIds: [],
      missingEvidenceIds: goldEvidenceIds,
      recall: goldEvidenceIds.length === 0 ? 1 : 0,
      hasGoldEvidenceInContext: false,
      hasAllGoldEvidenceInContext: goldEvidenceIds.length === 0,
    },
    failureClassification: {
      category: failureCategory,
      reason: 'Execution failed before answer synthesis completed.',
      goldEvidenceReachable: false,
      hasGoldEvidenceInContext: false,
      hasAllGoldEvidenceInContext: goldEvidenceIds.length === 0,
    },
    provenance: {
      requestedPredictionMode: input.config.predictionMode,
    },
  };
};

const evaluatePromotionGates = (input: {
  readonly runtimeMode: LocomoBenchmarkConfig['runtimeMode'];
  readonly summaries: readonly BaselineAggregateSummary[];
}): readonly PromotionGateResult[] => {
  const baseBaselineName =
    input.runtimeMode === 'agentic_loop' ? 'ledgermind_agentic_loop' : 'ledgermind_static_materialize';
  const base = input.summaries.find((summary) => summary.baseline === baseBaselineName);
  if (base === undefined) {
    return Object.freeze([]);
  }

  const gates = PHASE3_DIAGNOSTIC_BASELINES_BY_RUNTIME[input.runtimeMode].flatMap((baselineName) => {
    const variant = input.summaries.find((summary) => summary.baseline === baselineName);
    if (variant === undefined) {
      return [];
    }

    const categoryDeltas: Record<number, number> = {};
    for (const category of PROMOTION_GATE_CATEGORY_SET) {
      const variantCategory = variant.categoryScores[category]?.mean ?? 0;
      const baseCategory = base.categoryScores[category]?.mean ?? 0;
      categoryDeltas[category] = variantCategory - baseCategory;
    }

    const improvedCategoryCount = PROMOTION_GATE_CATEGORY_SET.filter(
      (category) => (categoryDeltas[category] ?? 0) >= PROMOTION_GATE_CATEGORY_DELTA,
    ).length;
    const aggregateDelta = variant.aggregate.mean - base.aggregate.mean;
    const meetsAggregateGate = aggregateDelta >= PROMOTION_GATE_AGGREGATE_DELTA;
    const meetsCategoryGate = improvedCategoryCount >= PROMOTION_GATE_MIN_IMPROVED_CATEGORIES;

    return [
      {
        baseline: baselineName,
        aggregateDelta,
        categoryDeltas,
        improvedCategoryCount,
        meetsAggregateGate,
        meetsCategoryGate,
        promoted: meetsAggregateGate || meetsCategoryGate,
      },
    ];
  });

  return Object.freeze(gates);
};

export const runLocomoBenchmark = async (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly samples: readonly LocomoConversationSample[];
  readonly examples: readonly LocomoExample[];
}): Promise<{
  readonly runSummary: LocomoRunSummary;
  readonly configSnapshotPath: string;
  readonly perExamplePath: string;
  readonly tracePerExamplePath: string;
  readonly summaryPath: string;
}> => {
  const startedAt = new Date().toISOString();

  await ensureOutputDir(input.config.outputDir);

  const datasetHash = sha256Hex(canonicalSnapshotJson({ samples: input.samples }));
  const configSnapshot = buildConfigSnapshot({
    config: input.config,
    datasetHash,
    datasetSampleCount: input.samples.length,
    selectedExampleCount: input.examples.length,
  });

  const baselineRegistry = createBaselineStrategies(input.config);
  const sampleById = new Map(input.samples.map((sample) => [sample.sample_id, sample] as const));

  const traceWriter = await createTraceWriter(input.config.outputDir);
  const rows: PerExampleRecord[] = [];
  const totalExecutions = input.config.baselines.length * input.config.seeds.length * input.examples.length;
  let completedExecutions = 0;

  process.stdout.write(`[locomo] running ${totalExecutions} executions\n`);

  for (const baselineName of input.config.baselines) {
    const strategy = baselineRegistry[baselineName];

    for (const seed of input.config.seeds) {
      for (const example of input.examples) {
        const executionIndex = completedExecutions + 1;
        const start = performance.now();

        try {
          const sample = sampleById.get(example.sampleId);
          if (sample === undefined) {
            throw new Error(`Sample ${example.sampleId} missing from loaded dataset.`);
          }

          const execution = await strategy.run({
            sample,
            example,
            fairness: input.config.fairness,
            seed,
          });
          const latencyMs = performance.now() - start;

          const executionRow = rowForExecution({
            config: input.config,
            baseline: strategy,
            seed,
            sample,
            example,
            execution,
            latencyMs,
            executionIndex,
            totalExecutionsPlanned: totalExecutions,
          });

          rows.push(executionRow.row);
          await traceWriter.writeTraceRow(executionRow.trace);
        } catch (error) {
          const latencyMs = performance.now() - start;
          await traceWriter.writeTraceRow(
            toErrorTraceRecord({
              config: input.config,
              baseline: strategy,
              seed,
              example,
              executionIndex,
              totalExecutionsPlanned: totalExecutions,
              latencyMs,
              error,
            }),
          );
          throw error;
        }

        completedExecutions += 1;
        process.stdout.write(
          `[locomo] progress ${completedExecutions}/${totalExecutions} (${baselineName}, seed ${seed})\n`,
        );
      }
    }
  }

  const summaries = await summarizeBaselines({
    config: input.config,
    allSamples: input.samples,
    examples: input.examples,
    allRows: rows,
  });

  const promotionGates = evaluatePromotionGates({
    runtimeMode: input.config.runtimeMode,
    summaries,
  });
  const executionProvenance = buildExecutionProvenanceSummary({
    config: input.config,
    summaries,
  });
  const endedAt = new Date().toISOString();

  const runSummary: LocomoRunSummary = {
    runId: input.config.runId,
    startedAt,
    endedAt,
    baselines: summaries,
    fairnessFingerprint: input.config.fairnessFingerprint,
    executionProvenance,
    ...(promotionGates.length === 0 ? {} : { promotionGates }),
  };

  const configSnapshotPath = await writeConfigSnapshot({
    outputDir: input.config.outputDir,
    snapshot: {
      ...configSnapshot,
      executionProvenance,
    },
  });

  const perExamplePath = await writePerExampleJsonl({
    outputDir: input.config.outputDir,
    rows,
  });

  const summaryPath = await writeSummaryMarkdown({
    outputDir: input.config.outputDir,
    runSummary,
    configSnapshot: {
      ...configSnapshot,
      executionProvenance,
    },
  });

  return {
    runSummary,
    configSnapshotPath,
    perExamplePath,
    tracePerExamplePath: traceWriter.tracePath,
    summaryPath,
  };
};
