import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type {
  FairnessConfig,
  FairnessFingerprintInputs,
  LocomoBaselineCliName,
  LocomoBaselineName,
  LocomoConversationSample,
  LocomoExample,
  LocomoLegacyLedgermindBaselineName,
  LocomoPredictionMode,
  LocomoRuntimeLabeledLedgermindBaselineName,
  LocomoRuntimeMode,
  LocomoSummarizerType,
} from './types.js';
import { sha256Hex, stableJson } from './utils.js';

export interface LocomoRunCliOptions {
  readonly smoke: boolean;
  readonly canary: boolean;
  readonly datasetPath?: string;
  readonly outDir?: string;
  readonly baselines?: readonly LocomoBaselineCliName[];
  readonly seeds?: readonly number[];
  readonly includeLedgermindDiagnostics: boolean;
  readonly runtimeMode?: LocomoRuntimeMode;
  readonly artifactsEnabled?: boolean;
  readonly ledgermindRawTurnInjectionTopK?: number;
  readonly ledgermindRawTurnInjectionMaxTokens?: number;
  readonly ledgermindToolLoopMaxSteps?: number;
  readonly ledgermindToolLoopMaxDescribeCalls?: number;
  readonly ledgermindToolLoopMaxExploreArtifactCalls?: number;
  readonly ledgermindToolLoopMaxExpandCalls?: number;
  readonly ledgermindToolLoopMaxGrepCalls?: number;
  readonly ledgermindToolLoopMaxAddedTokens?: number;
  readonly modelName?: string;
  readonly predictionMode?: LocomoPredictionMode;
  readonly llmBaseUrl?: string;
  readonly llmApiKey?: string;
  readonly llmTimeoutMs?: number;
  readonly maxExamples?: number;
  readonly summarizerType?: LocomoSummarizerType;
}

export interface LocomoBenchmarkConfig {
  readonly runId: string;
  readonly datasetPath: string;
  readonly outputDir: string;
  readonly baselines: readonly LocomoBaselineName[];
  readonly seeds: readonly number[];
  readonly smoke: boolean;
  readonly canary: boolean;
  readonly fairness: FairnessConfig;
  readonly predictionMode: LocomoPredictionMode;
  readonly seedMode: 'ignored' | 'forwarded';
  readonly llmBaseUrl: string | undefined;
  readonly llmApiKey: string | undefined;
  readonly llmTimeoutMs: number;
  readonly maxExamples: number | undefined;
  readonly scorerPath: string;
  readonly scorerVersion: string;
  readonly smokeExampleIdsPath: string;
  readonly canaryExampleIdsPath: string;
  readonly retrievedSummaryLimit: number;
  readonly ragTopK: number;
  readonly ledgermindRawTurnInjectionTopK: number;
  readonly ledgermindRawTurnInjectionMaxTokens: number;
  readonly ledgermindToolLoopMaxSteps: number;
  readonly ledgermindToolLoopMaxDescribeCalls: number;
  readonly ledgermindToolLoopMaxExploreArtifactCalls: number;
  readonly ledgermindToolLoopMaxExpandCalls: number;
  readonly ledgermindToolLoopMaxGrepCalls: number;
  readonly ledgermindToolLoopMaxAddedTokens: number;
  readonly includeLedgermindDiagnostics: boolean;
  readonly fairnessFingerprintInputs: FairnessFingerprintInputs;
  readonly runtimeMode: LocomoRuntimeMode;
  readonly summarizerType: LocomoSummarizerType;
  readonly artifactsEnabled: boolean;
  readonly fairnessFingerprint: string;
  readonly promptHash: string;
  readonly costPer1kPromptUsd: number;
  readonly costPer1kCompletionUsd: number;
}

interface SubsetExampleIdRecord {
  readonly sampleId: string;
  readonly qaIndex: number;
}

interface SubsetExampleConfig {
  readonly examples: readonly SubsetExampleIdRecord[];
}

const DEFAULT_LLM_PLACEHOLDER_MODEL = 'locomo-deterministic-eval-model';

const defaultFairnessPrompt =
  'Based on the above context, write an answer in the form of a short phrase for the following question. Answer with exact words from the context whenever possible. If no information is available to answer the question, write "No information available".';

const STATIC_RUNTIME_BASELINES: readonly LocomoRuntimeLabeledLedgermindBaselineName[] = [
  'ledgermind_static_materialize',
  'ledgermind_static_materialize_no_precompaction',
  'ledgermind_static_materialize_raw_turn_injection',
  'ledgermind_static_materialize_no_precompaction_raw_turn_injection',
];

const AGENTIC_RUNTIME_BASELINES: readonly LocomoRuntimeLabeledLedgermindBaselineName[] = [
  'ledgermind_agentic_loop',
  'ledgermind_agentic_loop_no_precompaction',
  'ledgermind_agentic_loop_raw_turn_injection',
  'ledgermind_agentic_loop_no_precompaction_raw_turn_injection',
];

