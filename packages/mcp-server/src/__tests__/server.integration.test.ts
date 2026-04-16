import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  GrepInput,
  GrepOutput,
  MemoryEngine,
} from '@ledgermind/application';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLedgermindMcpServer } from '../server';

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
    return ({
      kind: 'summary',
      metadata: { topic: 'auth' },
      tokenCount: { value: 2 } as DescribeOutput['tokenCount'],
      references: {
        summaryIds: ['sum_parent_1'],
      },
    }) as unknown as DescribeOutput;
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLedgermindMcpServer', () => {
  it('serves canonical tools and returns structured content for describe calls', async () => {
    const { engine, describe } = createMinimalEngine();
    const runtime = createLedgermindMcpServer({
      config: {
        storage: { type: 'in-memory' },
        enableWriteTools: false,
        readOnly: true,
      },
      engine: engine as MemoryEngine,
    });

    const client = new Client(
      { name: 'ledgermind-mcp-server-test', version: '0.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), runtime.server.connect(serverTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'memory.recall',
      'memory.describe',
      'memory.expand',
    ]);

    const result = await client.callTool({
      name: 'memory.describe',
      arguments: { id: 'sum_123' },
    });

    expect(describe).toHaveBeenCalledWith({ id: 'sum_123' });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      references: {
        summaryIds: ['sum_parent_1', 'sum_123'],
      },
    });
    expect((result.content as Array<{ type: string }>)[0]).toMatchObject({
      type: 'text',
    });
    expect(result.isError).toBeUndefined();

    await Promise.all([client.close(), runtime.server.close()]);
  });
});
