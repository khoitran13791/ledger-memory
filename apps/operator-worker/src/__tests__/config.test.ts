import { describe, expect, it } from 'vitest';

import { parseOperatorWorkerConfig, validateOperatorWorkerRuntime } from '../config';

describe('parseOperatorWorkerConfig', () => {
  it('parses poll interval, batch size, worker id, and postgres connection string', () => {
    const config = parseOperatorWorkerConfig({
      argv: [
        '--db',
        'postgres://localhost/ledgermind',
        '--poll-interval-ms',
        '250',
        '--batch-size',
        '4',
        '--worker-id',
        'worker-a',
      ],
    });

    expect(config.storage).toEqual({
      type: 'postgres',
      connectionString: 'postgres://localhost/ledgermind',
    });
    expect(config.pollIntervalMs).toBe(250);
    expect(config.batchSize).toBe(4);
    expect(config.workerId).toBe('worker-a');
  });

  it('fails with an actionable error when durable llmMap runtime executors are missing', () => {
    expect(() =>
      validateOperatorWorkerRuntime({
        config: parseOperatorWorkerConfig({
          argv: ['--db', 'postgres://localhost/ledgermind'],
        }),
      }),
    ).toThrow('Operator worker requires a structuredGeneration executor for llmMap tasks.');
  });
});