const DEFAULT_BASELINES_BY_RUNTIME: Readonly<Record<LocomoRuntimeMode, readonly LocomoBaselineName[]>> = {
  static_materialize: ['ledgermind_static_materialize', 'truncation', 'rag', 'full_context'],
  agentic_loop: ['ledgermind_agentic_loop', 'truncation', 'rag', 'full_context'],
};

const LEDGERMIND_DIAGNOSTIC_BASELINES_BY_RUNTIME: Readonly<Record<LocomoRuntimeMode, readonly LocomoBaselineName[]>> = {
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
};

const LEGACY_TO_RUNTIME_BASELINE: Readonly<Record<LocomoLegacyLedgermindBaselineName, {
  readonly static_materialize: LocomoRuntimeLabeledLedgermindBaselineName;
  readonly agentic_loop: LocomoRuntimeLabeledLedgermindBaselineName;
}>> = {
  ledgermind: {
    static_materialize: 'ledgermind_static_materialize',
    agentic_loop: 'ledgermind_agentic_loop',
  },
  ledgermind_no_precompaction: {
    static_materialize: 'ledgermind_static_materialize_no_precompaction',
    agentic_loop: 'ledgermind_agentic_loop_no_precompaction',
  },
  ledgermind_raw_turn_injection: {
    static_materialize: 'ledgermind_static_materialize_raw_turn_injection',
    agentic_loop: 'ledgermind_agentic_loop_raw_turn_injection',
  },
  ledgermind_no_precompaction_raw_turn_injection: {
    static_materialize: 'ledgermind_static_materialize_no_precompaction_raw_turn_injection',
    agentic_loop: 'ledgermind_agentic_loop_no_precompaction_raw_turn_injection',
  },
};

const ORACLE_BASELINES: readonly LocomoBaselineName[] = ['oracle_evidence', 'oracle_full_conversation_llm'];
const LEGACY_LEDGERMIND_BASELINES = Object.freeze(
  Object.keys(LEGACY_TO_RUNTIME_BASELINE) as readonly LocomoLegacyLedgermindBaselineName[],
);

const isStaticRuntimeBaselineName = (
  baseline: LocomoBaselineCliName,
): baseline is LocomoRuntimeLabeledLedgermindBaselineName => {
  return STATIC_RUNTIME_BASELINES.includes(baseline as LocomoRuntimeLabeledLedgermindBaselineName);
};

const isAgenticRuntimeBaselineName = (
  baseline: LocomoBaselineCliName,
): baseline is LocomoRuntimeLabeledLedgermindBaselineName => {
  return AGENTIC_RUNTIME_BASELINES.includes(baseline as LocomoRuntimeLabeledLedgermindBaselineName);
};

const resolveLegacyBaseline = (input: {
  readonly baseline: LocomoBaselineCliName;
  readonly runtimeMode: LocomoRuntimeMode;
}): LocomoBaselineName => {
  const runtimeLabeled = LEGACY_TO_RUNTIME_BASELINE[input.baseline as LocomoLegacyLedgermindBaselineName];
  if (runtimeLabeled !== undefined) {
    return runtimeLabeled[input.runtimeMode];
  }

  return input.baseline as LocomoBaselineName;
};

const parseRuntimeMode = (value: string, sourceName: string): LocomoRuntimeMode => {
  if (value === 'static_materialize' || value === 'agentic_loop') {
    return value;
  }

  throw new Error(`Invalid value for ${sourceName}: ${value}`);
};

const parseSummarizerType = (value: string, sourceName: string): LocomoSummarizerType => {
  if (value === 'locomo_deterministic_head_tail_v1' || value === 'locomo_llm_structured_v1') {
    return value;
  }

  throw new Error(`Invalid value for ${sourceName}: ${value}`);
};

const parseBaselines = (value: string): readonly LocomoBaselineCliName[] => {
  const parsed = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parsed.length === 0) {
    throw new Error('Missing values for --baselines');
  }

  const allowed = new Set<LocomoBaselineCliName>([
    ...STATIC_RUNTIME_BASELINES,
    ...AGENTIC_RUNTIME_BASELINES,
    ...LEGACY_LEDGERMIND_BASELINES,
    ...ORACLE_BASELINES,
    'truncation',
    'rag',
    'full_context',
  ]);
  const baselines: LocomoBaselineCliName[] = [];

  for (const baseline of parsed) {
    if (!allowed.has(baseline as LocomoBaselineCliName)) {
      throw new Error(`Unknown baseline in --baselines: ${baseline}`);
    }

    baselines.push(baseline as LocomoBaselineCliName);
  }

  return Object.freeze([...new Set(baselines)]);
};

