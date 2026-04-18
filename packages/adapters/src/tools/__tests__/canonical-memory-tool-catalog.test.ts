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
  readonly parameters: Record<string, unknown>;
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

const getToolByName = (
  catalog: readonly CanonicalMemoryTool[],
  name: string,
): CanonicalMemoryTool => {
  const tool = catalog.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Expected canonical tool catalog to include ${name}.`);
  }

  return tool;
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
      groups: [],
      page: {
        offset: 0,
        limit: 25,
        returnedMatchCount: 0,
        totalMatchCount: 0,
        hasMore: false,
      },
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

const assertStringArray = (value: unknown): void => {
  expect(Array.isArray(value)).toBe(true);
  for (const item of value as unknown[]) {
    expect(typeof item).toBe('string');
  }
};

const assertReferencesShape = (value: unknown): void => {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);

  const references = value as Record<string, unknown>;
  const keys = Object.keys(references);
  expect(keys.every((key) => ['summaryIds', 'artifactIds', 'eventIds'].includes(key))).toBe(true);

  if ('summaryIds' in references) {
    assertStringArray(references.summaryIds);
  }

  if ('artifactIds' in references) {
    assertStringArray(references.artifactIds);
  }

  if ('eventIds' in references) {
    assertStringArray(references.eventIds);
  }
};

const assertSuccessEnvelope = (value: unknown, expectedData: unknown): Record<string, unknown> => {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);

  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);

  expect(keys).toContain('ok');
  expect(keys).toContain('data');
  expect(keys.every((key) => ['ok', 'data', 'references', 'meta'].includes(key))).toBe(true);

  expect(envelope.ok).toBe(true);
  expect(envelope.data).toEqual(expectedData);

  if ('references' in envelope) {
    assertReferencesShape(envelope.references);
  }

  return envelope;
};

const assertErrorEnvelope = (value: unknown, expectedCode: string): Record<string, unknown> => {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);

  const envelope = value as Record<string, unknown>;
  expect(envelope.ok).toBe(false);

  expect(typeof envelope.error).toBe('object');
  expect(envelope.error).not.toBeNull();
  expect(Array.isArray(envelope.error)).toBe(false);

  const error = envelope.error as Record<string, unknown>;
  expect(error.code).toBe(expectedCode);
  expect(typeof error.message).toBe('string');

  return envelope;
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

  it('keeps the canonical recall contract scoped to a conversation input and forwards pagination', async () => {
    const { engine, grep } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const recallTool = getToolByName(catalog, 'memory.recall');

    expect(recallTool.parameters).toMatchObject({
      properties: {
        offset: {
          type: 'integer',
          minimum: 0,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
        },
      },
    });

    await recallTool.execute({
      conversationId: String(createConversationId('conversation-123')),
      query: 'needle',
      scope: 'sum_scope_123',
      offset: 4,
      limit: 10,
    });

    expect(grep).toHaveBeenCalledWith({
      conversationId: createConversationId('conversation-123'),
      pattern: 'needle',
      scope: 'sum_scope_123',
      offset: 4,
      limit: 10,
    });
  });

  it('returns a Vercel-compatible success envelope for describe results with provenance references', async () => {
    const { engine, describe } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    describe.mockResolvedValueOnce({
      kind: 'summary',
      metadata: {},
      tokenCount: createTokenCount(1),
      references: {
        summaryIds: ['sum_parent_1', false],
        artifactIds: ['file_2', 2],
        eventIds: ['evt_describe_1', null],
      },
    } as unknown as DescribeOutput);

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const describeTool = getToolByName(catalog, 'memory.describe');

    const result = await describeTool.execute({ id: 'sum_123' });

    expect(describe).toHaveBeenCalledWith({ id: 'sum_123' });
    const envelope = assertSuccessEnvelope(result, {
      kind: 'summary',
      metadata: {},
      tokenCount: { value: 1 },
      references: {
        summaryIds: ['sum_parent_1', false],
        artifactIds: ['file_2', 2],
        eventIds: ['evt_describe_1', null],
      },
    });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_parent_1', 'sum_123'],
      artifactIds: ['file_2'],
      eventIds: ['evt_describe_1'],
    });
  });

  it('returns a Vercel-compatible success envelope for expand results with derived references', async () => {
    const { engine, expand } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    expand.mockResolvedValueOnce({
      messages: [
        {
          id: 'evt_expand_3',
          metadata: {
            artifactIds: ['file_7', { id: 'file_8' }],
            artifacts: [{ id: 'file_9' }],
          },
        },
      ],
    } as unknown as ExpandOutput);

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const expandTool = getToolByName(catalog, 'memory.expand');

    const result = await expandTool.execute({
      summaryId: 'sum_leaf_2',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
      },
    });

    expect(expand).toHaveBeenCalledWith({
      summaryId: 'sum_leaf_2',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
      },
    });
    const envelope = assertSuccessEnvelope(result, {
      messages: [
        {
          id: 'evt_expand_3',
          metadata: {
            artifactIds: ['file_7', { id: 'file_8' }],
            artifacts: [{ id: 'file_9' }],
          },
        },
      ],
    });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_leaf_2'],
      artifactIds: ['file_7', 'file_8', 'file_9'],
      eventIds: ['evt_expand_3'],
    });
  });

  it.each([
    ['missing callerContext', { summaryId: 'sum_leaf_1' }],
    ['non-object callerContext', { summaryId: 'sum_leaf_1', callerContext: 'invalid' }],
    ['missing conversationId', { summaryId: 'sum_leaf_1', callerContext: { isSubAgent: true } }],
    ['missing isSubAgent', { summaryId: 'sum_leaf_1', callerContext: { conversationId: 'conv_2' } }],
  ])('preserves expand input validation for %s', async (_case, payload) => {
    const { engine, expand } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const expandTool = getToolByName(catalog, 'memory.expand');

    const result = await expandTool.execute(payload);

    const envelope = assertErrorEnvelope(result, 'TOOL_EXECUTION_FAILED');
    expect((envelope.error as Record<string, unknown>).message).toContain('memory.expand');
    expect(expand).not.toHaveBeenCalled();
  });
});
