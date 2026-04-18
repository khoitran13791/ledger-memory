import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactNotFoundError,
  ConversationNotFoundError,
  InvalidReferenceError,
  type CallerContext,
  type AgenticMapInput,
  type AgenticMapOutput,
  type DescribeInput,
  type DescribeOutput,
  type ExpandInput,
  type ExpandOutput,
  type GetOperatorRunInput,
  type GetOperatorRunOutput,
  type GrepInput,
  type GrepOutput,
  type LLMMapInput,
  type LLMMapOutput,
  type MemoryEngine,
  type ToolRuntimeContextProvider,
  UnauthorizedExpandError,
} from '@ledgermind/application';
import {
  createArtifactId,
  createConversationId,
  createEventId,
  createSequenceNumber,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import {
  createVercelMemoryTools,
  createVercelTools,
  VercelAiMemoryToolsAdapter,
} from '../vercel-ai-memory-tools.adapter';

type MinimalMemoryEngine = Pick<
  MemoryEngine,
  'grep' | 'describe' | 'expand' | 'llmMap' | 'agenticMap' | 'getOperatorRun'
>;

const runtimeCallerContext: CallerContext = {
  conversationId: createConversationId('conv_runtime'),
  isSubAgent: true,
  parentConversationId: createConversationId('conv_parent'),
};

const runtime: ToolRuntimeContextProvider = {
  getCallerContext: () => runtimeCallerContext,
};

const createMinimalEngine = (): {
  readonly engine: MinimalMemoryEngine;
  readonly grep: ReturnType<typeof vi.fn<(input: GrepInput) => Promise<GrepOutput>>>;
  readonly describe: ReturnType<typeof vi.fn<(input: DescribeInput) => Promise<DescribeOutput>>>;
  readonly expand: ReturnType<typeof vi.fn<(input: ExpandInput) => Promise<ExpandOutput>>>;
  readonly llmMap: ReturnType<typeof vi.fn<(input: LLMMapInput) => Promise<LLMMapOutput>>>;
  readonly agenticMap: ReturnType<typeof vi.fn<(input: AgenticMapInput) => Promise<AgenticMapOutput>>>;
  readonly getOperatorRun: ReturnType<typeof vi.fn<(input: GetOperatorRunInput) => Promise<GetOperatorRunOutput>>>;
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

  const llmMap = vi.fn(async (_input: LLMMapInput): Promise<LLMMapOutput> => {
    void _input;
    return {
      runId: 'run_llm_001',
      status: 'pending',
    };
  });

  const agenticMap = vi.fn(async (_input: AgenticMapInput): Promise<AgenticMapOutput> => {
    void _input;
    return {
      runId: 'run_agent_001',
      status: 'running',
    };
  });

  const getOperatorRun = vi.fn(async (_input: GetOperatorRunInput): Promise<GetOperatorRunOutput> => {
    void _input;
    return {
      runId: 'run_agent_001',
      conversationId: runtimeCallerContext.conversationId,
      operatorKind: 'agenticMap',
      status: 'completed',
      createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
      updatedAt: createTimestamp(new Date('2026-04-13T00:00:01.000Z')),
      taskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      retryableFailureTaskCount: 0,
      runningTaskCount: 0,
      pendingTaskCount: 0,
      tasks: [],
    };
  });

  return {
    engine: {
      grep,
      describe,
      expand,
      llmMap,
      agenticMap,
      getOperatorRun,
    },
    grep,
    describe,
    expand,
    llmMap,
    agenticMap,
    getOperatorRun,
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
  expect(
    keys.every((key) => ['summaryIds', 'artifactIds', 'eventIds', 'conversationIds', 'operatorRunIds'].includes(key)),
  ).toBe(true);

  if ('summaryIds' in references) {
    assertStringArray(references.summaryIds);
  }

  if ('artifactIds' in references) {
    assertStringArray(references.artifactIds);
  }

  if ('eventIds' in references) {
    assertStringArray(references.eventIds);
  }

  if ('conversationIds' in references) {
    assertStringArray(references.conversationIds);
  }

  if ('operatorRunIds' in references) {
    assertStringArray(references.operatorRunIds);
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

    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    expect(Array.isArray(tools)).toBe(false);
    expect(Object.keys(tools).sort()).toEqual([
      'memory.agenticMap',
      'memory.describe',
      'memory.expand',
      'memory.getOperatorRun',
      'memory.grep',
      'memory.llmMap',
    ]);
  });

  it('fails fast when engine is missing or invalid', () => {
    expect(() => createVercelMemoryTools(undefined as unknown as MemoryEngine, runtime)).toThrow(TypeError);
    expect(() => createVercelMemoryTools(null as unknown as MemoryEngine, runtime)).toThrow(TypeError);
    expect(() => createVercelMemoryTools({} as MemoryEngine, runtime)).toThrow(TypeError);
    expect(() => createVercelMemoryTools(createMinimalEngine().engine as MemoryEngine, undefined as never)).toThrow(TypeError);

    expect(() =>
      createVercelMemoryTools(
        {
          grep: async (): Promise<GrepOutput> => ({ matches: [] }),
          describe: async (): Promise<DescribeOutput> => ({
            kind: 'summary',
            metadata: {},
            tokenCount: createTokenCount(1),
          }),
        } as unknown as MemoryEngine,
        runtime,
      ),
    ).toThrow(TypeError);

    expect(() =>
      createVercelMemoryTools(
        {
          grep: 'not-a-function',
          describe: async (): Promise<DescribeOutput> => ({
            kind: 'summary',
            metadata: {},
            tokenCount: createTokenCount(1),
          }),
          expand: async (): Promise<ExpandOutput> => ({ messages: [] }),
        } as unknown as MemoryEngine,
        runtime,
      ),
    ).toThrow(TypeError);
  });

  it('returns stable callable definitions for recall, describe, and expand', () => {
    const { engine } = createMinimalEngine();

    const first = createVercelMemoryTools(engine as MemoryEngine, runtime);
    const second = createVercelMemoryTools(engine as MemoryEngine, runtime);

    expect(Object.keys(first).sort()).toEqual([
      'memory.agenticMap',
      'memory.describe',
      'memory.expand',
      'memory.getOperatorRun',
      'memory.grep',
      'memory.llmMap',
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

    const canonical = createVercelMemoryTools(engine as MemoryEngine, runtime);
    const alias = createVercelTools(engine as MemoryEngine, runtime);

    expect(Object.keys(alias).sort()).toEqual(Object.keys(canonical).sort());
  });

  it('returns canonical success envelope for recall execution', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_1',
      query: 'alpha',
      scope: 'sum_scope_1',
    });

    expect(grep).toHaveBeenCalledTimes(1);
    expect(grep).toHaveBeenCalledWith({
      conversationId: runtimeCallerContext.conversationId,
      pattern: 'alpha',
      scope: 'sum_scope_1',
    });

    const envelope = assertSuccessEnvelope(result, { matches: [] });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_scope_1'],
      conversationIds: ['conv_runtime'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('preserves recall match event identifiers when available', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
      query: 'alpha',
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
      conversationIds: ['conv_runtime'],
    });
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('returns canonical success envelope for describe execution', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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

  it('preserves summary, artifact, and event references when recall output provides them', async () => {
    const { engine, grep } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
      query: 'alpha',
      scope: 'sum_scope_1',
    });

    expect(grep).toHaveBeenCalledTimes(1);
    expect(grep).toHaveBeenCalledWith({
      conversationId: runtimeCallerContext.conversationId,
      pattern: 'alpha',
      scope: 'sum_scope_1',
    });

    const envelope = assertSuccessEnvelope(result, grepOutputWithReferences);
    expect(envelope.references).toEqual({
      summaryIds: ['sum_scope_1'],
      artifactIds: ['file_1'],
      eventIds: ['evt_1'],
      conversationIds: ['conv_runtime'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('preserves summary, artifact, and event references when describe output provides them', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_2',
        isSubAgent: false,
        parentConversationId: 'conv_parent_1',
      },
    });

    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith({
      summaryId: 'sum_leaf_1',
      callerContext: runtimeCallerContext,
    });

    const envelope = assertSuccessEnvelope(result, { messages: [] });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_leaf_1'],
      conversationIds: ['conv_runtime'],
    });
    expect(envelope.meta).toBeUndefined();
  });

  it('returns TOOL_EXECUTION_FAILED when expand input is missing summaryId', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    const expandTool = getToolSetTool(tools, 'memory.expand');
    const result = await expandTool.execute({});

    const envelope = assertErrorEnvelope(result, 'TOOL_EXECUTION_FAILED');
    expect((envelope.error as Record<string, unknown>).message).toContain('memory.expand');
    expect(expand).not.toHaveBeenCalled();
  });

  it('preserves expanded event identifiers in success payload', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
      conversationIds: ['conv_runtime'],
    });
  });

  it('preserves summary, artifact, and event references when expand output provides them', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
      conversationIds: ['conv_runtime'],
    });
  });

  it('derives artifact references from expand message metadata', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
      conversationIds: ['conv_runtime'],
    });
  });

  it('maps UnauthorizedExpandError to UNAUTHORIZED_EXPAND envelope', async () => {
    const { engine, expand } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    grep.mockRejectedValueOnce(new InvalidReferenceError('summary_scope', 'sum_missing'));

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_1',
      query: 'alpha',
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
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

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
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    grep.mockRejectedValueOnce(new ConversationNotFoundError(createConversationId('conv_missing')));

    const grepTool = getToolSetTool(tools, 'memory.grep');
    const result = await grepTool.execute({
      conversationId: 'conv_missing',
      query: 'alpha',
    });

    const envelope = assertErrorEnvelope(result, 'CONVERSATION_NOT_FOUND');
    expect((envelope.error as Record<string, unknown>).details).toEqual({
      conversationId: 'conv_missing',
    });
  });

  it('rejects getOperatorRun inspection for runs owned by a different runtime conversation', async () => {
    const { engine, getOperatorRun } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    getOperatorRun.mockResolvedValueOnce({
      runId: 'run_foreign_001',
      conversationId: createConversationId('conv_foreign_owner'),
      operatorKind: 'agenticMap',
      status: 'completed',
      createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
      updatedAt: createTimestamp(new Date('2026-04-13T00:00:01.000Z')),
      taskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      retryableFailureTaskCount: 0,
      runningTaskCount: 0,
      pendingTaskCount: 0,
      tasks: [],
    });

    const getOperatorRunTool = getToolSetTool(tools, 'memory.getOperatorRun');
    const result = await getOperatorRunTool.execute({ runId: 'run_foreign_001' });

    const envelope = assertErrorEnvelope(result, 'TOOL_EXECUTION_FAILED');
    expect((envelope.error as Record<string, unknown>).message).toBe(
      'Operator run does not belong to the bound runtime conversation.',
    );
  });

  it('maps unknown errors to TOOL_EXECUTION_FAILED envelope', async () => {
    const { engine, describe } = createMinimalEngine();
    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);

    describe.mockRejectedValueOnce(new Error('unexpected failure'));

    const describeTool = getToolSetTool(tools, 'memory.describe');
    const result = await describeTool.execute({ id: 'sum_123' });

    const envelope = assertErrorEnvelope(result, 'TOOL_EXECUTION_FAILED');
    expect((envelope.error as Record<string, unknown>).details).toBeUndefined();
  });
});