const parseSeeds = (value: string): readonly number[] => {
  const parsed = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10));

  if (parsed.length === 0) {
    throw new Error('Missing values for --seeds');
  }

  for (const seed of parsed) {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new Error(`Invalid seed in --seeds: ${seed}`);
    }
  }

  return Object.freeze([...new Set(parsed)]);
};

const parsePositiveInteger = (value: string, flagName: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }

  return parsed;
};

const normalizeOptionalString = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const parsePredictionMode = (
  value: string | undefined,
  sourceName: string,
): LocomoPredictionMode | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'heuristic' || value === 'llm') {
    return value;
  }

  throw new Error(`Invalid value for ${sourceName}: ${value}`);
};

const parseBooleanOption = (value: string | undefined, sourceName: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`Invalid value for ${sourceName}: ${value}`);
};

const assertValidLlmConfig = (input: {
  readonly llmBaseUrl: string | undefined;
  readonly modelName: string;
  readonly sourceLabel: string;
}): void => {
  if (input.llmBaseUrl === undefined) {
    throw new Error(`${input.sourceLabel} requires --llm-base-url or LOCOMO_LLM_BASE_URL`);
  }

  try {
    new URL(input.llmBaseUrl);
  } catch {
    throw new Error(`Invalid value for LOCOMO LLM base URL: ${input.llmBaseUrl}`);
  }

  if (input.modelName === DEFAULT_LLM_PLACEHOLDER_MODEL) {
    throw new Error(
      `${input.sourceLabel} requires an explicit --model, LOCOMO_MODEL, or OPENAI_MODEL; refusing placeholder model ${DEFAULT_LLM_PLACEHOLDER_MODEL}`,
    );
  }
};

