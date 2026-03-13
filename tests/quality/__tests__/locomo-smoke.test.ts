import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBenchmarkConfig,
  loadLocomoDataset,
  runLocomoBenchmark,
  selectExamples,
  type BaselineAggregateSummary,
  type PromotionGateResult,
  type RunExecutionProvenanceBaselineSummary,
} from '@ledgermind/benchmark-locomo';

const PROMOTION_GATE_AGGREGATE_DELTA = 0.03;
const PROMOTION_GATE_CATEGORY_DELTA = 0.05;
const PROMOTION_GATE_MIN_IMPROVED_CATEGORIES = 2;
const PROMOTION_GATE_CATEGORY_SET = [1, 3, 4] as const;

describe('LOCOMO smoke harness', () => {
  const findSummary = (input: {
    readonly summaries: readonly BaselineAggregateSummary[];
    readonly baselineName: string;
  }): BaselineAggregateSummary => {
    const summary = input.summaries.find((row) => row.baseline === input.baselineName);
    if (summary === undefined) {
      throw new Error(`Missing baseline summary for ${input.baselineName}`);
    }
    return summary;
  };

  const findProvenanceBaseline = (input: {
    readonly baselines: readonly RunExecutionProvenanceBaselineSummary[];
    readonly baselineName: string;
  }): RunExecutionProvenanceBaselineSummary => {
    const baseline = input.baselines.find((row) => row.baseline === input.baselineName);
    if (baseline === undefined) {
      throw new Error(`Missing execution provenance for ${input.baselineName}`);
    }
    return baseline;
  };

  const findPromotionGate = (input: {
    readonly gates: readonly PromotionGateResult[];
    readonly baselineName: string;
  }): PromotionGateResult => {
    const gate = input.gates.find((row) => row.baseline === input.baselineName);
    if (gate === undefined) {
      throw new Error(`Missing promotion gate for ${input.baselineName}`);
    }
    return gate;
  };

  it('writes reproducible benchmark artifacts for smoke subset', async () => {
    const outDir = path.resolve(process.cwd(), '.tmp/locomo-smoke-test-output');
    const datasetPath = 'benchmarks/locomo/data/locomo10.json';

    const config = buildBenchmarkConfig([
      '--smoke',
      '--out-dir',
      outDir,
      '--dataset',
      datasetPath,
      '--include-ledgermind-diagnostics',
      '--seeds',
      '0',
    ]);
    const samples = await loadLocomoDataset(config.datasetPath);
    const examples = await selectExamples({ config, samples });

    const result = await runLocomoBenchmark({
      config,
      samples,
      examples,
    });

    expect(result.configSnapshotPath.endsWith('config_snapshot.json')).toBe(true);
    expect(result.perExamplePath.endsWith('per_example.jsonl')).toBe(true);
    expect(result.tracePerExamplePath.endsWith('trace_per_example.jsonl')).toBe(true);
    expect(result.summaryPath.endsWith('summary.md')).toBe(true);

    const expectedBaselines = [
      'ledgermind_static_materialize',
      'truncation',
      'rag',
      'full_context',
      'ledgermind_static_materialize_no_precompaction',
      'ledgermind_static_materialize_raw_turn_injection',
      'ledgermind_static_materialize_no_precompaction_raw_turn_injection',
    ] as const;
    expect(result.runSummary.baselines).toHaveLength(expectedBaselines.length);
    expect(result.runSummary.baselines.map((baseline) => baseline.baseline)).toEqual(expectedBaselines);

    const ledgermind = findSummary({
      summaries: result.runSummary.baselines,
      baselineName: 'ledgermind_static_materialize',
    });
    expect(ledgermind.aggregate.mean).toBeGreaterThanOrEqual(0);
    expect(ledgermind.evidenceRecall.overall.mean).toBeGreaterThanOrEqual(0);
    expect(ledgermind.evidenceRecall.overall.mean).toBeLessThanOrEqual(1);

    const fullContext = findSummary({
      summaries: result.runSummary.baselines,
      baselineName: 'full_context',
    });
    expect(fullContext.parityMode === 'upper_bound' || fullContext.parityMode === 'parity').toBe(true);
    expect(fullContext.evidenceRecall.overall.mean).toBeCloseTo(1, 8);

    const perExampleContent = await readFile(result.perExamplePath, 'utf8');
    const ledgermindRows = perExampleContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly baseline: string;
            readonly prediction: string;
            readonly provenance?: {
              readonly requestedPredictionMode?: string;
              readonly actualPredictionSource?: string;
            };
          },
      )
      .filter((row) => row.baseline === 'ledgermind_static_materialize');

    expect(ledgermindRows.length).toBeGreaterThan(0);
    expect(
      ledgermindRows.some((row) =>
        row.prediction.toLowerCase().includes('you have access to memory tools'),
      ),
    ).toBe(false);
    expect(ledgermindRows.every((row) => row.provenance?.requestedPredictionMode === 'heuristic')).toBe(true);
    expect(ledgermindRows.every((row) => row.provenance?.actualPredictionSource === 'heuristic')).toBe(true);

    const traceContent = await readFile(result.tracePerExamplePath, 'utf8');
    const traceRows = traceContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly traceSchemaVersion: string;
            readonly status: string;
            readonly executionIndex: number;
            readonly totalExecutionsPlanned: number;
            readonly failureClassification?: { readonly category: string };
            readonly provenance?: {
              readonly requestedPredictionMode?: string;
              readonly actualPredictionSource?: string;
            };
          },
      );

    const expectedExecutions = config.baselines.length * config.seeds.length * examples.length;
    expect(traceRows).toHaveLength(expectedExecutions);
    expect(traceRows.every((row) => row.traceSchemaVersion === 'locomo_trace_v2')).toBe(true);
    expect(traceRows.every((row) => row.status === 'ok')).toBe(true);
    expect(traceRows.every((row) => row.failureClassification !== undefined)).toBe(true);
    expect(traceRows.every((row) => row.provenance?.requestedPredictionMode === 'heuristic')).toBe(true);
    expect(traceRows.every((row) => row.provenance?.actualPredictionSource === 'heuristic')).toBe(true);
    expect(traceRows[0]?.executionIndex).toBe(1);
    expect(traceRows.at(-1)?.executionIndex).toBe(expectedExecutions);
    expect(traceRows[0]?.totalExecutionsPlanned).toBe(expectedExecutions);

    const executionProvenance = result.runSummary.executionProvenance;
    expect(executionProvenance).toBeDefined();
    expect(executionProvenance?.requestedPredictionMode).toBe('heuristic');
    expect(executionProvenance?.baselines).toHaveLength(expectedBaselines.length);

    for (const baselineName of expectedBaselines) {
      const provenanceBaseline = findProvenanceBaseline({
        baselines: executionProvenance?.baselines ?? [],
        baselineName,
      });
      const counts = provenanceBaseline.actualPredictionSourceCounts;
      expect(counts.totalRows).toBe(examples.length);
      expect(counts.heuristicRows).toBe(examples.length);
      expect(counts.llmRows).toBe(0);
      expect(counts.unknownRows).toBe(0);

      if (baselineName.startsWith('ledgermind_')) {
        expect(provenanceBaseline.runtime?.runtimeMode).toBe('static_materialize');
        expect(provenanceBaseline.runtime?.summarizerType).toBe(config.summarizerType);
        expect(provenanceBaseline.runtime?.artifactsEnabled).toBe(config.artifactsEnabled);
      } else {
        expect(provenanceBaseline.runtime).toBeNull();
      }
    }

    const promotionGates = result.runSummary.promotionGates;
    expect(promotionGates).toBeDefined();
    expect(promotionGates).toHaveLength(3);

    const runtimeAnchor = findSummary({
      summaries: result.runSummary.baselines,
      baselineName: 'ledgermind_static_materialize',
    });

    for (const baselineName of expectedBaselines.slice(4)) {
      const gate = findPromotionGate({
        gates: promotionGates ?? [],
        baselineName,
      });
      const summary = findSummary({
        summaries: result.runSummary.baselines,
        baselineName,
      });

      const aggregateDelta = summary.aggregate.mean - runtimeAnchor.aggregate.mean;
      expect(gate.aggregateDelta).toBeCloseTo(aggregateDelta, 8);

      const categoryDeltas: Record<number, number> = {};
      for (const category of PROMOTION_GATE_CATEGORY_SET) {
        categoryDeltas[category] =
          (summary.categoryScores[category]?.mean ?? 0) - (runtimeAnchor.categoryScores[category]?.mean ?? 0);
        expect(gate.categoryDeltas[category] ?? 0).toBeCloseTo(categoryDeltas[category] ?? 0, 8);
      }

      const improvedCategoryCount = PROMOTION_GATE_CATEGORY_SET.filter(
        (category) => (categoryDeltas[category] ?? 0) >= PROMOTION_GATE_CATEGORY_DELTA,
      ).length;
      const meetsAggregateGate = aggregateDelta >= PROMOTION_GATE_AGGREGATE_DELTA;
      const meetsCategoryGate = improvedCategoryCount >= PROMOTION_GATE_MIN_IMPROVED_CATEGORIES;

      expect(gate.improvedCategoryCount).toBe(improvedCategoryCount);
      expect(gate.meetsAggregateGate).toBe(meetsAggregateGate);
      expect(gate.meetsCategoryGate).toBe(meetsCategoryGate);
      expect(gate.promoted).toBe(meetsAggregateGate || meetsCategoryGate);
    }

    const summaryContent = await readFile(result.summaryPath, 'utf8');
    expect(summaryContent).toContain('## Promotion Gates (phase 3 smoke)');
    expect(summaryContent).toContain('## Execution Provenance');
    expect(summaryContent).toContain('Aggregate gate (>=0.03)');
    expect(summaryContent).toContain('Category gate (>=2)');
  }, 120_000);
});
