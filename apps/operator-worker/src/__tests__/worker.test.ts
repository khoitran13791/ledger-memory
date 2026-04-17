import { describe, expect, it } from 'vitest';

import { createOperatorWorker } from '../worker';

describe('createOperatorWorker', () => {
  it('fails fast when required runtime executors are missing for durable execution', () => {
    expect(() =>
      createOperatorWorker({
        config: {
          storage: {
            type: 'postgres',
            connectionString: 'postgres://localhost/ledgermind',
          },
          pollIntervalMs: 100,
          batchSize: 1,
          workerId: 'worker-test',
        },
      }),
    ).toThrow('Operator worker requires a structuredGeneration executor for llmMap tasks.');
  });
});
