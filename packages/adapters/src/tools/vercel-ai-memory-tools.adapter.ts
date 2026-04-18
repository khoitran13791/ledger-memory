import { jsonSchema, tool, type ToolSet } from 'ai';

import type {
  AgenticMapInput,
  AgenticMapOutput,
  CallerContext,
  ExpandOutput,
  GetOperatorRunOutput,
  GrepInput,
  GrepOutput,
  LLMMapInput,
  LLMMapOutput,
  MemoryEngine,
  OperatorTaskInspection,
  ToolDefinition,
  ToolProviderPort,
  ToolRuntimeContextProvider,
} from '@ledgermind/application';
import { createSummaryNodeId } from '@ledgermind/domain';

import { toToolErrorEnvelope, toToolSuccessEnvelope } from './error-mapping';
import type { ToolReferences } from './types';

const readRecord = (input: unknown, toolName: string): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${toolName} requires an object input payload.`);
  }

  return input as Record<string, unknown>;
};

const readRequiredString = (input: Record<string, unknown>, field: string, toolName: string): string => {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${toolName} requires "${field}" as a non-empty string.`);
  }

  return value;
};

const readOptionalString = (input: Record<string, unknown>, field: string, toolName: string): string | undefined => {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${toolName} expects optional "${field}" to be a non-empty string when provided.`);
  }

  return value;
};

const readRequiredNumber = (input: Record<string, unknown>, field: string, toolName: string): number => {
  const value = input[field];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`${toolName} requires "${field}" as a number.`);
  }

  return value;
};

const readRequiredObject = (input: Record<string, unknown>, field: string, toolName: string): Record<string, unknown> => {
  const value = input[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${toolName} requires "${field}" as an object.`);
  }

  return value as Record<string, unknown>;
};

const assertValidMemoryEngine: (engine: unknown) => asserts engine is MemoryEngine = (engine: unknown): asserts engine is MemoryEngine => {
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    throw new TypeError('createVercelMemoryTools requires a valid MemoryEngine object.');
  }

  const requiredMethods = ['grep', 'describe', 'expand', 'llmMap', 'agenticMap', 'getOperatorRun'] as const;
  for (const method of requiredMethods) {
    const candidate = (engine as Record<string, unknown>)[method];
    if (typeof candidate !== 'function') {
      throw new TypeError(`createVercelMemoryTools requires engine.${method}() to be a function.`);
    }
  }
};

const assertRuntimeProvider: (runtime: unknown) => asserts runtime is ToolRuntimeContextProvider = (
  runtime: unknown,
): asserts runtime is ToolRuntimeContextProvider => {
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    throw new TypeError('createVercelMemoryTools requires runtime.getCallerContext().');
  }

  const getCallerContext = (runtime as Record<string, unknown>).getCallerContext;
  if (typeof getCallerContext !== 'function') {
    throw new TypeError('createVercelMemoryTools requires runtime.getCallerContext().');
  }
};

const grepParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: 'Query string used to recall relevant memory events.',
    },
    scope: {
      type: 'string',
      description: 'Optional summary ID scope for narrowing recall results.',
    },
  },
  required: ['query'],
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
  },
  required: ['summaryId'],
};

const llmMapParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string' },
    items: { type: 'array' },
    inputArtifactId: { type: 'string' },
    outputSchema: { type: 'object' },
    concurrencyLimit: { type: 'number' },
    retryPolicy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxRetries: { type: 'number' },
        retryBackoffSeconds: { type: 'number' },
      },
      required: ['maxRetries', 'retryBackoffSeconds'],
    },
    idempotencyKey: { type: 'string' },
  },
  required: ['prompt', 'outputSchema', 'concurrencyLimit', 'retryPolicy'],
};

const agenticMapParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskPrompt: { type: 'string' },
    items: { type: 'array' },
    inputArtifactId: { type: 'string' },
    delegatedScope: { type: 'object' },
    keptWork: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string' },
        expectedOutput: { type: 'string' },
      },
      required: ['description', 'expectedOutput'],
    },
    outputSchema: { type: 'object' },
    concurrencyLimit: { type: 'number' },
    retryPolicy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxRetries: { type: 'number' },
        retryBackoffSeconds: { type: 'number' },
      },
      required: ['maxRetries', 'retryBackoffSeconds'],
    },
    idempotencyKey: { type: 'string' },
  },
  required: ['taskPrompt', 'delegatedScope', 'keptWork', 'outputSchema', 'concurrencyLimit', 'retryPolicy'],
};

const getOperatorRunParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
  },
  required: ['runId'],
};

const normalizeIds = (values: ReadonlyArray<string | undefined>): readonly string[] | undefined => {
  const normalized = [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
  return normalized.length > 0 ? normalized : undefined;
};

const mergeReferences = (...references: readonly (ToolReferences | undefined)[]): ToolReferences | undefined => {
  const summaryIds = normalizeIds(references.flatMap((reference) => reference?.summaryIds ?? []));
  const artifactIds = normalizeIds(references.flatMap((reference) => reference?.artifactIds ?? []));
  const eventIds = normalizeIds(references.flatMap((reference) => reference?.eventIds ?? []));
  const conversationIds = normalizeIds(references.flatMap((reference) => reference?.conversationIds ?? []));
  const operatorRunIds = normalizeIds(references.flatMap((reference) => reference?.operatorRunIds ?? []));

  if (
    summaryIds === undefined &&
    artifactIds === undefined &&
    eventIds === undefined &&
    conversationIds === undefined &&
    operatorRunIds === undefined
  ) {
    return undefined;
  }

  return {
    ...(summaryIds === undefined ? {} : { summaryIds }),
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(eventIds === undefined ? {} : { eventIds }),
    ...(conversationIds === undefined ? {} : { conversationIds }),
    ...(operatorRunIds === undefined ? {} : { operatorRunIds }),
  } satisfies ToolReferences;
};

const extractReferences = (data: unknown): ToolReferences | undefined => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }

  const references = (data as Record<string, unknown>).references;
  if (typeof references !== 'object' || references === null || Array.isArray(references)) {
    return undefined;
  }

  const readArray = (field: keyof ToolReferences): readonly string[] | undefined => {
    const value = (references as Record<string, unknown>)[field];
    if (!Array.isArray(value)) {
      return undefined;
    }
    return normalizeIds(value.filter((candidate): candidate is string => typeof candidate === 'string'));
  };

  const summaryIds = readArray('summaryIds');
  const artifactIds = readArray('artifactIds');
  const eventIds = readArray('eventIds');
  const conversationIds = readArray('conversationIds');
  const operatorRunIds = readArray('operatorRunIds');

  return mergeReferences(
    summaryIds === undefined ? undefined : { summaryIds },
    artifactIds === undefined ? undefined : { artifactIds },
    eventIds === undefined ? undefined : { eventIds },
    conversationIds === undefined ? undefined : { conversationIds },
    operatorRunIds === undefined ? undefined : { operatorRunIds },
  );
};

const deriveGrepReferences = (scope: string | undefined, output: GrepOutput): ToolReferences | undefined => {
  const eventIds = normalizeIds(output.matches.map((match) => String(match.eventId)));
  return mergeReferences({
    ...(scope === undefined ? {} : { summaryIds: [scope] }),
    ...(eventIds === undefined ? {} : { eventIds }),
  });
};

const deriveDescribeReferences = (id: string, output: Awaited<ReturnType<MemoryEngine['describe']>>): ToolReferences | undefined => {
  if (output.kind === 'artifact') {
    return { artifactIds: [id] };
  }

  const summaryIds = normalizeIds([id, ...(output.parentIds?.map((parentId) => String(parentId)) ?? [])]);
  return summaryIds === undefined ? undefined : { summaryIds };
};

const addArtifactIdFromUnknown = (target: Set<string>, value: unknown): void => {
  if (typeof value === 'string') {
    if (value.trim().length > 0) {
      target.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addArtifactIdFromUnknown(target, item);
    }
    return;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value) {
    addArtifactIdFromUnknown(target, (value as { id?: unknown }).id);
  }
};

