import { describe, expect, it } from 'vitest';

import { buildBenchmarkConfig } from './config.js';

describe('buildBenchmarkConfig', () => {
  it('uses static_materialize and the longmemeval runs directory by default', () => {
    const config = buildBenchmarkConfig([]);

    expect(config.runtimeMode).toBe('static_materialize');
    expect(config.baselines).toEqual([
      'full_history_upper_bound',
      'ledgermind_static_materialize',
      'ledgermind_agentic_loop',
    ]);
    expect(config.outputDir).toContain('benchmarks/longmemeval/runs/');
    expect(config.smoke).toBe(false);
    expect(config.canary).toBe(false);
  });

  it('enables smoke mode via --smoke', () => {
    const config = buildBenchmarkConfig(['--smoke']);

    expect(config.smoke).toBe(true);
    expect(config.canary).toBe(false);
  });

  it('enables canary mode via --canary', () => {
    const config = buildBenchmarkConfig(['--canary']);

    expect(config.canary).toBe(true);
    expect(config.smoke).toBe(false);
  });

  it('rejects combining --smoke and --canary', () => {
    expect(() => buildBenchmarkConfig(['--smoke', '--canary'])).toThrow(
      'Cannot combine --smoke and --canary in the same run.',
    );
  });
});
