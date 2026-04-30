import type {
  ContinuityImportance,
  ContinuityProvenance,
  ContinuityRecordKind,
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
  HandoffNextStep,
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  MemoryEngine,
  RecallForTaskInput,
  RecallForTaskOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
  ToolDefinition,
} from '@ledgermind/application';
import { createConversationId, createSummaryNodeId } from '@ledgermind/domain';

import {
  assertValidMemoryEngine,
  parseCallerContext,
  parseToolInput,
  readOptionalBoolean,
  readOptionalInteger,
  readOptionalObject,
  readOptionalString,
  readOptionalStringArray,
  readRequiredString,
} from './shared/input-parsers';
import {
  deriveContinuityReferences,
  deriveDescribeReferences,
  deriveExpandReferences,
  deriveRecallReferences,
  extractReferences,
  toReferencedToolErrorEnvelope,
  toReferencedToolSuccessEnvelope,
} from './shared/reference-derivation';
import type { ToolResponseEnvelope } from './types';

const TOOL_NAMES = {
  recall: 'memory.recall',
  describe: 'memory.describe',
  expand: 'memory.expand',
  currentState: 'memory.currentState',
  nextSteps: 'memory.nextSteps',
  recallForTask: 'memory.recallForTask',
  recordDecision: 'memory.recordDecision',
  recordConstraint: 'memory.recordConstraint',
  recordProgress: 'memory.recordProgress',
  recordVerification: 'memory.recordVerification',
  createHandoff: 'memory.createHandoff',
  markStale: 'memory.markStale',
} as const;

const CONTINUITY_IMPORTANCE = new Set<ContinuityImportance>(['low', 'normal', 'high', 'critical']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recallParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: {
      type: 'string',
      description: 'Conversation identifier to search within.',
    },
    query: {
      type: 'string',
      description: 'Query string used to recall relevant memory events.',
    },
    scope: {
      type: 'string',
      description: 'Optional summary ID scope for narrowing recall results.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Zero-based match offset for pagination.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum number of matches to return in one page.',
    },
  },
  required: ['conversationId', 'query'],
};

const describeParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Summary or artifact identifier to inspect.',
    },
  },
  required: ['id'],
};

const expandParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summaryId: {
      type: 'string',
      description: 'Summary ID to expand back to underlying ledger messages.',
    },
    callerContext: {
      type: 'object',
      additionalProperties: false,
      properties: {
        conversationId: {
          type: 'string',
          description: 'Conversation that owns the requested summary.',
        },
        isSubAgent: {
          type: 'boolean',
          description: 'Whether the caller is running as an authorized sub-agent.',
        },
        parentConversationId: {
          type: 'string',
          description: 'Optional parent conversation for sub-agent lineage.',
        },
      },
      required: ['conversationId', 'isSubAgent'],
    },
  },
  required: ['summaryId', 'callerContext'],
};

const provenanceParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: true,
  description:
    'Optional provenance such as event IDs, summary IDs, artifact IDs, transcript span, tool ID, or command.',
};

const continuityWriteProperties: Readonly<Record<string, unknown>> = {
  conversationId: {
    type: 'string',
    description: 'Conversation identifier that owns the continuity record.',
  },
  title: {
    type: 'string',
    description: 'Short human-readable continuity title.',
  },
  content: {
    type: 'string',
    description: 'Durable continuity content, including the reason for marker tools.',
  },
  importance: {
    type: 'string',
    enum: ['low', 'normal', 'high', 'critical'],
    description: 'Optional record importance.',
  },
  provenance: provenanceParameters,
  idempotencyKey: {
    type: 'string',
    description: 'Optional stable key used to make repeated tool calls idempotent.',
  },
};

const currentStateParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: {
      type: 'string',
      description: 'Conversation identifier to project current state for.',
    },
    includeStale: {
      type: 'boolean',
      description: 'Whether stale, superseded, and resolved records should be included.',
    },
    limitPerKind: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Optional maximum number of records per state bucket.',
    },
  },
  required: ['conversationId'],
};

const nextStepsParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: {
      type: 'string',
      description: 'Conversation identifier to read next steps from.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Optional maximum number of next steps.',
    },
  },
  required: ['conversationId'],
};

const recallForTaskParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: {
      type: 'string',
      description: 'Conversation identifier to recall continuity for.',
    },
    task: {
      type: 'string',
      description: 'Current task prompt or intent.',
    },
    budgetTokens: {
      type: 'integer',
      minimum: 1,
      maximum: 20000,
      description: 'Maximum token budget for the returned context block.',
    },
    includeHandoff: {
      type: 'boolean',
      description: 'Whether the latest handoff should be included.',
    },
    includeEvidence: {
      type: 'boolean',
      description: 'Whether evidence references should be included.',
    },
  },
  required: ['conversationId', 'task', 'budgetTokens'],
};

const continuityRecordParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: continuityWriteProperties,
  required: ['conversationId', 'title', 'content'],
};

const handoffParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...continuityWriteProperties,
    completed: {
      type: 'array',
      items: { type: 'string' },
      description: 'Completed items. If omitted, content is used as one completed item.',
    },
    nextSteps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          provenance: provenanceParameters,
        },
        required: ['title', 'content'],
      },
      description: 'Optional structured next steps to persist after the handoff.',
    },
    decisions: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['conversationId', 'title', 'content'],
};

const markStaleParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...continuityWriteProperties,
    recordId: {
      type: 'string',
      description: 'Continuity record ID to mark stale.',
    },
    supersededByRecordId: {
      type: 'string',
      description: 'Optional replacement continuity record ID.',
    },
  },
  required: ['conversationId', 'recordId', 'title', 'content'],
};

const readOptionalImportance = (
  payload: Record<string, unknown>,
  toolName: string,
): ContinuityImportance | undefined => {
  const importance = readOptionalString(payload, 'importance', toolName);
  if (importance === undefined) {
    return undefined;
  }

  if (!CONTINUITY_IMPORTANCE.has(importance as ContinuityImportance)) {
    throw new TypeError(
      `${toolName} expects optional "importance" to be low, normal, high, or critical.`,
    );
  }

  return importance as ContinuityImportance;
};

const readOptionalProvenance = (
  payload: Record<string, unknown>,
  toolName: string,
): ContinuityProvenance | undefined => {
  const provenance = readOptionalObject(payload, 'provenance', toolName);
  return provenance === undefined ? undefined : (provenance as ContinuityProvenance);
};

