import { describe, expect, it, vi } from 'vitest';

import type {
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  GrepInput,
  GrepOutput,
  MemoryEngine,
} from '@ledgermind/application';
import { createCanonicalMemoryToolCatalog } from '@ledgermind/adapters';

import { createMcpToolRegistry } from '../tool-registry';

type MinimalMemoryEngine = Pick<MemoryEngine, 'grep' | 'describe' | 'expand'>;

const createMinimalEngine = (): {
  readonly engine: MinimalMemoryEngine;
  readonly grep: ReturnType<typeof vi.fn<(input: GrepInput) => Promise<GrepOutput>>>;
  readonly describe: ReturnType<typeof vi.fn<(input: DescribeInput) => Promise<DescribeOutput>>>;
  readonly expand: ReturnType<typeof vi.fn<(input: ExpandInput) => Promise<ExpandOutput>>>;
} => {
  const grep = vi.fn(async (input: GrepInput): Promise<GrepOutput> => {
    void input;
    return { matches: [] };
  });
  const describe = vi.fn(async (input: DescribeInput): Promise<DescribeOutput> => {
    void input;
    return {
      kind: 'summary',
      metadata: {},
      tokenCount: { value: 1 } as DescribeOutput['tokenCount'],
    };
  });
  const expand = vi.fn(async (input: ExpandInput): Promise<ExpandOutput> => {
    void input;
    return { messages: [] };
  });

  return {
    engine: { grep, describe, expand },
    grep,
    describe,
    expand,
  };
};

describe('createMcpToolRegistry', () => {
  it('registers the canonical memory tools with matching MCP schemas', () => {
    const { engine } = createMinimalEngine();
    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);

    const registry = createMcpToolRegistry(catalog);

    expect(registry.map((entry) => entry.tool.name)).toEqual([
      'memory.recall',
      'memory.describe',
      'memory.expand',
    ]);

    expect(registry.map((entry) => entry.tool.inputSchema)).toEqual(catalog.map((tool) => tool.parameters));
  });
});