const parseArgs = (argv: readonly string[]): LocomoRunCliOptions => {
  let smoke = false;
  let canary = false;
  let datasetPath: string | undefined;
  let outDir: string | undefined;
  let baselines: readonly LocomoBaselineCliName[] | undefined;
  let seeds: readonly number[] | undefined;
  let includeLedgermindDiagnostics = false;
  let runtimeMode: LocomoRuntimeMode | undefined;
  let artifactsEnabled: boolean | undefined;
  let ledgermindRawTurnInjectionTopK: number | undefined;
  let ledgermindRawTurnInjectionMaxTokens: number | undefined;
  let ledgermindToolLoopMaxSteps: number | undefined;
  let ledgermindToolLoopMaxDescribeCalls: number | undefined;
  let ledgermindToolLoopMaxExploreArtifactCalls: number | undefined;
  let ledgermindToolLoopMaxExpandCalls: number | undefined;
  let ledgermindToolLoopMaxGrepCalls: number | undefined;
  let ledgermindToolLoopMaxAddedTokens: number | undefined;
  let modelName: string | undefined;
  let predictionMode: LocomoPredictionMode | undefined;
  let llmBaseUrl: string | undefined;
  let llmApiKey: string | undefined;
  let llmTimeoutMs: number | undefined;
  let maxExamples: number | undefined;
  let summarizerType: LocomoSummarizerType | undefined;

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

    if (arg === '--include-ledgermind-diagnostics') {
      includeLedgermindDiagnostics = true;
      continue;
    }

    if (arg === '--dataset') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --dataset');
      }
      datasetPath = value;
      index += 1;
      continue;
    }

    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --out-dir');
      }
      outDir = value;
      index += 1;
      continue;
    }

    if (arg === '--baselines') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --baselines');
      }
      baselines = parseBaselines(value);
      index += 1;
      continue;
    }

    if (arg === '--seeds') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --seeds');
      }
      seeds = parseSeeds(value);
      index += 1;
      continue;
    }

    if (arg === '--model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --model');
      }
      modelName = value.trim();
      index += 1;
      continue;
    }

    if (arg === '--prediction-mode') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --prediction-mode');
      }
      if (value !== 'heuristic' && value !== 'llm') {
        throw new Error(`Invalid value for --prediction-mode: ${value}`);
      }
      predictionMode = value;
      index += 1;
      continue;
    }

    if (arg === '--runtime-mode') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --runtime-mode');
      }
      runtimeMode = parseRuntimeMode(value, '--runtime-mode');
      index += 1;
      continue;
    }

    if (arg === '--artifacts-enabled') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --artifacts-enabled');
      }
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Invalid value for --artifacts-enabled: ${value}`);
      }
      artifactsEnabled = value === 'true';
      index += 1;
      continue;
    }

    if (arg === '--summarizer-type') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --summarizer-type');
      }
      summarizerType = parseSummarizerType(value, '--summarizer-type');
      index += 1;
      continue;
    }

    if (arg === '--llm-base-url') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --llm-base-url');
      }
      llmBaseUrl = value.trim();
      index += 1;
      continue;
    }

    if (arg === '--llm-api-key') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --llm-api-key');
      }
      llmApiKey = value;
      index += 1;
      continue;
    }

    if (arg === '--llm-timeout-ms') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --llm-timeout-ms');
      }
      llmTimeoutMs = parsePositiveInteger(value, '--llm-timeout-ms');
      index += 1;
      continue;
    }

    if (arg === '--max-examples') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --max-examples');
      }
      maxExamples = parsePositiveInteger(value, '--max-examples');
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-raw-turn-injection-top-k') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-raw-turn-injection-top-k');
      }
      ledgermindRawTurnInjectionTopK = parsePositiveInteger(value, '--ledgermind-raw-turn-injection-top-k');
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-raw-turn-injection-max-tokens') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-raw-turn-injection-max-tokens');
      }
      ledgermindRawTurnInjectionMaxTokens = parsePositiveInteger(
        value,
        '--ledgermind-raw-turn-injection-max-tokens',
      );
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-tool-loop-max-steps') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-tool-loop-max-steps');
      }
      ledgermindToolLoopMaxSteps = parsePositiveInteger(value, '--ledgermind-tool-loop-max-steps');
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-tool-loop-max-describe-calls') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-tool-loop-max-describe-calls');
      }
      ledgermindToolLoopMaxDescribeCalls = parsePositiveInteger(value, '--ledgermind-tool-loop-max-describe-calls');
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-tool-loop-max-explore-artifact-calls') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-tool-loop-max-explore-artifact-calls');
      }
      ledgermindToolLoopMaxExploreArtifactCalls = parsePositiveInteger(
        value,
        '--ledgermind-tool-loop-max-explore-artifact-calls',
      );
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-tool-loop-max-expand-calls') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-tool-loop-max-expand-calls');
      }
      ledgermindToolLoopMaxExpandCalls = parsePositiveInteger(value, '--ledgermind-tool-loop-max-expand-calls');
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-tool-loop-max-grep-calls') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-tool-loop-max-grep-calls');
      }
      ledgermindToolLoopMaxGrepCalls = parsePositiveInteger(value, '--ledgermind-tool-loop-max-grep-calls');
      index += 1;
      continue;
    }

    if (arg === '--ledgermind-tool-loop-max-added-tokens') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --ledgermind-tool-loop-max-added-tokens');
      }
      ledgermindToolLoopMaxAddedTokens = parsePositiveInteger(value, '--ledgermind-tool-loop-max-added-tokens');
      index += 1;
      continue;
    }

    throw new Error(`Unknown CLI argument: ${arg}`);
  }

  if (smoke && canary) {
    throw new Error('Cannot combine --smoke and --canary in the same run.');
  }

  return {
    smoke,
    canary,
    includeLedgermindDiagnostics,
    ...(datasetPath === undefined ? {} : { datasetPath }),
    ...(outDir === undefined ? {} : { outDir }),
    ...(baselines === undefined ? {} : { baselines }),
    ...(seeds === undefined ? {} : { seeds }),
    ...(runtimeMode === undefined ? {} : { runtimeMode }),
    ...(artifactsEnabled === undefined ? {} : { artifactsEnabled }),
    ...(ledgermindRawTurnInjectionTopK === undefined ? {} : { ledgermindRawTurnInjectionTopK }),
    ...(ledgermindRawTurnInjectionMaxTokens === undefined ? {} : { ledgermindRawTurnInjectionMaxTokens }),
    ...(ledgermindToolLoopMaxSteps === undefined ? {} : { ledgermindToolLoopMaxSteps }),
    ...(ledgermindToolLoopMaxDescribeCalls === undefined ? {} : { ledgermindToolLoopMaxDescribeCalls }),
    ...(ledgermindToolLoopMaxExploreArtifactCalls === undefined
      ? {}
      : { ledgermindToolLoopMaxExploreArtifactCalls }),
    ...(ledgermindToolLoopMaxExpandCalls === undefined ? {} : { ledgermindToolLoopMaxExpandCalls }),
    ...(ledgermindToolLoopMaxGrepCalls === undefined ? {} : { ledgermindToolLoopMaxGrepCalls }),
    ...(ledgermindToolLoopMaxAddedTokens === undefined ? {} : { ledgermindToolLoopMaxAddedTokens }),
    ...(modelName === undefined ? {} : { modelName }),
    ...(predictionMode === undefined ? {} : { predictionMode }),
    ...(llmBaseUrl === undefined ? {} : { llmBaseUrl }),
    ...(llmApiKey === undefined ? {} : { llmApiKey }),
    ...(llmTimeoutMs === undefined ? {} : { llmTimeoutMs }),
    ...(maxExamples === undefined ? {} : { maxExamples }),
    ...(summarizerType === undefined ? {} : { summarizerType }),
  };
};

const nowUtc = (): string => {
  return new Date().toISOString();
};

export const createRunId = (): string => {
  const stamp = nowUtc().replaceAll(/[:.]/g, '-');
  return `locomo-${stamp}`;
};

export const resolveRepoRoot = (): string => {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '../../..');
};

export const buildBenchmarkConfig = (cliArgv: readonly string[]): LocomoBenchmarkConfig => {
  const cli = parseArgs(cliArgv);
  const repoRoot = resolveRepoRoot();
  const runId = createRunId();

  const datasetPath =
    cli.datasetPath === undefined
      ? path.resolve(repoRoot, 'benchmarks/locomo/data/locomo10.json')
      : path.resolve(repoRoot, cli.datasetPath);

  const outputDir =
    cli.outDir === undefined
      ? path.resolve(repoRoot, `benchmarks/locomo/runs/${runId}`)
      : path.resolve(repoRoot, cli.outDir);

  const runtimeMode =
    cli.runtimeMode ??
    parseRuntimeMode(
      normalizeOptionalString(process.env['LOCOMO_RUNTIME_MODE']) ?? 'static_materialize',
      'LOCOMO_RUNTIME_MODE',
    );

  if (cli.baselines !== undefined) {
    const containsStaticLabeled = cli.baselines.some((baseline) => isStaticRuntimeBaselineName(baseline));
    const containsAgenticLabeled = cli.baselines.some((baseline) => isAgenticRuntimeBaselineName(baseline));

    if (containsStaticLabeled && containsAgenticLabeled) {
      throw new Error(
        'Cannot mix static_materialize and agentic_loop LedgerMind baseline labels in one run. Choose one runtime mode.',
      );
    }

    if (runtimeMode === 'static_materialize' && containsAgenticLabeled) {
      throw new Error(
        'Runtime mode static_materialize is incompatible with agentic_loop-labeled baselines in --baselines.',
      );
    }

    if (runtimeMode === 'agentic_loop' && containsStaticLabeled) {
      throw new Error(
        'Runtime mode agentic_loop is incompatible with static_materialize-labeled baselines in --baselines.',
      );
    }
  }

  const predictionMode =
    cli.predictionMode ?? parsePredictionMode(normalizeOptionalString(process.env['LOCOMO_PREDICTION_MODE']), 'LOCOMO_PREDICTION_MODE') ?? 'heuristic';
  const llmBaseUrl = normalizeOptionalString(cli.llmBaseUrl ?? process.env['LOCOMO_LLM_BASE_URL']);
  const llmApiKey = normalizeOptionalString(
    cli.llmApiKey ?? process.env['LOCOMO_LLM_API_KEY'] ?? process.env['OPENAI_API_KEY'],
  );
  const llmTimeoutMs =
    cli.llmTimeoutMs ??
    parsePositiveInteger(process.env['LOCOMO_LLM_TIMEOUT_MS'] ?? '60000', 'LOCOMO_LLM_TIMEOUT_MS');
  const maxExamples = cli.maxExamples;

  const configuredModelName =
    normalizeOptionalString(cli.modelName ?? process.env['LOCOMO_MODEL'] ?? process.env['OPENAI_MODEL']) ??
    DEFAULT_LLM_PLACEHOLDER_MODEL;

  const summarizerType =
    cli.summarizerType ??
    parseSummarizerType(
      normalizeOptionalString(process.env['LOCOMO_SUMMARIZER_TYPE']) ?? 'locomo_deterministic_head_tail_v1',
      'LOCOMO_SUMMARIZER_TYPE',
    );

  const artifactsEnabled =
    cli.artifactsEnabled ??
    parseBooleanOption(normalizeOptionalString(process.env['LOCOMO_ARTIFACTS_ENABLED']), 'LOCOMO_ARTIFACTS_ENABLED') ??
    true;

  if (predictionMode === 'llm') {
    assertValidLlmConfig({
      llmBaseUrl,
      modelName: configuredModelName,
      sourceLabel: 'LOCOMO LLM mode',
    });
  }

  if (summarizerType === 'locomo_llm_structured_v1') {
    assertValidLlmConfig({
      llmBaseUrl,
      modelName: configuredModelName,
      sourceLabel: 'LOCOMO LLM summarizer mode',
    });
  }

  const fairness: FairnessConfig = {
    modelName: configuredModelName,
    promptTemplate: defaultFairnessPrompt,
    temperature: 0,
    topP: 1,
    tokenBudget: 3_000,
    overheadTokens: 300,
    maxAnswerTokens: 50,
  };

  const scorerPath = path.resolve(repoRoot, 'benchmarks/locomo/vendor/locomo/task_eval/evaluation.py');
  const scorerVersion = 'snap-research/locomo@main (evaluation.py wrapper parity)';
  const smokeExampleIdsPath = path.resolve(repoRoot, 'benchmarks/locomo/config/smoke-example-ids.json');
  const canaryExampleIdsPath = path.resolve(repoRoot, 'benchmarks/locomo/config/canary-example-ids.json');

  const defaultOracleBaselines = predictionMode === 'llm' ? [...ORACLE_BASELINES] : [];

  const normalizedCliBaselines =
    cli.baselines === undefined
      ? undefined
      : Object.freeze(
          cli.baselines.map((baseline) =>
            resolveLegacyBaseline({
              baseline,
              runtimeMode,
            }),
          ),
        );

  const defaultLedgermindBaselines: LocomoBaselineName[] = [
    ...DEFAULT_BASELINES_BY_RUNTIME[runtimeMode],
    ...(cli.includeLedgermindDiagnostics ? [...LEDGERMIND_DIAGNOSTIC_BASELINES_BY_RUNTIME[runtimeMode]] : []),
  ];

  const baselines = normalizedCliBaselines ?? [...defaultLedgermindBaselines, ...defaultOracleBaselines];

  const seeds = cli.seeds ?? [0, 1, 2];
  const seedMode = predictionMode === 'llm' ? 'forwarded' : 'ignored';
  const retrievedSummaryLimit = 6;
  const ragTopK = 8;
  const ledgermindRawTurnInjectionTopK = cli.ledgermindRawTurnInjectionTopK ?? 4;
  const ledgermindRawTurnInjectionMaxTokens = cli.ledgermindRawTurnInjectionMaxTokens ?? 256;
  const ledgermindToolLoopMaxSteps = cli.ledgermindToolLoopMaxSteps ?? 6;
  const ledgermindToolLoopMaxDescribeCalls = cli.ledgermindToolLoopMaxDescribeCalls ?? 3;
  const ledgermindToolLoopMaxExploreArtifactCalls = cli.ledgermindToolLoopMaxExploreArtifactCalls ?? 2;
  const ledgermindToolLoopMaxExpandCalls = cli.ledgermindToolLoopMaxExpandCalls ?? 2;
  const ledgermindToolLoopMaxGrepCalls = cli.ledgermindToolLoopMaxGrepCalls ?? 2;
  const ledgermindToolLoopMaxAddedTokens = cli.ledgermindToolLoopMaxAddedTokens ?? 256;

  if (
    ledgermindToolLoopMaxDescribeCalls > ledgermindToolLoopMaxSteps ||
    ledgermindToolLoopMaxExploreArtifactCalls > ledgermindToolLoopMaxSteps ||
    ledgermindToolLoopMaxExpandCalls > ledgermindToolLoopMaxSteps ||
    ledgermindToolLoopMaxGrepCalls > ledgermindToolLoopMaxSteps
  ) {
    throw new Error(
      '--ledgermind-tool-loop-max-steps must be >= each individual tool-call limit (describe/explore_artifact/expand/grep).',
    );
  }

  const fairnessFingerprintInputs: FairnessFingerprintInputs = {
    ledgermindRetrievalReserveFraction: 0.2,
    ledgermindRetrievalReserveMaxTokens: 256,
    ledgermindSummaryFormatter:
      summarizerType === 'locomo_llm_structured_v1' ? 'structured_llm_retrieval_v1' : 'structured_head_tail_v1',
    summarySearchScoring: 'staged_candidate_selection_v1',
    predictionExtractorVersion: predictionMode === 'llm' ? 'llm_completion_v1' : 'question_only_v2',
    category5PromptVersion: 'no_answer_choices_v1',
    rawTurnInjectionFormatterVersion: 'plain_lines_v2',
    rawTurnInjectionSelectionVersion: 'question_overlap_topk_v2',
    ledgermindToolLoopMaxSteps,
    ledgermindToolLoopMaxDescribeCalls,
    ledgermindToolLoopMaxExploreArtifactCalls,
    ledgermindToolLoopMaxExpandCalls,
    ledgermindToolLoopMaxGrepCalls,
    ledgermindToolLoopMaxAddedTokens,
    locomoArtifactMappingVersion: 'blip_caption_text_artifact_v1',
  };

  const fairnessFingerprint = sha256Hex(
    stableJson({
      modelName: fairness.modelName,
      promptTemplate: fairness.promptTemplate,
      temperature: fairness.temperature,
      topP: fairness.topP,
      tokenBudget: fairness.tokenBudget,
      maxAnswerTokens: fairness.maxAnswerTokens,
      overheadTokens: fairness.overheadTokens,
      predictionMode,
      seedMode,
      llmBaseUrl,
      llmTimeoutMs,
      maxExamples,
      scorerVersion,
      datasetPath,
      smoke: cli.smoke,
      canary: cli.canary,
      baselines,
      seeds,
      includeLedgermindDiagnostics: cli.includeLedgermindDiagnostics,
      runtimeMode,
      summarizerType,
      artifactsEnabled,
      ...fairnessFingerprintInputs,
      ragTopK,
      retrievedSummaryLimit,
      ledgermindRawTurnInjectionTopK,
      ledgermindRawTurnInjectionMaxTokens,
      ledgermindToolLoopMaxSteps,
      ledgermindToolLoopMaxDescribeCalls,
      ledgermindToolLoopMaxExploreArtifactCalls,
      ledgermindToolLoopMaxExpandCalls,
      ledgermindToolLoopMaxGrepCalls,
      ledgermindToolLoopMaxAddedTokens,
    }),
  );

  return {
    runId,
    datasetPath,
    outputDir,
    baselines,
    seeds,
    smoke: cli.smoke,
    canary: cli.canary,
    fairness,
    predictionMode,
    seedMode,
    llmBaseUrl,
    llmApiKey,
    llmTimeoutMs,
    maxExamples,
    scorerPath,
    scorerVersion,
    smokeExampleIdsPath,
    canaryExampleIdsPath,
    retrievedSummaryLimit,
    ragTopK,
    ledgermindRawTurnInjectionTopK,
    ledgermindRawTurnInjectionMaxTokens,
    ledgermindToolLoopMaxSteps,
    ledgermindToolLoopMaxDescribeCalls,
    ledgermindToolLoopMaxExploreArtifactCalls,
    ledgermindToolLoopMaxExpandCalls,
    ledgermindToolLoopMaxGrepCalls,
    ledgermindToolLoopMaxAddedTokens,
    includeLedgermindDiagnostics: cli.includeLedgermindDiagnostics,
    fairnessFingerprintInputs,
    runtimeMode,
    summarizerType,
    artifactsEnabled,
    fairnessFingerprint,
    promptHash: sha256Hex(fairness.promptTemplate),
    costPer1kPromptUsd: 0,
    costPer1kCompletionUsd: 0,
  };
};

const normalizeAnswer = (value: string | number | undefined): string => {
  if (value === undefined) {
    return 'Not mentioned in the conversation';
  }

  return String(value).trim();
};

const parseQaCategory = (value: unknown, sampleId: string, qaIndex: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid category at ${sampleId}#${qaIndex}`);
  }

  if (value < 1 || value > 5) {
    throw new Error(`Unsupported LOCOMO category ${value} at ${sampleId}#${qaIndex}`);
  }

  return value;
};