const parseContinuityRecordInput = (
  payload: Record<string, unknown>,
  toolName: string,
  kind: ContinuityRecordKind,
): RecordContinuityInput => {
  const conversationId = createConversationId(
    readRequiredString(payload, 'conversationId', toolName),
  );
  const title = readRequiredString(payload, 'title', toolName);
  const content = readRequiredString(payload, 'content', toolName);
  const importance = readOptionalImportance(payload, toolName);
  const provenance = readOptionalProvenance(payload, toolName);
  const idempotencyKey = readOptionalString(payload, 'idempotencyKey', toolName);

  return {
    conversationId,
    kind,
    title,
    content,
    ...(importance === undefined ? {} : { importance }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
};

const parseNextSteps = (
  payload: Record<string, unknown>,
  toolName: string,
): readonly HandoffNextStep[] | undefined => {
  if (!('nextSteps' in payload) || payload.nextSteps === undefined) {
    return undefined;
  }

  if (!Array.isArray(payload.nextSteps)) {
    throw new TypeError(`${toolName} expects optional "nextSteps" to be an array when provided.`);
  }

  return payload.nextSteps.map((item) => {
    if (!isRecord(item)) {
      throw new TypeError(`${toolName} expects "nextSteps" items to be objects.`);
    }

    const title = readRequiredString(item, 'title', toolName);
    const content = readRequiredString(item, 'content', toolName);
    const importance = readOptionalImportance(item, toolName);
    const provenance = readOptionalProvenance(item, toolName);

    return {
      title,
      content,
      ...(importance === undefined ? {} : { importance }),
      ...(provenance === undefined ? {} : { provenance }),
    };
  });
};

const createContinuityRecordTool = (
  engine: MemoryEngine,
  toolName: string,
  kind: ContinuityRecordKind,
  description: string,
): ToolDefinition => ({
  name: toolName,
  description,
  parameters: continuityRecordParameters,
  access: 'write',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Writes one append-only continuity record through the MemoryEngine.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<RecordContinuityOutput>> => {
    try {
      const payload = parseToolInput(input, toolName);
      const output = await engine.recordContinuity(
        parseContinuityRecordInput(payload, toolName, kind),
      );
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveContinuityReferences(output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createRecallTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.recall,
  description: 'Recall relevant memory events within a conversation using a query string.',
  parameters: recallParameters,
  access: 'read',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Read-only memory lookup that does not mutate LedgerMind state.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<GrepOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.recall);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.recall),
      );
      const query = readRequiredString(payload, 'query', TOOL_NAMES.recall);
      const scopeRaw = readOptionalString(payload, 'scope', TOOL_NAMES.recall);
      const offset = readOptionalInteger(payload, 'offset', TOOL_NAMES.recall, { minimum: 0 });
      const limit = readOptionalInteger(payload, 'limit', TOOL_NAMES.recall, {
        minimum: 1,
        maximum: 100,
      });
      const scope = scopeRaw === undefined ? undefined : createSummaryNodeId(scopeRaw);

      const grepInput: GrepInput =
        scope === undefined && offset === undefined && limit === undefined
          ? {
              conversationId,
              pattern: query,
            }
          : {
              conversationId,
              pattern: query,
              ...(scope === undefined ? {} : { scope }),
              ...(offset === undefined ? {} : { offset }),
              ...(limit === undefined ? {} : { limit }),
            };

      const output = await engine.grep(grepInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveRecallReferences(scopeRaw, output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createDescribeTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.describe,
  description: 'Describe memory metadata for a summary or artifact identifier.',
  parameters: describeParameters,
  access: 'read',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Read-only metadata inspection over existing memory references.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<DescribeOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.describe);
      const id = readRequiredString(payload, 'id', TOOL_NAMES.describe);

      const describeInput: DescribeInput = {
        id: id as DescribeInput['id'],
      };

      const output = await engine.describe(describeInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveDescribeReferences(id, output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createExpandTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.expand,
  description: 'Expand a summary node to recover original ledger messages.',
  parameters: expandParameters,
  access: 'privileged',
  requiresApproval: true,
  subAgentOnly: true,
  idempotent: true,
  approvalHint:
    'Expanding a summary can reveal raw historical context and should stay sub-agent scoped.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<ExpandOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.expand);
      const summaryId = createSummaryNodeId(
        readRequiredString(payload, 'summaryId', TOOL_NAMES.expand),
      );
      const callerContext = parseCallerContext(payload, TOOL_NAMES.expand);

      const expandInput: ExpandInput = {
        summaryId,
        callerContext,
      };

      const output = await engine.expand(expandInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveExpandReferences(String(summaryId), output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createCurrentStateTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.currentState,
  description: 'Project current operational continuity state for a conversation.',
  parameters: currentStateParameters,
  access: 'read',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Read-only projection over existing continuity records.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<GetCurrentStateOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.currentState);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.currentState),
      );
      const includeStale = readOptionalBoolean(payload, 'includeStale', TOOL_NAMES.currentState);
      const limitPerKind = readOptionalInteger(payload, 'limitPerKind', TOOL_NAMES.currentState, {
        minimum: 1,
        maximum: 100,
      });
      const currentStateInput: GetCurrentStateInput = {
        conversationId,
        ...(includeStale === undefined ? {} : { includeStale }),
        ...(limitPerKind === undefined ? {} : { limitPerKind }),
      };

      const output = await engine.getCurrentState(currentStateInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveContinuityReferences(output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createNextStepsTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.nextSteps,
  description: 'Return active next steps ordered for execution.',
  parameters: nextStepsParameters,
  access: 'read',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Read-only projection over existing continuity records.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<GetNextStepsOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.nextSteps);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.nextSteps),
      );
      const limit = readOptionalInteger(payload, 'limit', TOOL_NAMES.nextSteps, {
        minimum: 1,
        maximum: 100,
      });
      const nextStepsInput: GetNextStepsInput = {
        conversationId,
        ...(limit === undefined ? {} : { limit }),
      };

      const output = await engine.getNextSteps(nextStepsInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveContinuityReferences(output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createRecallForTaskTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.recallForTask,
  description: 'Build a compact, evidence-backed continuity context block for a task start.',
  parameters: recallForTaskParameters,
  access: 'read',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Read-only continuity recall that does not mutate LedgerMind state.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<RecallForTaskOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.recallForTask);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.recallForTask),
      );
      const task = readRequiredString(payload, 'task', TOOL_NAMES.recallForTask);
      const budgetTokens = readOptionalInteger(payload, 'budgetTokens', TOOL_NAMES.recallForTask, {
        minimum: 1,
        maximum: 20000,
      });
      const includeHandoff = readOptionalBoolean(
        payload,
        'includeHandoff',
        TOOL_NAMES.recallForTask,
      );
      const includeEvidence = readOptionalBoolean(
        payload,
        'includeEvidence',
        TOOL_NAMES.recallForTask,
      );

      if (budgetTokens === undefined) {
        throw new TypeError(`${TOOL_NAMES.recallForTask} requires "budgetTokens" as an integer.`);
      }

      const recallInput: RecallForTaskInput = {
        conversationId,
        task,
        budgetTokens,
        ...(includeHandoff === undefined ? {} : { includeHandoff }),
        ...(includeEvidence === undefined ? {} : { includeEvidence }),
      };

      const output = await engine.recallForTask(recallInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveContinuityReferences(output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createHandoffTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.createHandoff,
  description: 'Create a structured handoff and optional child next-step continuity records.',
  parameters: handoffParameters,
  access: 'write',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Writes append-only handoff continuity records through the MemoryEngine.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<CreateHandoffOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.createHandoff);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.createHandoff),
      );
      const title = readRequiredString(payload, 'title', TOOL_NAMES.createHandoff);
      const content = readRequiredString(payload, 'content', TOOL_NAMES.createHandoff);
      const completed = readOptionalStringArray(payload, 'completed', TOOL_NAMES.createHandoff) ?? [
        content,
      ];
      const nextSteps = parseNextSteps(payload, TOOL_NAMES.createHandoff) ?? [];
      const provenance = readOptionalProvenance(payload, TOOL_NAMES.createHandoff);
      const idempotencyKey = readOptionalString(
        payload,
        'idempotencyKey',
        TOOL_NAMES.createHandoff,
      );
      const decisions = readOptionalStringArray(payload, 'decisions', TOOL_NAMES.createHandoff);
      const constraints = readOptionalStringArray(payload, 'constraints', TOOL_NAMES.createHandoff);
      const openQuestions = readOptionalStringArray(
        payload,
        'openQuestions',
        TOOL_NAMES.createHandoff,
      );
      const verification = readOptionalStringArray(
        payload,
        'verification',
        TOOL_NAMES.createHandoff,
      );
      const risks = readOptionalStringArray(payload, 'risks', TOOL_NAMES.createHandoff);
      const changedFiles = readOptionalStringArray(
        payload,
        'changedFiles',
        TOOL_NAMES.createHandoff,
      );

      const handoffInput: CreateHandoffInput = {
        conversationId,
        goal: title,
        completed,
        nextSteps,
        ...(decisions === undefined ? {} : { decisions }),
        ...(constraints === undefined ? {} : { constraints }),
        ...(openQuestions === undefined ? {} : { openQuestions }),
        ...(verification === undefined ? {} : { verification }),
        ...(risks === undefined ? {} : { risks }),
        ...(changedFiles === undefined ? {} : { changedFiles }),
        ...(provenance === undefined ? {} : { provenance }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };

      const output = await engine.createHandoff(handoffInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveContinuityReferences(output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

const createMarkStaleTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.markStale,
  description: 'Mark an existing continuity record stale with a durable reason.',
  parameters: markStaleParameters,
  access: 'write',
  requiresApproval: false,
  subAgentOnly: false,
  idempotent: true,
  approvalHint: 'Writes one append-only stale marker continuity record through the MemoryEngine.',
  execute: async (input: unknown): Promise<ToolResponseEnvelope<MarkContinuityRecordOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.markStale);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.markStale),
      );
      const recordId = readRequiredString(payload, 'recordId', TOOL_NAMES.markStale);
      readRequiredString(payload, 'title', TOOL_NAMES.markStale);
      const reason = readRequiredString(payload, 'content', TOOL_NAMES.markStale);
      const supersededByRecordId = readOptionalString(
        payload,
        'supersededByRecordId',
        TOOL_NAMES.markStale,
      );
      const idempotencyKey = readOptionalString(payload, 'idempotencyKey', TOOL_NAMES.markStale);
      const markInput: MarkContinuityRecordInput = {
        conversationId,
        recordId,
        status: 'stale',
        reason,
        ...(supersededByRecordId === undefined ? {} : { supersededByRecordId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };

      const output = await engine.markContinuityRecord(markInput);
      return toReferencedToolSuccessEnvelope(
        output,
        extractReferences(output),
        deriveContinuityReferences(output),
      );
    } catch (error) {
      return toReferencedToolErrorEnvelope(error);
    }
  },
});

export const createCanonicalMemoryToolCatalog = (
  engine: MemoryEngine,
): readonly ToolDefinition[] => {
  assertValidMemoryEngine(engine);

  return [
    createRecallTool(engine),
    createDescribeTool(engine),
    createExpandTool(engine),
    createCurrentStateTool(engine),
    createNextStepsTool(engine),
    createRecallForTaskTool(engine),
    createContinuityRecordTool(
      engine,
      TOOL_NAMES.recordDecision,
      'decision',
      'Record a durable continuity decision.',
    ),
    createContinuityRecordTool(
      engine,
      TOOL_NAMES.recordConstraint,
      'constraint',
      'Record a durable continuity constraint.',
    ),
    createContinuityRecordTool(
      engine,
      TOOL_NAMES.recordProgress,
      'progress',
      'Record durable continuity progress.',
    ),
    createContinuityRecordTool(
      engine,
      TOOL_NAMES.recordVerification,
      'verification',
      'Record durable verification evidence.',
    ),
    createHandoffTool(engine),
    createMarkStaleTool(engine),
  ];
};
