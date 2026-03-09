import type { MemoryEngine } from '@ledgermind/application';

import { createMemoryEngine, type MemoryEngineConfig } from '../index';

export type InMemoryPresetConfig = Omit<MemoryEngineConfig, 'storage'>;

export const createInMemoryMemoryEngine = (
  config: InMemoryPresetConfig = {},
): MemoryEngine =>
  createMemoryEngine({
    storage: { type: 'in-memory' },
    ...config,
  });