const toLocomoSample = (value: unknown): LocomoConversationSample => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid LOCOMO sample record.');
  }

  const raw = value as Record<string, unknown>;
  const sampleIdRaw = raw['sample_id'];
  const conversationRaw = raw['conversation'];
  const qaRaw = raw['qa'];

  if (typeof sampleIdRaw !== 'string' || sampleIdRaw.trim().length === 0) {
    throw new Error('LOCOMO sample missing sample_id.');
  }

  if (typeof conversationRaw !== 'object' || conversationRaw === null) {
    throw new Error(`LOCOMO sample (${sampleIdRaw}) missing conversation object.`);
  }

  if (!Array.isArray(qaRaw)) {
    throw new Error(`LOCOMO sample (${sampleIdRaw}) missing qa array.`);
  }

  const qa = qaRaw.map((item, qaIndex) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Invalid qa record at ${sampleIdRaw}#${qaIndex}`);
    }

    const qaRecord = item as Record<string, unknown>;
    const question = qaRecord['question'];
    const answer = qaRecord['answer'];
    const adversarialAnswer = qaRecord['adversarial_answer'];
    const evidence = qaRecord['evidence'];

    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new Error(`Missing question at ${sampleIdRaw}#${qaIndex}`);
    }

    const category = parseQaCategory(qaRecord['category'], sampleIdRaw, qaIndex);

    const isValidAnswer =
      (typeof answer === 'string' || typeof answer === 'number') && String(answer).trim().length > 0;
    const isValidAdversarialAnswer =
      (typeof adversarialAnswer === 'string' || typeof adversarialAnswer === 'number') &&
      String(adversarialAnswer).trim().length > 0;

    if (!isValidAnswer && !(category === 5 && isValidAdversarialAnswer)) {
      throw new Error(`Invalid answer at ${sampleIdRaw}#${qaIndex}`);
    }

    if (!Array.isArray(evidence) || !evidence.every((value) => typeof value === 'string')) {
      throw new Error(`Invalid evidence at ${sampleIdRaw}#${qaIndex}`);
    }

    return {
      question,
      ...(isValidAnswer ? { answer } : {}),
      ...(isValidAdversarialAnswer ? { adversarial_answer: adversarialAnswer } : {}),
      evidence,
      category,
    };
  });

  return {
    sample_id: sampleIdRaw,
    conversation: conversationRaw as Readonly<Record<string, unknown>>,
    qa,
  };
};