const deriveExpandReferences = (summaryId: string, output: ExpandOutput): ToolReferences | undefined => {
  const artifactIds = new Set<string>();
  const eventIds = normalizeIds(
    output.messages.flatMap((message: unknown) => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        return [];
      }

      const messageRecord = message as Record<string, unknown>;
      const metadata = messageRecord.metadata;
      if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
        const metadataRecord = metadata as Record<string, unknown>;
        addArtifactIdFromUnknown(artifactIds, metadataRecord.artifactIds);
        addArtifactIdFromUnknown(artifactIds, metadataRecord.artifact_ids);
        addArtifactIdFromUnknown(artifactIds, metadataRecord.artifactId);
        addArtifactIdFromUnknown(artifactIds, metadataRecord.artifact_id);
        addArtifactIdFromUnknown(artifactIds, metadataRecord.artifacts);
      }

      const id = messageRecord.id;
      return typeof id === 'string' ? [id] : [];
    }),
  );

  return mergeReferences({
    summaryIds: [summaryId],
    ...(artifactIds.size === 0 ? {} : { artifactIds: [...artifactIds] }),
    ...(eventIds === undefined ? {} : { eventIds }),
  });
};

const toSuccessEnvelope = <TData>(data: TData, references?: ToolReferences) =>
  references === undefined ? toToolSuccessEnvelope(data) : toToolSuccessEnvelope(data, { references });

const toError = (error: unknown, references?: ToolReferences) => toToolErrorEnvelope(error, references);

const getCallerContext = (runtime: ToolRuntimeContextProvider): CallerContext => runtime.getCallerContext();

const createCompactMapOutput = (output: LLMMapOutput | AgenticMapOutput) => ({
  runId: output.runId,
  status: output.status,
  ...(output.inputArtifactId === undefined ? {} : { inputArtifactId: String(output.inputArtifactId) }),
});

const summarizeChildConversationIds = (tasks: readonly OperatorTaskInspection[]): readonly string[] | undefined =>
  normalizeIds(tasks.map((task) => (task.childConversationId === undefined ? undefined : String(task.childConversationId))));

const createCompactRunOutput = (output: GetOperatorRunOutput) => ({
  runId: output.runId,
  operatorKind: output.operatorKind,
  status: output.status,
  taskCount: output.taskCount,
  succeededTaskCount: output.succeededTaskCount,
  failedTaskCount: output.failedTaskCount,
  retryableFailureTaskCount: output.retryableFailureTaskCount,
  runningTaskCount: output.runningTaskCount,
  pendingTaskCount: output.pendingTaskCount,
  ...(output.inputArtifactId === undefined ? {} : { inputArtifactId: String(output.inputArtifactId) }),
  ...(output.outputArtifactId === undefined ? {} : { outputArtifactId: String(output.outputArtifactId) }),
  ...(summarizeChildConversationIds(output.tasks) === undefined
    ? {}
    : { childConversationIds: summarizeChildConversationIds(output.tasks) }),
});

