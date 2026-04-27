import type { MemoryEngine } from '@ledgermind/application';
import type { PgExecutor } from '@ledgermind/infrastructure';

import { createMemoryEngine, type MemoryEngineConfig } from '../index';

export type PostgresPresetConfig = Omit<MemoryEngineConfig, 'storage'> & {
  readonly connectionString: string;
  readonly executor?: PgExecutor;
};

export const createPostgresMemoryEngine = ({
  connectionString,
  executor,
  ...config
}: PostgresPresetConfig): MemoryEngine => {
  if (connectionString.trim().length === 0) {
    throw new Error('Postgres connectionString is required and cannot be empty.');
  }

  return createMemoryEngine({
    storage: {
      type: 'postgres',
      connectionString,
      ...(executor === undefined ? {} : { executor }),
    },
    ...config,
  });
};