export const loadLocomoDataset = async (datasetPath: string): Promise<readonly LocomoConversationSample[]> => {
  const content = await readFile(datasetPath, 'utf8');
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('LOCOMO dataset must be a JSON array.');
  }

  return Object.freeze(parsed.map((sample) => toLocomoSample(sample)));
};

export const flattenExamples = (samples: readonly LocomoConversationSample[]): readonly LocomoExample[] => {
  const examples: LocomoExample[] = [];

  for (const sample of samples) {
    sample.qa.forEach((qa, qaIndex) => {
      examples.push({
        sampleId: sample.sample_id,
        qaIndex,
        category: qa.category,
        question: qa.question,
        answer: normalizeAnswer(qa.answer ?? qa.adversarial_answer),
        evidence: qa.evidence,
      });
    });
  }

  return Object.freeze(examples);
};

const loadSubsetExampleIds = async (input: {
  readonly path: string;
  readonly subsetName: string;
}): Promise<readonly SubsetExampleIdRecord[]> => {
  const content = await readFile(input.path, 'utf8');
  const parsed = JSON.parse(content) as SubsetExampleConfig;

  if (!Array.isArray(parsed.examples)) {
    throw new Error(`${input.subsetName} example config must provide examples array.`);
  }

  for (const item of parsed.examples) {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${input.subsetName} example entry must be an object.`);
    }

    if (typeof item.sampleId !== 'string' || item.sampleId.trim().length === 0) {
      throw new Error(`${input.subsetName} example entry must include sampleId.`);
    }

    if (!Number.isSafeInteger(item.qaIndex) || item.qaIndex < 0) {
      throw new Error(`${input.subsetName} example entry must include non-negative qaIndex.`);
    }
  }

  return Object.freeze(parsed.examples);
};

export const loadSmokeExampleIds = async (
  smokeExampleIdsPath: string,
): Promise<readonly SubsetExampleIdRecord[]> => {
  return loadSubsetExampleIds({
    path: smokeExampleIdsPath,
    subsetName: 'Smoke',
  });
};

export const loadCanaryExampleIds = async (
  canaryExampleIdsPath: string,
): Promise<readonly SubsetExampleIdRecord[]> => {
  return loadSubsetExampleIds({
    path: canaryExampleIdsPath,
    subsetName: 'Canary',
  });
};

const selectRoundRobinByCategory = (input: {
  readonly examples: readonly LocomoExample[];
  readonly maxExamples: number;
}): readonly LocomoExample[] => {
  if (input.maxExamples >= input.examples.length) {
    return input.examples;
  }

  const categories = [1, 2, 3, 4, 5] as const;
  const buckets = new Map<number, LocomoExample[]>();

  for (const category of categories) {
    buckets.set(category, []);
  }

  for (const example of input.examples) {
    const bucket = buckets.get(example.category) ?? [];
    bucket.push(example);
    buckets.set(example.category, bucket);
  }

  const selected: LocomoExample[] = [];

  while (selected.length < input.maxExamples) {
    let progressed = false;

    for (const category of categories) {
      const bucket = buckets.get(category) ?? [];
      const example = bucket.shift();
      if (example === undefined) {
        continue;
      }

      selected.push(example);
      progressed = true;

      if (selected.length >= input.maxExamples) {
        break;
      }
    }

    if (!progressed) {
      break;
    }
  }

  return Object.freeze(selected);
};

export const selectExamples = async (input: {
  readonly config: LocomoBenchmarkConfig;
  readonly samples: readonly LocomoConversationSample[];
}): Promise<readonly LocomoExample[]> => {
  const allExamples = flattenExamples(input.samples);

  if (!input.config.smoke && !input.config.canary) {
    if (input.config.maxExamples === undefined) {
      return allExamples;
    }

    return selectRoundRobinByCategory({
      examples: allExamples,
      maxExamples: input.config.maxExamples,
    });
  }

  const subsetExampleIds = input.config.smoke
    ? await loadSmokeExampleIds(input.config.smokeExampleIdsPath)
    : await loadCanaryExampleIds(input.config.canaryExampleIdsPath);
  const subsetLabel = input.config.smoke ? 'Smoke' : 'Canary';

  const selected: LocomoExample[] = [];

  const lookup = new Map(allExamples.map((example) => [`${example.sampleId}::${example.qaIndex}`, example]));

  for (const item of subsetExampleIds) {
    const example = lookup.get(`${item.sampleId}::${item.qaIndex}`);
    if (example === undefined) {
      throw new Error(
        `${subsetLabel} example (${item.sampleId}#${item.qaIndex}) not found in dataset ${input.config.datasetPath}.`,
      );
    }
    selected.push(example);
  }

  return Object.freeze(selected);
};
