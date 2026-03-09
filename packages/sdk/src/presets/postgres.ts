import type { MemoryEngine } from '@ledgermind/application';

import { createMemoryEngine, type MemoryEngineConfig } from '../index';

export type PostgresPresetConfig = Omit<MemoryEngineConfig, 'storage'> & {
  readonly connectionString: string;
};

export const createPostgresMemoryEngine = ({
  connectionString,
  ...config
}: PostgresPresetConfig): MemoryEngine => {
  if (connectionString.trim().length === 0) {
    throw new Error('Postgres connectionString is required and cannot be empty.');
  }

  return createMemoryEngine({
    storage: { type: 'postgres', connectionString },
    ...config,
  });
};
