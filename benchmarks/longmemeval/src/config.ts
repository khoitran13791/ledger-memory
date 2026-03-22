import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LONGMEMEVAL_ANSWER_PROMPT } from './prompts.js';
import type {
  LongMemEvalBaselineName,
  LongMemEvalBenchmarkConfig,
  LongMemEvalRunCliOptions,
  LongMemEvalRuntimeMode,
} from './types.js';

const benchmarkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDatasetPath = path.join(benchmarkDir, 'data', 'official', 'dataset.jsonl');
const defaultScorerPath = path.join(benchmarkDir, 'vendor', 'official-scorer', 'evaluate.py');
const defaultSmokeExampleIdsPath = path.join(benchmarkDir, 'config', 'smoke-example-ids.json');
const defaultCanaryExampleIdsPath = path.join(benchmarkDir, 'config', 'canary-example-ids.json');
const defaultRunsDir = path.join(benchmarkDir, 'runs');
const defaultBaselines: readonly LongMemEvalBaselineName[] = [
  'full_history_upper_bound',
  'ledgermind_static_materialize',
  'ledgermind_agentic_loop',
];

const parseRuntimeMode = (value: string): LongMemEvalRuntimeMode => {
  if (value === 'static_materialize' || value === 'agentic_loop') {
    return value;
  }

  throw new Error(`Invalid value for --runtime-mode: ${value}`);
};

const createRunId = (): string => {
  return new Date().toISOString().replace(/[:.]/g, '-');
};

export const parseCliOptions = (argv: readonly string[]): LongMemEvalRunCliOptions => {
  let smoke = false;
  let canary = false;
  let outDir: string | undefined;
  let runtimeMode: LongMemEvalRuntimeMode | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--smoke') {
      smoke = true;
      continue;
    }

    if (arg === '--canary') {
      canary = true;
      continue;
    }

    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --out-dir');
      }

      outDir = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg === '--runtime-mode') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --runtime-mode');
      }

      runtimeMode = parseRuntimeMode(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    smoke,
    canary,
    ...(outDir === undefined ? {} : { outDir }),
    ...(runtimeMode === undefined ? {} : { runtimeMode }),
  };
};

export const buildBenchmarkConfig = (argv: readonly string[]): LongMemEvalBenchmarkConfig => {
  const options = parseCliOptions(argv);

  if (options.smoke && options.canary) {
    throw new Error('Cannot combine --smoke and --canary in the same run.');
  }

  const runId = createRunId();

  return {
    smoke: options.smoke,
    canary: options.canary,
    runtimeMode: options.runtimeMode ?? 'static_materialize',
    baselines: defaultBaselines,
    fairness: {
      modelName: 'longmemeval-oracle-placeholder',
      promptTemplate: LONGMEMEVAL_ANSWER_PROMPT,
      temperature: 0,
      topP: 1,
      tokenBudget: 16_000,
      maxAnswerTokens: 128,
    },
    datasetPath: defaultDatasetPath,
    scorerPath: defaultScorerPath,
    smokeExampleIdsPath: defaultSmokeExampleIdsPath,
    canaryExampleIdsPath: defaultCanaryExampleIdsPath,
    outputDir: options.outDir ?? path.join(defaultRunsDir, runId),
    runId,
    costPer1kPromptUsd: 0,
    costPer1kCompletionUsd: 0,
  };
};
