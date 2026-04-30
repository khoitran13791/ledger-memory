import { describe, expect, it, vi } from 'vitest';

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
  ToolAccessLevel,
} from '@ledgermind/application';
import {
  createConversationId,
  createEventId,
  createArtifactId,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

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
    readonly createCanonicalMemoryToolCatalog: (
      engine: MemoryEngine,
    ) => readonly CanonicalMemoryTool[];
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
  readonly getCurrentState: ReturnType<
    typeof vi.fn<(input: GetCurrentStateInput) => Promise<GetCurrentStateOutput>>
  >;
  readonly getNextSteps: ReturnType<
    typeof vi.fn<(input: GetNextStepsInput) => Promise<GetNextStepsOutput>>
  >;
  readonly recallForTask: ReturnType<
    typeof vi.fn<(input: RecallForTaskInput) => Promise<RecallForTaskOutput>>
  >;
  readonly recordContinuity: ReturnType<
    typeof vi.fn<(input: RecordContinuityInput) => Promise<RecordContinuityOutput>>
  >;
  readonly createHandoff: ReturnType<
    typeof vi.fn<(input: CreateHandoffInput) => Promise<CreateHandoffOutput>>
  >;
  readonly markContinuityRecord: ReturnType<
    typeof vi.fn<(input: MarkContinuityRecordInput) => Promise<MarkContinuityRecordOutput>>
  >;
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

  const getCurrentState = vi.fn(
    async (_input: GetCurrentStateInput): Promise<GetCurrentStateOutput> => {
      void _input;
      return {
        goalRecords: [],
        decisions: [
          {
            recordId: 'decision:projection',
            conversationId: createConversationId('conv_default'),
            kind: 'decision',
            status: 'active',
            title: 'Use projection',
            content: 'Project continuity from ledger events.',
            importance: 'high',
            provenance: {
              eventIds: [createEventId('evt_source_state_1')],
              summaryIds: [createSummaryNodeId('sum_source_state_1')],
              artifactIds: [createArtifactId('file_source_state_1')],
            },
            relatedRecordIds: [],
            supersedesRecordIds: [],
            createdAt: createTimestamp(new Date('2026-04-28T13:00:00.000Z')),
            eventId: createEventId('evt_state_record_1'),
          },
        ],
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

  const getNextSteps = vi.fn(async (_input: GetNextStepsInput): Promise<GetNextStepsOutput> => {
    void _input;
    return {
      nextSteps: [],
    };
  });

  const recallForTask = vi.fn(async (_input: RecallForTaskInput): Promise<RecallForTaskOutput> => {
    void _input;
    return {
      contextBlock: 'LedgerMind current state',
      currentState: await getCurrentState({ conversationId: createConversationId('conv_default') }),
      recalledSummaryIds: [createSummaryNodeId('sum_recalled_1')],
      recalledArtifactIds: [
        'file_recalled_1' as RecallForTaskOutput['recalledArtifactIds'][number],
      ],
      recalledEventIds: [createEventId('evt_recalled_1')],
      why: ['Task prompt matched current state.'],
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
        createdAt: createTimestamp(new Date('2026-04-28T13:00:00.000Z')),
        eventId: createEventId('evt_record_tool_1'),
      },
      contextTokenCount: createTokenCount(8),
    }),
  );

  const createHandoff = vi.fn(async (input: CreateHandoffInput): Promise<CreateHandoffOutput> => {
    const output = await recordContinuity({
      conversationId: input.conversationId,
      kind: 'handoff',
      title: `Continue: ${input.goal}`,
      content: input.completed.join('\n'),
    });

    return {
      handoff: output.record,
      nextStepRecords: [],
    };
  });

  const markContinuityRecord = vi.fn(
    async (input: MarkContinuityRecordInput): Promise<MarkContinuityRecordOutput> => ({
      marker: {
        recordId: input.idempotencyKey ?? `session_summary:mark ${input.recordId} stale`,
        conversationId: input.conversationId,
        kind: 'session_summary',
        status: input.status,
        title: `Mark ${input.recordId} ${input.status}`,
        content: `Record ${input.recordId} marked ${input.status}: ${input.reason}`,
        importance: 'normal',
        provenance: {},
        relatedRecordIds: [input.recordId],
        supersedesRecordIds: [input.recordId],
        createdAt: createTimestamp(new Date('2026-04-28T13:00:00.000Z')),
        eventId: createEventId('evt_mark_tool_1'),
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
    getNextSteps,
    recallForTask,
    recordContinuity,
    createHandoff,
    markContinuityRecord,
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
      'memory.currentState',
      'memory.nextSteps',
      'memory.recallForTask',
      'memory.recordDecision',
      'memory.recordConstraint',
      'memory.recordProgress',
      'memory.recordVerification',
      'memory.createHandoff',
      'memory.markStale',
    ]);

    const recallTool = catalog[0]!;
    const describeTool = catalog[1]!;
    const expandTool = catalog[2]!;
    const currentStateTool = getToolByName(catalog, 'memory.currentState');
    const recordDecisionTool = getToolByName(catalog, 'memory.recordDecision');

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
    assertPolicyMetadata(currentStateTool, {
      access: 'read',
      requiresApproval: false,
      subAgentOnly: false,
      idempotent: true,
    });
    assertPolicyMetadata(recordDecisionTool, {
      access: 'write',
      requiresApproval: false,
      subAgentOnly: false,
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
    [
      'missing isSubAgent',
      { summaryId: 'sum_leaf_1', callerContext: { conversationId: 'conv_2' } },
    ],
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

  it('forwards task-start recall input and returns recalled evidence references', async () => {
    const { engine, recallForTask } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const tool = getToolByName(catalog, 'memory.recallForTask');

    const result = await tool.execute({
      conversationId: 'conv_recall_task',
      task: 'Fix failing auth tests',
      budgetTokens: 1200,
      includeHandoff: true,
      includeEvidence: true,
    });

    expect(recallForTask).toHaveBeenCalledWith({
      conversationId: createConversationId('conv_recall_task'),
      task: 'Fix failing auth tests',
      budgetTokens: 1200,
      includeHandoff: true,
      includeEvidence: true,
    });
    const envelope = assertSuccessEnvelope(result, {
      contextBlock: 'LedgerMind current state',
      currentState: await engine.getCurrentState({
        conversationId: createConversationId('conv_default'),
      }),
      recalledSummaryIds: [createSummaryNodeId('sum_recalled_1')],
      recalledArtifactIds: ['file_recalled_1'],
      recalledEventIds: [createEventId('evt_recalled_1')],
      why: ['Task prompt matched current state.'],
      budgetUsed: createTokenCount(3),
    });
    expect(envelope.references).toEqual({
      summaryIds: ['sum_recalled_1'],
      artifactIds: ['file_recalled_1'],
      eventIds: ['evt_recalled_1'],
    });
  });

  it('returns current-state record and provenance references', async () => {
    const { engine, getCurrentState } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const tool = getToolByName(catalog, 'memory.currentState');

    const result = await tool.execute({ conversationId: 'conv_state_refs' });

    expect(getCurrentState).toHaveBeenCalledWith({
      conversationId: createConversationId('conv_state_refs'),
    });
    const envelope = assertSuccessEnvelope(
      result,
      await engine.getCurrentState({
        conversationId: createConversationId('conv_default'),
      }),
    );
    expect(envelope.references).toEqual({
      summaryIds: ['sum_source_state_1'],
      artifactIds: ['file_source_state_1'],
      eventIds: ['evt_state_record_1', 'evt_source_state_1'],
    });
  });

  it('records decision continuity with agent-friendly write input', async () => {
    const { engine, recordContinuity } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const tool = getToolByName(catalog, 'memory.recordDecision');

    const result = await tool.execute({
      conversationId: 'conv_write_decision',
      title: 'Use append-only continuity',
      content: 'Continuity records are ledger events.',
      importance: 'high',
      provenance: {
        command: 'pnpm typecheck',
      },
      idempotencyKey: 'decision:append-only-continuity',
    });

    expect(recordContinuity).toHaveBeenCalledWith({
      conversationId: createConversationId('conv_write_decision'),
      kind: 'decision',
      title: 'Use append-only continuity',
      content: 'Continuity records are ledger events.',
      importance: 'high',
      provenance: {
        command: 'pnpm typecheck',
      },
      idempotencyKey: 'decision:append-only-continuity',
    });
    const envelope = assertSuccessEnvelope(result, {
      record: expect.objectContaining({
        eventId: createEventId('evt_record_tool_1'),
      }),
      contextTokenCount: createTokenCount(8),
    });
    expect(envelope.references).toEqual({
      eventIds: ['evt_record_tool_1'],
    });
  });

  it('creates handoffs from title/content aliases and marks stale records with content as reason', async () => {
    const { engine, createHandoff, markContinuityRecord } = createMinimalEngine();
    const createCanonicalMemoryToolCatalog = await loadCreateCanonicalMemoryToolCatalog();

    const catalog = createCanonicalMemoryToolCatalog(engine as MemoryEngine);
    const handoffTool = getToolByName(catalog, 'memory.createHandoff');
    const staleTool = getToolByName(catalog, 'memory.markStale');

    await handoffTool.execute({
      conversationId: 'conv_handoff_tool',
      title: 'Resume continuity MCP tools',
      content: 'Catalog entries are added.',
      nextSteps: [{ title: 'Bind tools', content: 'Update MCP session binding.' }],
      idempotencyKey: 'handoff:continuity-tools',
    });
    await staleTool.execute({
      conversationId: 'conv_handoff_tool',
      recordId: 'decision:old-tool-shape',
      title: 'Mark old tool shape stale',
      content: 'The canonical catalog now exposes typed continuity tools.',
      idempotencyKey: 'mark:old-tool-shape',
    });

    expect(createHandoff).toHaveBeenCalledWith({
      conversationId: createConversationId('conv_handoff_tool'),
      goal: 'Resume continuity MCP tools',
      completed: ['Catalog entries are added.'],
      nextSteps: [{ title: 'Bind tools', content: 'Update MCP session binding.' }],
      idempotencyKey: 'handoff:continuity-tools',
    });
    expect(markContinuityRecord).toHaveBeenCalledWith({
      conversationId: createConversationId('conv_handoff_tool'),
      recordId: 'decision:old-tool-shape',
      status: 'stale',
      reason: 'The canonical catalog now exposes typed continuity tools.',
      idempotencyKey: 'mark:old-tool-shape',
    });
  });
});
