import { describe, expect, it } from 'vitest';

import type { MemoryEngine, ToolRuntimeContextProvider } from '@ledgermind/application';
import { createConversationId, createTimestamp, createTokenCount } from '@ledgermind/domain';

import {
  createVercelMemoryTools,
  createVercelTools,
  VercelAiMemoryToolsAdapter,
} from '../index';

describe('tools public exports', () => {
  it('exposes Vercel memory tool adapter APIs from @ledgermind/adapters root', () => {
    const runtime: ToolRuntimeContextProvider = {
      getCallerContext: () => ({
        conversationId: createConversationId('conv_runtime'),
        isSubAgent: true,
      }),
    };

    const engine = {
      grep: async () => ({
        groups: [],
        page: {
          offset: 0,
          limit: 25,
          returnedMatchCount: 0,
          totalMatchCount: 0,
          hasMore: false,
        },
      }),
      describe: async () => ({
        kind: 'summary' as const,
        metadata: {},
        tokenCount: createTokenCount(1),
      }),
      expand: async () => ({ messages: [] }),
      llmMap: async () => ({ runId: 'run_llm_001', status: 'pending' as const }),
      agenticMap: async () => ({ runId: 'run_agent_001', status: 'running' as const }),
      getOperatorRun: async () => ({
        runId: 'run_agent_001',
        conversationId: createConversationId('conv_runtime'),
        operatorKind: 'agenticMap' as const,
        status: 'completed' as const,
        createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
        updatedAt: createTimestamp(new Date('2026-04-13T00:00:01.000Z')),
        taskCount: 0,
        succeededTaskCount: 0,
        failedTaskCount: 0,
        retryableFailureTaskCount: 0,
        runningTaskCount: 0,
        pendingTaskCount: 0,
        tasks: [],
      }),
    } as Pick<
      MemoryEngine,
      'grep' | 'describe' | 'expand' | 'llmMap' | 'agenticMap' | 'getOperatorRun'
    >;

    const tools = createVercelMemoryTools(engine as MemoryEngine, runtime);
    const aliasTools = createVercelTools(engine as MemoryEngine, runtime);
    const adapterTools = new VercelAiMemoryToolsAdapter().createTools(engine as MemoryEngine, runtime);

    expect(Object.keys(tools).sort()).toEqual([
      'memory.agenticMap',
      'memory.describe',
      'memory.expand',
      'memory.getOperatorRun',
      'memory.grep',
      'memory.llmMap',
    ]);
    expect(Object.keys(aliasTools).sort()).toEqual(Object.keys(tools).sort());
    expect(adapterTools.map((tool) => tool.name)).toEqual([
      'memory.grep',
      'memory.describe',
      'memory.expand',
      'memory.llmMap',
      'memory.agenticMap',
      'memory.getOperatorRun',
    ]);
  });
});
