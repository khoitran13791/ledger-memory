import { describe, expect, it } from 'vitest';

import type { MemoryEngine } from '@ledgermind/application';
import { createTokenCount } from '@ledgermind/domain';

import {
  createVercelMemoryTools,
  createVercelTools,
  VercelAiMemoryToolsAdapter,
} from '@ledgermind/adapters';

describe('tools public exports', () => {
  it('exposes Vercel memory tool adapter APIs from @ledgermind/adapters root', () => {
    const engine = {
      grep: async () => ({ matches: [] }),
      describe: async () => ({
        kind: 'summary' as const,
        metadata: {},
        tokenCount: createTokenCount(1),
      }),
      expand: async () => ({ messages: [] }),
    } as Pick<MemoryEngine, 'grep' | 'describe' | 'expand'>;

    const tools = createVercelMemoryTools(engine as MemoryEngine);
    const aliasTools = createVercelTools(engine as MemoryEngine);
    const adapterTools = new VercelAiMemoryToolsAdapter().createTools(engine as MemoryEngine);

    expect(Object.keys(tools).sort()).toEqual(['memory.describe', 'memory.expand', 'memory.grep']);
    expect(Object.keys(aliasTools).sort()).toEqual(['memory.describe', 'memory.expand', 'memory.grep']);
    expect(adapterTools.map((tool) => tool.name)).toEqual([
      'memory.grep',
      'memory.describe',
      'memory.expand',
    ]);
  });
});