describe('VercelAiMemoryToolsAdapter', () => {
  it('exposes the runtime-bound tool names and policy metadata', () => {
    const { engine } = createMinimalEngine();
    const adapter = new VercelAiMemoryToolsAdapter();

    const tools = adapter.createTools(engine as MemoryEngine, runtime);

    expect(
      tools.map((tool) => ({
        name: tool.name,
        access: tool.access,
        requiresApproval: tool.requiresApproval,
        subAgentOnly: tool.subAgentOnly,
        idempotent: tool.idempotent,
      })),
    ).toEqual([
      {
        name: 'memory.grep',
        access: 'read',
        requiresApproval: false,
        subAgentOnly: false,
        idempotent: true,
      },
      {
        name: 'memory.describe',
        access: 'read',
        requiresApproval: false,
        subAgentOnly: false,
        idempotent: true,
      },
      {
        name: 'memory.expand',
        access: 'privileged',
        requiresApproval: true,
        subAgentOnly: true,
        idempotent: true,
      },
      {
        name: 'memory.llmMap',
        access: 'write',
        requiresApproval: true,
        subAgentOnly: false,
        idempotent: false,
      },
      {
        name: 'memory.agenticMap',
        access: 'write',
        requiresApproval: true,
        subAgentOnly: false,
        idempotent: false,
      },
      {
        name: 'memory.getOperatorRun',
        access: 'read',
        requiresApproval: false,
        subAgentOnly: false,
        idempotent: true,
      },
    ]);
  });

  it('creates the same required memory tools via ToolProviderPort', () => {
    const { engine } = createMinimalEngine();
    const adapter = new VercelAiMemoryToolsAdapter();

    const tools = adapter.createTools(engine as MemoryEngine, runtime);

    expect(tools.map((tool) => tool.name)).toEqual([
      'memory.grep',
      'memory.describe',
      'memory.expand',
      'memory.llmMap',
      'memory.agenticMap',
      'memory.getOperatorRun',
    ]);
  });
});
