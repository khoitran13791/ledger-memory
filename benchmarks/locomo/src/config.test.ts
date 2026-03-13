import { afterEach, describe, expect, it } from 'vitest';

import { buildBenchmarkConfig, loadLocomoDataset, selectExamples } from './config.js';

const originalEnv = { ...process.env };

const restoreEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);
};

describe('buildBenchmarkConfig', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('fails before evaluation when llm mode is requested without a base URL', () => {
    delete process.env['LOCOMO_LLM_BASE_URL'];
    process.env['LOCOMO_PREDICTION_MODE'] = 'llm';
    process.env['LOCOMO_MODEL'] = 'gpt-4o-mini';

    expect(() => buildBenchmarkConfig([])).toThrow('LOCOMO LLM mode requires --llm-base-url or LOCOMO_LLM_BASE_URL');
  });

  it('fails when llm summarizer is requested without a base URL even in heuristic prediction mode', () => {
    delete process.env['LOCOMO_LLM_BASE_URL'];
    process.env['LOCOMO_MODEL'] = 'gpt-4o-mini';

    expect(() => buildBenchmarkConfig(['--summarizer-type', 'locomo_llm_structured_v1'])).toThrow(
      'LOCOMO LLM summarizer mode requires --llm-base-url or LOCOMO_LLM_BASE_URL',
    );
  });

  it('fails before evaluation when llm mode still uses the placeholder model', () => {
    process.env['LOCOMO_PREDICTION_MODE'] = 'llm';
    process.env['LOCOMO_LLM_BASE_URL'] = 'https://example.test/v1';
    delete process.env['LOCOMO_MODEL'];
    delete process.env['OPENAI_MODEL'];

    expect(() => buildBenchmarkConfig([])).toThrow('refusing placeholder model locomo-deterministic-eval-model');
  });

  it('includes oracle baselines by default in llm mode', () => {
    process.env['LOCOMO_PREDICTION_MODE'] = 'llm';
    process.env['LOCOMO_LLM_BASE_URL'] = 'https://example.test/v1';
    process.env['LOCOMO_MODEL'] = 'gpt-4o-mini';

    const config = buildBenchmarkConfig([]);

    expect(config.baselines).toEqual([
      'ledgermind_static_materialize',
      'truncation',
      'rag',
      'full_context',
      'oracle_evidence',
      'oracle_full_conversation_llm',
    ]);
  });

  it('does not include oracle baselines by default in heuristic mode', () => {
    delete process.env['LOCOMO_PREDICTION_MODE'];
    delete process.env['LOCOMO_LLM_BASE_URL'];
    delete process.env['LOCOMO_MODEL'];
    delete process.env['OPENAI_MODEL'];

    const config = buildBenchmarkConfig([]);

    expect(config.baselines).toEqual(['ledgermind_static_materialize', 'truncation', 'rag', 'full_context']);
  });

  it('enables canary mode via --canary', () => {
    const config = buildBenchmarkConfig(['--canary']);

    expect(config.canary).toBe(true);
    expect(config.smoke).toBe(false);
    expect(config.canaryExampleIdsPath).toContain('benchmarks/locomo/config/canary-example-ids.json');
  });

  it('rejects combining --smoke and --canary', () => {
    expect(() => buildBenchmarkConfig(['--smoke', '--canary'])).toThrow(
      'Cannot combine --smoke and --canary in the same run.',
    );
  });

  it('switches defaults to agentic baseline labels when runtime mode is agentic_loop', () => {
    const config = buildBenchmarkConfig(['--runtime-mode', 'agentic_loop']);

    expect(config.runtimeMode).toBe('agentic_loop');
    expect(config.baselines).toEqual(['ledgermind_agentic_loop', 'truncation', 'rag', 'full_context']);
  });

  it('accepts explicit summarizer type from CLI and reflects it in config and fairness inputs', () => {
    process.env['LOCOMO_LLM_BASE_URL'] = 'https://example.test/v1';
    process.env['LOCOMO_MODEL'] = 'gpt-4o-mini';

    const config = buildBenchmarkConfig(['--summarizer-type', 'locomo_llm_structured_v1']);

    expect(config.summarizerType).toBe('locomo_llm_structured_v1');
    expect(config.fairnessFingerprintInputs.ledgermindSummaryFormatter).toBe('structured_llm_retrieval_v1');
  });

  it('supports artifacts toggle via CLI and environment', () => {
    const cliConfig = buildBenchmarkConfig(['--artifacts-enabled', 'false']);
    expect(cliConfig.artifactsEnabled).toBe(false);

    process.env['LOCOMO_ARTIFACTS_ENABLED'] = 'false';
    const envConfig = buildBenchmarkConfig([]);
    expect(envConfig.artifactsEnabled).toBe(false);
  });

  it('rejects invalid artifacts toggle values', () => {
    expect(() => buildBenchmarkConfig(['--artifacts-enabled', 'maybe'])).toThrow(
      'Invalid value for --artifacts-enabled: maybe',
    );

    process.env['LOCOMO_ARTIFACTS_ENABLED'] = 'sometimes';
    expect(() => buildBenchmarkConfig([])).toThrow('Invalid value for LOCOMO_ARTIFACTS_ENABLED: sometimes');
  });

  it('maps legacy baseline labels through runtime mode', () => {
    const config = buildBenchmarkConfig([
      '--runtime-mode',
      'agentic_loop',
      '--baselines',
      'ledgermind,ledgermind_no_precompaction,rag',
    ]);

    expect(config.baselines).toEqual([
      'ledgermind_agentic_loop',
      'ledgermind_agentic_loop_no_precompaction',
      'rag',
    ]);
  });

  it('rejects mixing runtime-labeled static and agentic baselines in one run', () => {
    expect(() =>
      buildBenchmarkConfig([
        '--baselines',
        'ledgermind_static_materialize,ledgermind_agentic_loop,rag',
      ]),
    ).toThrow('Cannot mix static_materialize and agentic_loop LedgerMind baseline labels in one run.');
  });

  it('rejects agentic labels when runtime mode is static_materialize', () => {
    expect(() =>
      buildBenchmarkConfig([
        '--runtime-mode',
        'static_materialize',
        '--baselines',
        'ledgermind_agentic_loop,rag',
      ]),
    ).toThrow('Runtime mode static_materialize is incompatible with agentic_loop-labeled baselines in --baselines.');
  });

  it('rejects static labels when runtime mode is agentic_loop', () => {
    expect(() =>
      buildBenchmarkConfig([
        '--runtime-mode',
        'agentic_loop',
        '--baselines',
        'ledgermind_static_materialize,rag',
      ]),
    ).toThrow('Runtime mode agentic_loop is incompatible with static_materialize-labeled baselines in --baselines.');
  });

  it('selects the committed canary subset with category weighting toward 1/3/4', async () => {
    const config = buildBenchmarkConfig(['--canary']);
    const samples = await loadLocomoDataset(config.datasetPath);
    const selected = await selectExamples({
      config,
      samples,
    });

    const categoryCounts = selected.reduce<Record<number, number>>((acc, example) => {
      acc[example.category] = (acc[example.category] ?? 0) + 1;
      return acc;
    }, {});

    expect(selected).toHaveLength(30);
    expect(categoryCounts[1]).toBe(9);
    expect(categoryCounts[3]).toBe(9);
    expect(categoryCounts[4]).toBe(9);
    expect((categoryCounts[1] ?? 0) + (categoryCounts[3] ?? 0) + (categoryCounts[4] ?? 0)).toBe(27);
    expect(categoryCounts[2]).toBe(2);
    expect(categoryCounts[5]).toBe(1);
  });

  it('accepts bounded tool-loop knobs and hashes them into fairness inputs', () => {
    const config = buildBenchmarkConfig([
      '--runtime-mode',
      'agentic_loop',
      '--ledgermind-tool-loop-max-steps',
      '7',
      '--ledgermind-tool-loop-max-describe-calls',
      '4',
      '--ledgermind-tool-loop-max-explore-artifact-calls',
      '3',
      '--ledgermind-tool-loop-max-expand-calls',
      '3',
      '--ledgermind-tool-loop-max-grep-calls',
      '2',
      '--ledgermind-tool-loop-max-added-tokens',
      '300',
    ]);

    expect(config.ledgermindToolLoopMaxSteps).toBe(7);
    expect(config.ledgermindToolLoopMaxDescribeCalls).toBe(4);
    expect(config.ledgermindToolLoopMaxExploreArtifactCalls).toBe(3);
    expect(config.ledgermindToolLoopMaxExpandCalls).toBe(3);
    expect(config.ledgermindToolLoopMaxGrepCalls).toBe(2);
    expect(config.ledgermindToolLoopMaxAddedTokens).toBe(300);

    expect(config.fairnessFingerprintInputs.ledgermindToolLoopMaxSteps).toBe(7);
    expect(config.fairnessFingerprintInputs.ledgermindToolLoopMaxDescribeCalls).toBe(4);
    expect(config.fairnessFingerprintInputs.ledgermindToolLoopMaxExploreArtifactCalls).toBe(3);
    expect(config.fairnessFingerprintInputs.ledgermindToolLoopMaxExpandCalls).toBe(3);
    expect(config.fairnessFingerprintInputs.ledgermindToolLoopMaxGrepCalls).toBe(2);
    expect(config.fairnessFingerprintInputs.ledgermindToolLoopMaxAddedTokens).toBe(300);
    expect(config.fairnessFingerprintInputs.locomoArtifactMappingVersion).toBe('blip_caption_text_artifact_v1');
  });

  it('rejects tool-loop limits when an individual tool limit exceeds total steps', () => {
    expect(() =>
      buildBenchmarkConfig([
        '--runtime-mode',
        'agentic_loop',
        '--ledgermind-tool-loop-max-steps',
        '2',
        '--ledgermind-tool-loop-max-describe-calls',
        '3',
        '--ledgermind-tool-loop-max-explore-artifact-calls',
        '1',
        '--ledgermind-tool-loop-max-expand-calls',
        '1',
        '--ledgermind-tool-loop-max-grep-calls',
        '1',
      ]),
    ).toThrow('--ledgermind-tool-loop-max-steps must be >= each individual tool-call limit');
  });
});
