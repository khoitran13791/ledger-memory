import { describe, expect, it, vi } from 'vitest';

import type {
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  GrepInput,
  GrepOutput,
  MemoryEngine,
  ToolAccessLevel,
} from '@ledgermind/application';
import { createConversationId, createTokenCount } from '@ledgermind/domain';

type MinimalMemoryEngine = Pick<MemoryEngine, 'grep' | 'describe' | 'expand'>;

interface CanonicalMemoryTool {
  readonly name: string;
  readonly access: ToolAccessLevel;
  readonly requiresApproval: boolean;
  readonly subAgentOnly: boolean;
  readonly idempotent: boolean;
  execute(input: unknown): Promise<unknown>;
}

const CANONICAL_TOOL_CATALOG_MODULE_PATH = '../canonical-memory-tool-catalog';

const loadCreateCanonicalMemoryToolCatalog = async (): Promise<
  (engine: MemoryEngine) => readonly CanonicalMemoryTool[]
> => {
  const module = (await import(CANONICAL_TOOL_CATALOG_MODULE_PATH)) as {
    readonly createCanonicalMemoryToolCatalog: (engine: MemoryEngine) => readonly CanonicalMemoryTool[];
  };

  return module.createCanonicalMemoryToolCatalog;
};

const createMinimalEngine = (): {
  readonly engine: MinimalMemoryEngine;
  readonly grep: ReturnType<typeof vi.fn<(input: GrepInput) => Promise<GrepOutput>>>;
  readonly describe: ReturnType<typeof vi.fn<(input: DescribeInput) => Promise<DescribeOutput>>>;
  readonly expand: ReturnType<typeof vi.fn<(input: ExpandInput) => Promise<ExpandOutput>>>;
} => {
  const grep = vi.fn(async (_input: GrepInput): Promise<GrepOutput> => {
    void _input;
    return {
      matches: [],
    };
  });

  const describe = vi.fn(async (_input: DescribeInput): Promise<DescribeOutput> => {
    void _input;
    return {
      kind: 'summary',
      metadata: {},
      tokenCount: createTokenCount(1),
    };
  });

  const expand = vi.fn(async (_input: ExpandInput): Promise<ExpandOutput> => {
    void _input;
    return {
      messages: [],
    };
  });

  return {
    engine: {
      grep,
      describe,
      expand,
    },
    grep,
    describe,
    expand,
  };
};

const assertPolicyMetadata = (
  value: {
    readonly access: ToolAccessLevel;
    readonly requiresApproval: boolean;
    readonly subAgentOnly: boolean;
    readonly idempotent: boolean;
  },
  expected: {
    readonly access: ToolAccessLevel;
    readonly requiresApproval: boolean;
    readonly subAgentOnly: boolean;
    readonly idempotent: boolean;
  },
): void => {
  expect(value.access).toBe(expected.access);
  expect(value.requiresApproval).toBe(expected.requiresApproval);
  expect(value.subAgentOnly).toBe(expected.subAgentOnly);
  expect(value.idempotent).toBe(expected.idempotent);
};

describe('createCanonicalMemoryToolCatalog', () => {
  it('exposes the canonical read-first memory tools with policy metadata', async () => {
    const { engine } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);

    expect(catalog.map((tool) => tool.name)).toEqual([
      'memory.recall',
      'memory.describe',
      'memory.expand',
    ]);

    const recallTool = catalog[0]!;
    const describeTool = catalog[1]!;
    const expandTool = catalog[2]!;

    assertPolicyMetadata(recallTool, {
      access: 'read',
      requiresApproval: false,
      subAgentOnly: false,
      idempotent: true,
    });
    assertPolicyMetadata(describeTool, {
      access: 'read',
      requiresApproval: false,
      subAgentOnly: false,
      idempotent: true,
    });
    assertPolicyMetadata(expandTool, {
      access: 'privileged',
      requiresApproval: true,
      subAgentOnly: true,
      idempotent: true,
    });
  });

  it('keeps the canonical recall contract scoped to a conversation input', async () => {
    const { engine, grep } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const [recallTool] = createCanonicalMemoryToolCatalog(engine as MemoryEngine);

    await recallTool!.execute({
      conversationId: String(createConversationId('conversation-123')),
      query: 'needle',
    });

    expect(grep).toHaveBeenCalledWith({
      conversationId: createConversationId('conversation-123'),
      pattern: 'needle',
    });
  });
});
