import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CreateHandoffInput,
  CreateHandoffOutput,
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  GetNextStepsInput,
  GetNextStepsOutput,
  GrepInput,
  GrepOutput,
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  MemoryEngine,
  RecallForTaskInput,
  RecallForTaskOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
} from '@ledgermind/application';
import {
  createConversationId,
  createEventId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLedgermindMcpServer } from '../server';

type MinimalMemoryEngine = Pick<
  MemoryEngine,
  | 'grep'
  | 'describe'
  | 'expand'
  | 'getCurrentState'
  | 'getNextSteps'
  | 'recallForTask'
  | 'recordContinuity'
  | 'createHandoff'
  | 'markContinuityRecord'
>;

const createMinimalEngine = (): {
  readonly engine: MinimalMemoryEngine;
  readonly grep: ReturnType<typeof vi.fn<(input: GrepInput) => Promise<GrepOutput>>>;
  readonly describe: ReturnType<typeof vi.fn<(input: DescribeInput) => Promise<DescribeOutput>>>;
  readonly expand: ReturnType<typeof vi.fn<(input: ExpandInput) => Promise<ExpandOutput>>>;
  readonly getCurrentState: ReturnType<
    typeof vi.fn<(input: GetCurrentStateInput) => Promise<GetCurrentStateOutput>>
  >;
  readonly recordContinuity: ReturnType<
    typeof vi.fn<(input: RecordContinuityInput) => Promise<RecordContinuityOutput>>
  >;
} => {
  const grep = vi.fn(async (input: GrepInput): Promise<GrepOutput> => {
    void input;
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
  const describe = vi.fn(async (input: DescribeInput): Promise<DescribeOutput> => {
    void input;
    return {
      kind: 'summary',
      metadata: { topic: 'auth' },
      tokenCount: { value: 2 } as DescribeOutput['tokenCount'],
      references: {
        summaryIds: ['sum_parent_1'],
      },
    } as unknown as DescribeOutput;
  });
  const expand = vi.fn(async (input: ExpandInput): Promise<ExpandOutput> => {
    void input;
    return { messages: [] };
  });
  const getCurrentState = vi.fn(
    async (input: GetCurrentStateInput): Promise<GetCurrentStateOutput> => {
      void input;
      return {
        goalRecords: [],
        decisions: [],
        constraints: [],
        progress: [],
        nextSteps: [],
        handoffs: [],
        verification: [],
        failures: [],
        openQuestions: [],
        artifactChanges: [],
        sessionSummaries: [],
        activeRecordCount: 0,
        staleRecordCount: 0,
      };
    },
  );
  const getNextSteps = vi.fn(async (input: GetNextStepsInput): Promise<GetNextStepsOutput> => {
    void input;
    return { nextSteps: [] };
  });
  const recallForTask = vi.fn(async (input: RecallForTaskInput): Promise<RecallForTaskOutput> => {
    void input;
    return {
      contextBlock: 'LedgerMind current state',
      currentState: await getCurrentState({ conversationId: createConversationId('conv_default') }),
      recalledSummaryIds: [],
      recalledArtifactIds: [],
      recalledEventIds: [],
      why: [],
      budgetUsed: createTokenCount(3),
    };
  });
  const recordContinuity = vi.fn(
    async (input: RecordContinuityInput): Promise<RecordContinuityOutput> => ({
      record: {
        recordId: input.idempotencyKey ?? `${input.kind}:${input.title.toLowerCase()}`,
        conversationId: input.conversationId,
        kind: input.kind,
        status: input.status ?? 'active',
        title: input.title,
        content: input.content,
        importance: input.importance ?? 'normal',
        provenance: input.provenance ?? {},
        relatedRecordIds: input.relatedRecordIds ?? [],
        supersedesRecordIds: input.supersedesRecordIds ?? [],
        createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
        eventId: createEventId('evt_mcp_record_1'),
      },
      contextTokenCount: createTokenCount(5),
    }),
  );
  const createHandoff = vi.fn(async (input: CreateHandoffInput): Promise<CreateHandoffOutput> => {
    const handoff = await recordContinuity({
      conversationId: input.conversationId,
      kind: 'handoff',
      title: `Continue: ${input.goal}`,
      content: input.completed.join('\n'),
    });
    return { handoff: handoff.record, nextStepRecords: [] };
  });
  const markContinuityRecord = vi.fn(
    async (input: MarkContinuityRecordInput): Promise<MarkContinuityRecordOutput> => ({
      marker: {
        recordId: input.idempotencyKey ?? `session_summary:mark ${input.recordId} stale`,
        conversationId: input.conversationId,
        kind: 'session_summary',
        status: input.status,
        title: `Mark ${input.recordId} ${input.status}`,
        content: input.reason,
        importance: 'normal',
        provenance: {},
        relatedRecordIds: [input.recordId],
        supersedesRecordIds: [input.recordId],
        createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
        eventId: createEventId('evt_mcp_mark_1'),
      },
    }),
  );

  return {
    engine: {
      grep,
      describe,
      expand,
      getCurrentState,
      getNextSteps,
      recallForTask,
      recordContinuity,
      createHandoff,
      markContinuityRecord,
    },
    grep,
    describe,
    expand,
    getCurrentState,
    recordContinuity,
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
      'memory.currentState',
      'memory.nextSteps',
      'memory.recallForTask',
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

  it('hides write tools and rejects direct write-tool calls when write tools are disabled', async () => {
    const { engine, recordContinuity } = createMinimalEngine();
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
    expect(tools.tools.map((tool) => tool.name)).not.toContain('memory.recordDecision');

    const result = await client.callTool({
      name: 'memory.recordDecision',
      arguments: {
        conversationId: 'conv_spoofed',
        title: 'Use continuity',
        content: 'This direct call should be denied.',
      },
      _meta: {
        'ledgermind/session': {
          runtime: 'amp',
          runtimeSessionId: 'thread-child',
          parentRuntimeSessionId: 'missing-parent',
          userScope: 'alice',
          workspaceScope: '/workspace/ledger-memory',
        },
      },
    });

    expect(recordContinuity).not.toHaveBeenCalled();
    expect(await runtime.sessionBindingStore.list()).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'MCP_TOOL_ACCESS_DENIED',
        toolName: 'memory.recordDecision',
      },
    });

    await Promise.all([client.close(), runtime.server.close()]);
  });

  it('rejects memory.expand when callerContext self-attests sub-agent status but trusted session metadata does not', async () => {
    const { engine, expand } = createMinimalEngine();
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

    const result = await client.callTool({
      name: 'memory.expand',
      arguments: {
        summaryId: 'sum_leaf_1',
        callerContext: {
          conversationId: 'conv_spoofed',
          isSubAgent: true,
        },
      },
      _meta: {
        'ledgermind/session': {
          runtime: 'amp',
          runtimeSessionId: 'thread-root',
          userScope: 'alice',
          workspaceScope: '/workspace/ledger-memory',
          isSubAgent: false,
        },
      },
    } as Parameters<typeof client.callTool>[0]);

    expect(expand).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'MCP_TOOL_ACCESS_DENIED',
        toolName: 'memory.expand',
      },
    });

    await Promise.all([client.close(), runtime.server.close()]);
  });
});
