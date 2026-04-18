import { describe, expect, it, vi } from 'vitest';

import {
  OperatorInputValidationError,
  type AgenticMapInput,
  type AgenticMapOutput,
  type ExpandInput,
  type ExpandOutput,
  type GetOperatorRunInput,
  type GetOperatorRunOutput,
  type GrepInput,
  type GrepOutput,
  type LLMMapInput,
  type LLMMapOutput,
  type MemoryEngine,
} from '@ledgermind/application';
import { createVercelMemoryTools } from '@ledgermind/adapters';
import {
  createArtifactId,
  createConversationId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

const runtimeCallerContext = {
  conversationId: createConversationId('conv_runtime_bound'),
  isSubAgent: true,
  parentConversationId: createConversationId('conv_runtime_parent'),
} as const;

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

const createEngine = (): {
  readonly engine: MemoryEngine;
  readonly grep: ReturnType<typeof vi.fn<(input: GrepInput) => Promise<GrepOutput>>>;
  readonly expand: ReturnType<typeof vi.fn<(input: ExpandInput) => Promise<ExpandOutput>>>;
  readonly llmMap: ReturnType<typeof vi.fn<(input: LLMMapInput) => Promise<LLMMapOutput>>>;
  readonly agenticMap: ReturnType<typeof vi.fn<(input: AgenticMapInput) => Promise<AgenticMapOutput>>>;
  readonly getOperatorRun: ReturnType<
    typeof vi.fn<(input: GetOperatorRunInput) => Promise<GetOperatorRunOutput>>
  >;
} => {
  const grep = vi.fn(async (_input: GrepInput): Promise<GrepOutput> => {
    void _input;
    return { matches: [] };
  });

  const expand = vi.fn(async (_input: ExpandInput): Promise<ExpandOutput> => {
    void _input;
    return { messages: [] };
  });

  const llmMap = vi.fn(async (_input: LLMMapInput): Promise<LLMMapOutput> => {
    void _input;
    return {
      runId: 'run_llm_001',
      status: 'pending',
      inputArtifactId: createArtifactId('file_input_llm_001'),
    };
  });

  const agenticMap = vi.fn(async (_input: AgenticMapInput): Promise<AgenticMapOutput> => {
    void _input;
    return {
      runId: 'run_agent_001',
      status: 'running',
      inputArtifactId: createArtifactId('file_input_agent_001'),
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
      updatedAt: createTimestamp(new Date('2026-04-13T00:00:05.000Z')),
      completedAt: createTimestamp(new Date('2026-04-13T00:00:06.000Z')),
      inputArtifactId: createArtifactId('file_input_agent_001'),
      outputArtifactId: createArtifactId('file_output_agent_001'),
      taskCount: 1,
      succeededTaskCount: 1,
      failedTaskCount: 0,
      retryableFailureTaskCount: 0,
      runningTaskCount: 0,
      pendingTaskCount: 0,
      inlineResults: [
        {
          itemIndex: 0,
          status: 'succeeded',
          output: {
            large: 'this should stay out of the tool response',
          },
          childConversationId: createConversationId('conv_child_001'),
        },
      ],
      tasks: [
        {
          taskId: 'task_001',
          itemIndex: 0,
          status: 'succeeded',
          attemptCount: 1,
          childConversationId: createConversationId('conv_child_001'),
        },
      ],
    };
  });

  const engine = {
    grep,
    describe: vi.fn(async () => ({ kind: 'summary' as const, metadata: {}, tokenCount: createTokenCount(1) })),
    expand,
    storeArtifact: vi.fn(),
    exploreArtifact: vi.fn(),
    append: vi.fn(),
    materializeContext: vi.fn(),
    runCompaction: vi.fn(),
    checkIntegrity: vi.fn(),
    llmMap,
    agenticMap,
    getOperatorRun,
  } as unknown as MemoryEngine;

  return {
    engine,
    grep,
    expand,
    llmMap,
    agenticMap,
    getOperatorRun,
  };
};

describe('operator tool surface regression', () => {
  it('binds runtime caller context for grep, expand, llmMap, agenticMap, and getOperatorRun tool calls', async () => {
    const { engine, grep, expand, llmMap, agenticMap, getOperatorRun } = createEngine();
    const tools = createVercelMemoryTools(engine, {
      getCallerContext: () => runtimeCallerContext,
    });

    expect(Object.keys(tools).sort()).toEqual([
      'memory.agenticMap',
      'memory.describe',
      'memory.expand',
      'memory.getOperatorRun',
      'memory.grep',
      'memory.llmMap',
    ]);

    await getToolSetTool(tools, 'memory.grep').execute({
      conversationId: 'conv_model_supplied',
      query: 'needle',
      scope: 'sum_scope_001',
    });
    expect(grep).toHaveBeenCalledWith({
      conversationId: runtimeCallerContext.conversationId,
      pattern: 'needle',
      scope: 'sum_scope_001',
    });

    await getToolSetTool(tools, 'memory.expand').execute({
      summaryId: 'sum_leaf_001',
      callerContext: {
        conversationId: 'conv_model_supplied',
        isSubAgent: false,
      },
    });
    expect(expand).toHaveBeenCalledWith({
      summaryId: 'sum_leaf_001',
      callerContext: runtimeCallerContext,
    });

    await getToolSetTool(tools, 'memory.llmMap').execute({
      conversationId: 'conv_model_supplied',
      prompt: 'Summarize each item.',
      items: [{ label: 'alpha' }],
      outputSchema: { type: 'object' },
      concurrencyLimit: 1,
      retryPolicy: { maxRetries: 0, retryBackoffSeconds: 1 },
    });
    expect(llmMap).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: runtimeCallerContext.conversationId,
      }),
    );

    await getToolSetTool(tools, 'memory.agenticMap').execute({
      conversationId: 'conv_model_supplied',
      taskPrompt: 'Delegate each item.',
      items: [{ label: 'beta' }],
      delegatedScope: { note: 'scope' },
      keptWork: { description: 'keep compact', expectedOutput: 'JSON' },
      outputSchema: { type: 'object' },
      concurrencyLimit: 1,
      retryPolicy: { maxRetries: 0, retryBackoffSeconds: 1 },
    });
    expect(agenticMap).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: runtimeCallerContext.conversationId,
      }),
    );

    await getToolSetTool(tools, 'memory.getOperatorRun').execute({
      runId: 'run_agent_001',
      conversationId: 'conv_model_supplied',
    });
    expect(getOperatorRun).toHaveBeenCalledWith({ runId: 'run_agent_001' });
  });

  it('rejects memory.getOperatorRun inspection for runs owned by a different conversation than the runtime caller', async () => {
    const { engine, getOperatorRun } = createEngine();
    getOperatorRun.mockResolvedValueOnce({
      runId: 'run_foreign_001',
      conversationId: createConversationId('conv_foreign_owner'),
      operatorKind: 'agenticMap',
      status: 'completed',
      createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
      updatedAt: createTimestamp(new Date('2026-04-13T00:00:05.000Z')),
      taskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      retryableFailureTaskCount: 0,
      runningTaskCount: 0,
      pendingTaskCount: 0,
      tasks: [],
    });

    const tools = createVercelMemoryTools(engine, {
      getCallerContext: () => runtimeCallerContext,
    });

    const result = await getToolSetTool(tools, 'memory.getOperatorRun').execute({
      runId: 'run_foreign_001',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_FAILED',
        message: 'Operator run does not belong to the bound runtime conversation.',
      },
    });
  });

  it('returns a tool-safe validation envelope when inline operator datasets exceed limits', async () => {
    const { engine, llmMap } = createEngine();
    llmMap.mockRejectedValueOnce(
      new OperatorInputValidationError('Inline operator dataset exceeds maxInlineOperatorInputBytes.'),
    );

    const tools = createVercelMemoryTools(engine, {
      getCallerContext: () => runtimeCallerContext,
    });

    const result = await getToolSetTool(tools, 'memory.llmMap').execute({
      prompt: 'Summarize each item.',
      items: [{ payload: 'x'.repeat(1024) }],
      outputSchema: { type: 'object' },
      concurrencyLimit: 1,
      retryPolicy: { maxRetries: 0, retryBackoffSeconds: 1 },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'OPERATOR_INPUT_INVALID',
        message: 'Inline operator dataset exceeds maxInlineOperatorInputBytes.',
      },
    });
  });

  it('returns compact operator tool payloads with provenance handles instead of full result sets', async () => {
    const { engine } = createEngine();
    const tools = createVercelMemoryTools(engine, {
      getCallerContext: () => runtimeCallerContext,
    });

    const llmMapResult = (await getToolSetTool(tools, 'memory.llmMap').execute({
      prompt: 'Summarize each item.',
      items: [{ label: 'alpha' }],
      outputSchema: { type: 'object' },
      concurrencyLimit: 1,
      retryPolicy: { maxRetries: 0, retryBackoffSeconds: 1 },
    })) as Record<string, unknown>;

    expect(llmMapResult).toEqual({
      ok: true,
      data: {
        runId: 'run_llm_001',
        status: 'pending',
        inputArtifactId: 'file_input_llm_001',
      },
      references: {
        conversationIds: ['conv_runtime_bound'],
        artifactIds: ['file_input_llm_001'],
        operatorRunIds: ['run_llm_001'],
      },
    });

    const getRunResult = (await getToolSetTool(tools, 'memory.getOperatorRun').execute({
      runId: 'run_agent_001',
    })) as Record<string, unknown>;

    expect(getRunResult).toEqual({
      ok: true,
      data: {
        runId: 'run_agent_001',
        operatorKind: 'agenticMap',
        status: 'completed',
        taskCount: 1,
        succeededTaskCount: 1,
        failedTaskCount: 0,
        retryableFailureTaskCount: 0,
        runningTaskCount: 0,
        pendingTaskCount: 0,
        inputArtifactId: 'file_input_agent_001',
        outputArtifactId: 'file_output_agent_001',
        childConversationIds: ['conv_child_001'],
      },
      references: {
        conversationIds: ['conv_runtime_bound', 'conv_child_001'],
        artifactIds: ['file_input_agent_001', 'file_output_agent_001'],
        operatorRunIds: ['run_agent_001'],
      },
    });

    expect(getRunResult).not.toHaveProperty('data.inlineResults');
    expect(getRunResult).not.toHaveProperty('data.tasks');
  });
});
