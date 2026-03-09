import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactNotFoundError,
  ConversationNotFoundError,
  InvalidReferenceError,
  UnauthorizedExpandError,
  type DescribeInput,
  type DescribeOutput,
  type ExpandInput,
  type ExpandOutput,
  type GrepInput,
  type GrepOutput,
  type MemoryEngine,
} from '@ledgermind/application';
import {
  createArtifactId,
  createConversationId,
  createEventId,
  createSequenceNumber,
  createSummaryNodeId,
  createTokenCount,
} from '@ledgermind/domain';

import {
  createVercelMemoryTools,
  createVercelTools,
  VercelAiMemoryToolsAdapter,
} from '../vercel-ai-memory-tools.adapter';

type MinimalMemoryEngine = Pick<MemoryEngine, 'grep' | 'describe' | 'expand'>;

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

const getToolSetTool = (
  tools: Record<string, unknown>,
  name: string,
): { execute: (input: unknown) => Promise<unknown> | unknown } => {
  const candidate = tools[name];
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(`Expected tool ${name} to be an object.`);
  }

  const execute = (candidate as { execute?: unknown }).execute;
  if (typeof execute !== 'function') {
    throw new Error(`Expected tool ${name} to expose execute().`);
  }

  return {
    execute: execute as (input: unknown) => Promise<unknown> | unknown,
  };
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

const assertSuccessEnvelope = (
  value: unknown,
  expectedData: unknown,
): Record<string, unknown> => {
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

  if ('meta' in envelope && envelope.meta !== undefined) {
    expect(typeof envelope.meta).toBe('object');
    expect(envelope.meta).not.toBeNull();
    expect(Array.isArray(envelope.meta)).toBe(false);
  }

  return envelope;
};

const assertErrorEnvelope = (value: unknown, expectedCode: string): Record<string, unknown> => {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);

  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);

  expect(keys).toContain('ok');
  expect(keys).toContain('error');
  expect(keys.every((key) => ['ok', 'error', 'references'].includes(key))).toBe(true);

  expect(envelope.ok).toBe(false);

  expect(typeof envelope.error).toBe('object');
  expect(envelope.error).not.toBeNull();
  expect(Array.isArray(envelope.error)).toBe(false);

  const error = envelope.error as Record<string, unknown>;
  const errorKeys = Object.keys(error);
  expect(errorKeys).toContain('code');
  expect(errorKeys).toContain('message');
  expect(errorKeys.every((key) => ['code', 'message', 'details'].includes(key))).toBe(true);

  expect(error.code).toBe(expectedCode);
  expect(typeof error.message).toBe('string');
  expect((error.message as string).length).toBeGreaterThan(0);

  if ('details' in error && error.details !== undefined) {
    expect(typeof error.details).toBe('object');
    expect(error.details).not.toBeNull();
    expect(Array.isArray(error.details)).toBe(false);
  }

  if ('references' in envelope) {
    assertReferencesShape(envelope.references);
  }

  return envelope;
};