const createToolDefinitions = (
  engineInput: MemoryEngine,
  runtimeInput: ToolRuntimeContextProvider,
): readonly ToolDefinition[] => {
  assertValidMemoryEngine(engineInput);
  assertRuntimeProvider(runtimeInput);

  const engine: MemoryEngine = engineInput;
  const runtime: ToolRuntimeContextProvider = runtimeInput;

  return [
    {
      name: 'memory.grep',
      description: 'Recall relevant memory events within the bound conversation using a query string.',
      parameters: grepParameters,
      access: 'read',
      requiresApproval: false,
      subAgentOnly: false,
      idempotent: true,
      execute: async (input: unknown) => {
        try {
          const payload = readRecord(input, 'memory.grep');
          const callerContext = getCallerContext(runtime);
          const query = readRequiredString(payload, 'query', 'memory.grep');
          const scope = readOptionalString(payload, 'scope', 'memory.grep');

          const grepInput: GrepInput = {
            conversationId: callerContext.conversationId,
            pattern: query,
            ...(scope === undefined ? {} : { scope: createSummaryNodeId(scope) }),
          };

          const output = await engine.grep(grepInput);
          return toSuccessEnvelope(
            output,
            mergeReferences(
              { conversationIds: [String(callerContext.conversationId)] },
              extractReferences(output),
              deriveGrepReferences(scope, output),
            ),
          );
        } catch (error) {
          return toError(error);
        }
      },
    },
    {
      name: 'memory.describe',
      description: 'Describe memory metadata for a summary or artifact identifier.',
      parameters: describeParameters,
      access: 'read',
      requiresApproval: false,
      subAgentOnly: false,
      idempotent: true,
      execute: async (input: unknown) => {
        try {
          const payload = readRecord(input, 'memory.describe');
          const id = readRequiredString(payload, 'id', 'memory.describe');
          const output = await engine.describe({ id: id as never });
          return toSuccessEnvelope(output, mergeReferences(extractReferences(output), deriveDescribeReferences(id, output)));
        } catch (error) {
          return toError(error);
        }
      },
    },
    {
      name: 'memory.expand',
      description: 'Expand a summary node to recover original ledger messages.',
      parameters: expandParameters,
      access: 'privileged',
      requiresApproval: true,
      subAgentOnly: true,
      idempotent: true,
      execute: async (input: unknown) => {
        try {
          const payload = readRecord(input, 'memory.expand');
          const callerContext = getCallerContext(runtime);
          const summaryId = createSummaryNodeId(readRequiredString(payload, 'summaryId', 'memory.expand'));
          const output = await engine.expand({ summaryId, callerContext });
          return toSuccessEnvelope(
            output,
            mergeReferences(
              { conversationIds: [String(callerContext.conversationId)] },
              extractReferences(output),
              deriveExpandReferences(String(summaryId), output),
            ),
          );
        } catch (error) {
          return toError(error);
        }
      },
    },
    {
      name: 'memory.llmMap',
      description: 'Submit a durable llmMap operator run for the bound conversation.',
      parameters: llmMapParameters,
      access: 'write',
      requiresApproval: true,
      subAgentOnly: false,
      idempotent: false,
      execute: async (input: unknown) => {
        try {
          const payload = readRecord(input, 'memory.llmMap');
          const callerContext = getCallerContext(runtime);
          const retryPolicy = readRequiredObject(payload, 'retryPolicy', 'memory.llmMap');
          const llmMapItems = Array.isArray(payload.items) ? payload.items : undefined;
          const llmMapInputArtifactId =
            typeof payload.inputArtifactId === 'string'
              ? (payload.inputArtifactId as LLMMapInput['inputArtifactId'])
              : undefined;
          const llmMapIdempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined;
          const llmMapInput = {
            conversationId: callerContext.conversationId,
            prompt: readRequiredString(payload, 'prompt', 'memory.llmMap'),
            outputSchema: readRequiredObject(payload, 'outputSchema', 'memory.llmMap'),
            concurrencyLimit: readRequiredNumber(payload, 'concurrencyLimit', 'memory.llmMap'),
            retryPolicy: {
              maxRetries: readRequiredNumber(retryPolicy, 'maxRetries', 'memory.llmMap'),
              retryBackoffSeconds: readRequiredNumber(retryPolicy, 'retryBackoffSeconds', 'memory.llmMap'),
            },
            ...(llmMapItems === undefined ? {} : { items: llmMapItems }),
            ...(llmMapInputArtifactId === undefined ? {} : { inputArtifactId: llmMapInputArtifactId }),
            ...(llmMapIdempotencyKey === undefined ? {} : { idempotencyKey: llmMapIdempotencyKey }),
          } satisfies LLMMapInput;

          const output = await engine.llmMap(llmMapInput);
          return toSuccessEnvelope(
            createCompactMapOutput(output),
            mergeReferences(
              { conversationIds: [String(callerContext.conversationId)], operatorRunIds: [output.runId] },
              output.inputArtifactId === undefined ? undefined : { artifactIds: [String(output.inputArtifactId)] },
            ),
          );
        } catch (error) {
          return toError(error);
        }
      },
    },
    {
      name: 'memory.agenticMap',
      description: 'Submit a durable agenticMap operator run for the bound conversation.',
      parameters: agenticMapParameters,
      access: 'write',
      requiresApproval: true,
      subAgentOnly: false,
      idempotent: false,
      execute: async (input: unknown) => {
        try {
          const payload = readRecord(input, 'memory.agenticMap');
          const callerContext = getCallerContext(runtime);
          const retryPolicy = readRequiredObject(payload, 'retryPolicy', 'memory.agenticMap');
          const keptWork = readRequiredObject(payload, 'keptWork', 'memory.agenticMap');
          const agenticMapItems = Array.isArray(payload.items) ? payload.items : undefined;
          const agenticMapInputArtifactId =
            typeof payload.inputArtifactId === 'string'
              ? (payload.inputArtifactId as AgenticMapInput['inputArtifactId'])
              : undefined;
          const agenticMapIdempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined;
          const agenticMapInput = {
            conversationId: callerContext.conversationId,
            taskPrompt: readRequiredString(payload, 'taskPrompt', 'memory.agenticMap'),
            delegatedScope: readRequiredObject(payload, 'delegatedScope', 'memory.agenticMap') as AgenticMapInput['delegatedScope'],
            keptWork: {
              description: readRequiredString(keptWork, 'description', 'memory.agenticMap'),
              expectedOutput: readRequiredString(keptWork, 'expectedOutput', 'memory.agenticMap'),
            },
            outputSchema: readRequiredObject(payload, 'outputSchema', 'memory.agenticMap'),
            concurrencyLimit: readRequiredNumber(payload, 'concurrencyLimit', 'memory.agenticMap'),
            retryPolicy: {
              maxRetries: readRequiredNumber(retryPolicy, 'maxRetries', 'memory.agenticMap'),
              retryBackoffSeconds: readRequiredNumber(retryPolicy, 'retryBackoffSeconds', 'memory.agenticMap'),
            },
            ...(agenticMapItems === undefined ? {} : { items: agenticMapItems }),
            ...(agenticMapInputArtifactId === undefined ? {} : { inputArtifactId: agenticMapInputArtifactId }),
            ...(agenticMapIdempotencyKey === undefined ? {} : { idempotencyKey: agenticMapIdempotencyKey }),
          } satisfies AgenticMapInput;

          const output = await engine.agenticMap(agenticMapInput);
          return toSuccessEnvelope(
            createCompactMapOutput(output),
            mergeReferences(
              { conversationIds: [String(callerContext.conversationId)], operatorRunIds: [output.runId] },
              output.inputArtifactId === undefined ? undefined : { artifactIds: [String(output.inputArtifactId)] },
            ),
          );
        } catch (error) {
          return toError(error);
        }
      },
    },
    {
      name: 'memory.getOperatorRun',
      description: 'Inspect compact durable operator run status and handles.',
      parameters: getOperatorRunParameters,
      access: 'read',
      requiresApproval: false,
      subAgentOnly: false,
      idempotent: true,
      execute: async (input: unknown) => {
        try {
          const payload = readRecord(input, 'memory.getOperatorRun');
          const callerContext = getCallerContext(runtime);
          const output = await engine.getOperatorRun({ runId: readRequiredString(payload, 'runId', 'memory.getOperatorRun') });
          if (String(output.conversationId) !== String(callerContext.conversationId)) {
            throw new Error('Operator run does not belong to the bound runtime conversation.');
          }
          const childConversationIds = summarizeChildConversationIds(output.tasks);
          const referencedConversationIds = normalizeIds([String(output.conversationId), ...(childConversationIds ?? [])]);
          const referencedArtifactIds = normalizeIds([
            output.inputArtifactId === undefined ? undefined : String(output.inputArtifactId),
            output.outputArtifactId === undefined ? undefined : String(output.outputArtifactId),
          ]);
          return toSuccessEnvelope(
            createCompactRunOutput(output),
            mergeReferences(
              referencedConversationIds === undefined
                ? { operatorRunIds: [output.runId] }
                : {
                    conversationIds: referencedConversationIds,
                    operatorRunIds: [output.runId],
                  },
              referencedArtifactIds === undefined ? undefined : { artifactIds: referencedArtifactIds },
            ),
          );
        } catch (error) {
          return toError(error);
        }
      },
    },
  ];
};

export type VercelMemoryToolSet = ToolSet;

/**
 * Creates Vercel AI SDK-native memory tools from the canonical memory tool catalog.
 */
export const createVercelMemoryTools = (
  engine: MemoryEngine,
  runtime: ToolRuntimeContextProvider,
): VercelMemoryToolSet => {
  const definitions = createToolDefinitions(engine, runtime);

  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
        execute: async (input: unknown) => definition.execute(input),
      }),
    ]),
  ) as VercelMemoryToolSet;
};

export const createVercelTools = createVercelMemoryTools;

export class VercelAiMemoryToolsAdapter implements ToolProviderPort {
  createTools(engine: MemoryEngine, runtime: ToolRuntimeContextProvider): ToolDefinition[] {
    return [...createToolDefinitions(engine, runtime)];
  }
}