describe('createVercelMemoryTools', () => {
  it('returns a Vercel AI SDK-native tool bundle object', () => {
    const { engine } = createMinimalEngine();

    const tools = createVercelMemoryTools(engine as MemoryEngine);

    expect(Array.isArray(tools)).toBe(false);
    expect(Object.keys(tools).sort()).toEqual([
      'memory.describe',
      'memory.expand',
      'memory.grep',
    ]);
  });

  it('fails fast when engine is missing or invalid', () => {
    expect(() => createVercelMemoryTools(undefined as unknown as MemoryEngine)).toThrow(TypeError);
    expect(() => createVercelMemoryTools(null as unknown as MemoryEngine)).toThrow(TypeError);
    expect(() => createVercelMemoryTools({} as MemoryEngine)).toThrow(TypeError);

    expect(() =>
      createVercelMemoryTools({
        grep: async (): Promise<GrepOutput> => ({ matches: [] }),
        describe: async (): Promise<DescribeOutput> => ({
          kind: 'summary',
          metadata: {},
          tokenCount: createTokenCount(1),
        }),
      } as unknown as MemoryEngine),
    ).toThrow(TypeError);

    expect(() =>
      createVercelMemoryTools({
        grep: 'not-a-function',
        describe: async (): Promise<DescribeOutput> => ({
          kind: 'summary',
          metadata: {},
          tokenCount: createTokenCount(1),
        }),
        expand: async (): Promise<ExpandOutput> => ({ messages: [] }),
      } as unknown as MemoryEngine),
    ).toThrow(TypeError);
  });

  it('returns stable callable definitions for grep, describe, and expand', () => {
    const { engine } = createMinimalEngine();

    const first = createVercelMemoryTools(engine as MemoryEngine);
    const second = createVercelMemoryTools(engine as MemoryEngine);

    expect(Object.keys(first).sort()).toEqual([
      'memory.describe',
      'memory.expand',
      'memory.grep',
    ]);
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());

    for (const [name, candidate] of Object.entries(first)) {
      expect(name.length).toBeGreaterThan(0);
      expect(typeof candidate).toBe('object');
      expect(candidate).not.toBeNull();
      expect(typeof (candidate as { execute?: unknown }).execute).toBe('function');
    }
  });

  it('exposes stable Vercel alias helper', () => {
    const { engine } = createMinimalEngine();

    const canonical = createVercelMemoryTools(engine as MemoryEngine);
    const alias = createVercelTools(engine as MemoryEngine);

    expect(Object.keys(alias).sort()).toEqual(Object.keys(canonical).sort());
  });

  it('returns canonical success envelope for grep execution', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_1',
      pattern: 'alpha',
      scope: 'sum_scope_1',
    });

    expect(grep).toHaveBeenCalledTimes(1);
    expect(grep).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      pattern: 'alpha',
      scope: 'sum_scope_1',
    });

    const envelope = assertSuccessEnvelope(result, { matches: [] });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_scope_1'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('preserves grep match event identifiers when available', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    grep.mockResolvedValueOnce({
      matches: [
        {
          eventId: createEventId('evt_100'),
          sequence: createSequenceNumber(1),
          excerpt: 'alpha',
        },
        {
          eventId: createEventId('evt_101'),
          sequence: createSequenceNumber(2),
          excerpt: 'beta',
        },
      ],
    });

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_1',
      pattern: 'alpha',
    });

    const envelope = assertSuccessEnvelope(result, {
      matches: [
        {
          eventId: createEventId('evt_100'),
          sequence: createSequenceNumber(1),
          excerpt: 'alpha',
        },
        {
          eventId: createEventId('evt_101'),
          sequence: createSequenceNumber(2),
          excerpt: 'beta',
        },
      ],
    });
    expect(envelope.references).toEqual({
      eventIds: ['evt_100', 'evt_101'],
    });
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('returns canonical success envelope for describe execution', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'sum_123' });

    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe).toHaveBeenCalledWith({ id: 'sum_123' });

    const envelope = assertSuccessEnvelope(result, {
      kind: 'summary',
      metadata: {},
      tokenCount: { value: 1 },
    });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_123'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('derives artifact references for artifact describe results', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    describe.mockResolvedValueOnce({
      kind: 'artifact',
      metadata: {},
      tokenCount: createTokenCount(2),
    });

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'file_9' });

    const envelope = assertSuccessEnvelope(result, {
      kind: 'artifact',
      metadata: {},
      tokenCount: { value: 2 },
    });
    expect(envelope.references).toEqual({
      artifactIds: ['file_9'],
    });
  });

  it('preserves summary, artifact, and event references when grep output provides them', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const grepOutputWithReferences = {
      matches: [],
      references: {
        summaryIds: ['sum_scope_1', 1],
        artifactIds: ['file_1', null],
        eventIds: ['evt_1', {}],
      },
    } as unknown as GrepOutput;

    grep.mockResolvedValueOnce(grepOutputWithReferences);

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_1',
      pattern: 'alpha',
      scope: 'sum_scope_1',
    });

    expect(grep).toHaveBeenCalledTimes(1);
    expect(grep).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      pattern: 'alpha',
      scope: 'sum_scope_1',
    });

    const envelope = assertSuccessEnvelope(result, grepOutputWithReferences);
    expect(envelope.references).toEqual({
      summaryIds: ['sum_scope_1'],
      artifactIds: ['file_1'],
      eventIds: ['evt_1'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('preserves summary, artifact, and event references when describe output provides them', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const describeOutputWithReferences = {
      kind: 'summary',
      metadata: {},
      tokenCount: createTokenCount(1),
      references: {
        summaryIds: ['sum_parent_1', false],
        artifactIds: ['file_2', 2],
        eventIds: ['evt_describe_1', null],
      },
    } as unknown as DescribeOutput;

    describe.mockResolvedValueOnce(describeOutputWithReferences);

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'sum_123' });

    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe).toHaveBeenCalledWith({ id: 'sum_123' });

    const envelope = assertSuccessEnvelope(result, describeOutputWithReferences);
    expect(envelope.references).toEqual({
      summaryIds: ['sum_parent_1', 'sum_123'],
      artifactIds: ['file_2'],
      eventIds: ['evt_describe_1'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('returns canonical success envelope for expand execution', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
        parentConversationId: 'conv_parent_1',
      },
    });

    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith({
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
        parentConversationId: 'conv_parent_1',
      },
    });

    const envelope = assertSuccessEnvelope(result, { messages: [] });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_leaf_1'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it.each([
    ['missing callerContext', { summaryId: 'sum_leaf_1' }],
    ['non-object callerContext', { summaryId: 'sum_leaf_1', callerContext: 'invalid' }],
    ['missing conversationId', { summaryId: 'sum_leaf_1', callerContext: { isSubAgent: true } }],
    ['missing isSubAgent', { summaryId: 'sum_leaf_1', callerContext: { conversationId: 'conv_2' } }],
    [
      'non-boolean isSubAgent',
      { summaryId: 'sum_leaf_1', callerContext: { conversationId: 'conv_2', isSubAgent: 'true' } },
    ],
  ])('returns TOOL_EXECUTION_FAILED when expand caller context is invalid: %s', async (_case, payload) => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute(payload);

    const envelope = assertErrorEnvelope(result, 'TOOL_EXECUTION_FAILED');
    expect((envelope.error as Record<string, unknown>).message).toContain('memory.expand');
    expect(expand).not.toHaveBeenCalled();
  });

  it('preserves expanded event identifiers in success payload', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const expandOutput = {
      messages: [
        { id: 'evt_expand_1', content: 'first' },
        { id: 'evt_expand_2', content: 'second' },
      ],
    } as unknown as ExpandOutput;

    expand.mockResolvedValueOnce(expandOutput);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
      },
    });

    const envelope = assertSuccessEnvelope(result, expandOutput);
    const data = envelope.data as { messages: Array<{ id: string }> };
    expect(data.messages.map((message) => message.id)).toEqual(['evt_expand_1', 'evt_expand_2']);
    expect(envelope.references).toEqual({
      summaryIds: ['sum_leaf_1'],
      eventIds: ['evt_expand_1', 'evt_expand_2'],
    });
  });

  it('preserves summary, artifact, and event references when expand output provides them', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const expandOutputWithReferences = {
      messages: [{ id: 'evt_expand_1', content: 'first' }],
      references: {
        summaryIds: ['sum_leaf_1', 1],
        artifactIds: ['file_1', null],
        eventIds: ['evt_expand_1', {}],
      },
    } as unknown as ExpandOutput;

    expand.mockResolvedValueOnce(expandOutputWithReferences);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
      },
    });

    const envelope = assertSuccessEnvelope(result, expandOutputWithReferences);
    expect(envelope.references).toEqual({
      summaryIds: ['sum_leaf_1'],
      artifactIds: ['file_1'],
      eventIds: ['evt_expand_1'],
    });
  });

  it('derives artifact references from expand message metadata', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    const expandOutput = {
      messages: [
        {
          id: 'evt_expand_3',
          metadata: {
            artifactIds: ['file_7', { id: 'file_8' }],
            artifacts: [{ id: 'file_9' }],
          },
        },
      ],
    } as unknown as ExpandOutput;

    expand.mockResolvedValueOnce(expandOutput);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({
      summaryId: 'sum_leaf_2',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: true,
      },
    });

    const envelope = assertSuccessEnvelope(result, expandOutput);
    expect(envelope.references).toEqual({
      summaryIds: ['sum_leaf_2'],
      artifactIds: ['file_7', 'file_8', 'file_9'],
      eventIds: ['evt_expand_3'],
    });
  });

  it('maps UnauthorizedExpandError to UNAUTHORIZED_EXPAND envelope', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    expand.mockRejectedValueOnce(
      new UnauthorizedExpandError(createConversationId('conv_denied'), createSummaryNodeId('sum_denied')),
    );

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({
      summaryId: 'sum_denied',
      callerContext: {
        conversationId: 'conv_denied',
        isSubAgent: false,
      },
    });

    const envelope = assertErrorEnvelope(result, 'UNAUTHORIZED_EXPAND');
    expect(Object.keys(envelope).every((key) => ['ok', 'error', 'references'].includes(key))).toBe(true);
    expect((envelope.error as Record<string, unknown>).details).toEqual({
      conversationId: 'conv_denied',
      summaryId: 'sum_denied',
    });
    expect((envelope as Record<string, unknown>).data).toBeUndefined();
  });

  it('maps InvalidReferenceError to INVALID_REFERENCE envelope', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    grep.mockRejectedValueOnce(new InvalidReferenceError('summary_scope', 'sum_missing'));

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_1',
      pattern: 'alpha',
      scope: 'sum_missing',
    });

    const envelope = assertErrorEnvelope(result, 'INVALID_REFERENCE');
    expect((envelope.error as Record<string, unknown>).details).toEqual({
      referenceKind: 'summary_scope',
      referenceId: 'sum_missing',
    });
  });

  it('maps invalid artifact reference to INVALID_REFERENCE envelope', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    describe.mockRejectedValueOnce(new InvalidReferenceError('artifact', 'file_missing'));

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'file_missing' });

    const envelope = assertErrorEnvelope(result, 'INVALID_REFERENCE');
    expect((envelope.error as Record<string, unknown>).details).toEqual({
      referenceKind: 'artifact',
      referenceId: 'file_missing',
    });
  });

  it('maps ArtifactNotFoundError to ARTIFACT_NOT_FOUND envelope', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    describe.mockRejectedValueOnce(new ArtifactNotFoundError(createArtifactId('file_missing')));

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'file_missing' });

    const envelope = assertErrorEnvelope(result, 'ARTIFACT_NOT_FOUND');
    expect((envelope.error as Record<string, unknown>).details).toEqual({
      artifactId: 'file_missing',
    });
  });

  it('maps ConversationNotFoundError to CONVERSATION_NOT_FOUND envelope', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    grep.mockRejectedValueOnce(new ConversationNotFoundError(createConversationId('conv_missing')));

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_missing',
      pattern: 'alpha',
    });

    const envelope = assertErrorEnvelope(result, 'CONVERSATION_NOT_FOUND');
    expect((envelope.error as Record<string, unknown>).details).toEqual({
      conversationId: 'conv_missing',
    });
  });

  it('maps unknown errors to TOOL_EXECUTION_FAILED envelope', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine);

    describe.mockRejectedValueOnce(new Error('unexpected failure'));

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'sum_123' });

    const envelope = assertErrorEnvelope(result, 'TOOL_EXECUTION_FAILED');
    expect((envelope.error as Record<string, unknown>).details).toBeUndefined();
  });
});

describe('VercelAiMemoryToolsAdapter', () => {
  it('creates the same required memory tools via ToolProviderPort', () => {
    const { engine } = createMinimalEngine();
    const adapter = new VercelAiMemoryToolsAdapter();

    const tools = adapter.createTools(engine as MemoryEngine);

    expect(tools.map((tool) => tool.name)).toEqual([
      'memory.grep',
      'memory.describe',
      'memory.expand',
    ]);
  });
});
