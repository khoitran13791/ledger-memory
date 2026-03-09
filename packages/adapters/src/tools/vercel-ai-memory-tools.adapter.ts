import { jsonSchema, tool, type ToolSet } from 'ai';

import type {
  CallerContext,
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  GrepInput,
  GrepOutput,
  MemoryEngine,
  ToolDefinition,
  ToolProviderPort,
} from '@ledgermind/application';
import { createConversationId, createSummaryNodeId } from '@ledgermind/domain';

import { toToolErrorEnvelope, toToolSuccessEnvelope } from './error-mapping';
import type { ToolReferences, ToolResponseEnvelope } from './types';

const TOOL_NAMES = {
  grep: 'memory.grep',
  describe: 'memory.describe',
  expand: 'memory.expand',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertValidMemoryEngine: (engine: unknown) => asserts engine is MemoryEngine = (
  engine: unknown,
): asserts engine is MemoryEngine => {
  if (!isRecord(engine)) {
    throw new TypeError('createVercelMemoryTools requires a valid MemoryEngine object.');
  }

  const requiredMethods = ['grep', 'describe', 'expand'] as const;

  for (const method of requiredMethods) {
    const candidate = engine[method];
    if (typeof candidate !== 'function') {
      throw new TypeError(`createVercelMemoryTools requires engine.${method}() to be a function.`);
    }
  }
};

const readRequiredString = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): string => {
  const raw = input[field];

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new TypeError(`${toolName} requires "${field}" as a non-empty string.`);
  }

  return raw;
};

const readOptionalString = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): string | undefined => {
  if (!(field in input) || input[field] === undefined) {
    return undefined;
  }

  const raw = input[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new TypeError(`${toolName} expects optional "${field}" to be a non-empty string when provided.`);
  }

  return raw;
};

const readRequiredBoolean = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): boolean => {
  const raw = input[field];

  if (typeof raw !== 'boolean') {
    throw new TypeError(`${toolName} requires "${field}" as a boolean.`);
  }

  return raw;
};

const readRequiredObject = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): Record<string, unknown> => {
  const raw = input[field];

  if (!isRecord(raw)) {
    throw new TypeError(`${toolName} requires "${field}" as an object.`);
  }

  return raw;
};

const parseToolInput = (input: unknown, toolName: string): Record<string, unknown> => {
  if (!isRecord(input)) {
    throw new TypeError(`${toolName} requires an object input payload.`);
  }

  return input;
};

const parseCallerContext = (input: Record<string, unknown>, toolName: string): CallerContext => {
  const callerInput = readRequiredObject(input, 'callerContext', toolName);
  const conversationId = createConversationId(
    readRequiredString(callerInput, 'conversationId', toolName),
  );
  const isSubAgent = readRequiredBoolean(callerInput, 'isSubAgent', toolName);
  const parentConversationId = readOptionalString(callerInput, 'parentConversationId', toolName);

  if (parentConversationId === undefined) {
    return {
      conversationId,
      isSubAgent,
    };
  }

  return {
    conversationId,
    isSubAgent,
    parentConversationId: createConversationId(parentConversationId),
  };
};

const grepParameters: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: {
      type: 'string',
      description: 'Conversation identifier to search within.',
    },
    pattern: {
      type: 'string',
      description: 'Regex pattern used to find matching memory events.',
    },
    scope: {
      type: 'string',
      description: 'Optional summary ID scope for narrowing grep results.',
    },
  },
  required: ['conversationId', 'pattern'],
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

const extractReferences = (data: unknown): ToolReferences | undefined => {
  if (!isRecord(data)) {
    return undefined;
  }

  const references = data['references'];
  if (!isRecord(references)) {
    return undefined;
  }

  const readIdArray = (field: 'summaryIds' | 'artifactIds' | 'eventIds'): readonly string[] | undefined => {
    const value = references[field];
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }

    const ids = value.filter((candidate): candidate is string => typeof candidate === 'string');
    return ids.length > 0 ? ids : undefined;
  };

  const summaryIds = readIdArray('summaryIds');
  const artifactIds = readIdArray('artifactIds');
  const eventIds = readIdArray('eventIds');

  if (summaryIds === undefined && artifactIds === undefined && eventIds === undefined) {
    return undefined;
  }

  return {
    ...(summaryIds !== undefined ? { summaryIds } : {}),
    ...(artifactIds !== undefined ? { artifactIds } : {}),
    ...(eventIds !== undefined ? { eventIds } : {}),
  };
};

const deriveGrepReferences = (scope: string | undefined, output: GrepOutput): ToolReferences | undefined => {
  const eventIds = output.matches
    .map((match) => String(match.eventId))
    .filter((eventId) => eventId.trim().length > 0);

  const dedupedEventIds = mergeReferenceArrays([eventIds]);

  if (scope === undefined && dedupedEventIds === undefined) {
    return undefined;
  }

  return {
    ...(scope === undefined ? {} : { summaryIds: [scope] }),
    ...(dedupedEventIds === undefined ? {} : { eventIds: dedupedEventIds }),
  };
};

const deriveDescribeReferences = (id: string, output: DescribeOutput): ToolReferences | undefined => {
  if (output.kind === 'summary') {
    const summaryIds = mergeReferenceArrays([[id], output.parentIds?.map((parentId) => String(parentId))]);
    if (summaryIds === undefined) {
      return undefined;
    }

    return { summaryIds };
  }

  if (output.kind === 'artifact') {
    return {
      artifactIds: [id],
    };
  }

  return undefined;
};

const mergeReferenceArrays = (
  arrays: ReadonlyArray<readonly string[] | undefined>,
): readonly string[] | undefined => {
  const merged = new Set<string>();

  for (const values of arrays) {
    if (values === undefined) {
      continue;
    }

    for (const value of values) {
      const normalized = value.trim();
      if (normalized.length > 0) {
        merged.add(normalized);
      }
    }
  }

  return merged.size > 0 ? [...merged] : undefined;
};

const mergeReferences = (...references: readonly (ToolReferences | undefined)[]): ToolReferences | undefined => {
  const summaryIds = mergeReferenceArrays(references.map((reference) => reference?.summaryIds));
  const artifactIds = mergeReferenceArrays(references.map((reference) => reference?.artifactIds));
  const eventIds = mergeReferenceArrays(references.map((reference) => reference?.eventIds));

  if (summaryIds === undefined && artifactIds === undefined && eventIds === undefined) {
    return undefined;
  }

  return {
    ...(summaryIds !== undefined ? { summaryIds } : {}),
    ...(artifactIds !== undefined ? { artifactIds } : {}),
    ...(eventIds !== undefined ? { eventIds } : {}),
  };
};

const addArtifactIdFromUnknown = (target: Set<string>, value: unknown): void => {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length > 0) {
      target.add(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addArtifactIdFromUnknown(target, item);
    }
    return;
  }

  if (isRecord(value) && 'id' in value) {
    addArtifactIdFromUnknown(target, value['id']);
  }
};

const deriveExpandReferences = (summaryId: string, output: ExpandOutput): ToolReferences | undefined => {
  const artifactIdSet = new Set<string>();
  const eventIdSet = new Set<string>();

  for (const message of output.messages) {
    if (!isRecord(message)) {
      continue;
    }

    const rawEventId = message['id'];
    if (typeof rawEventId === 'string') {
      const normalizedEventId = rawEventId.trim();
      if (normalizedEventId.length > 0) {
        eventIdSet.add(normalizedEventId);
      }
    }

    const metadata = message['metadata'];
    if (!isRecord(metadata)) {
      continue;
    }

    addArtifactIdFromUnknown(artifactIdSet, metadata['artifactIds']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifact_ids']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifactId']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifact_id']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifacts']);
  }

  const artifactIds = artifactIdSet.size > 0 ? [...artifactIdSet] : undefined;
  const eventIds = eventIdSet.size > 0 ? [...eventIdSet] : undefined;

  return {
    summaryIds: [summaryId],
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(eventIds === undefined ? {} : { eventIds }),
  };
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

const createGrepTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.grep,
  description: 'Search memory with regex across ledger events within a conversation.',
  parameters: grepParameters,
  execute: async (input: unknown): Promise<ToolResponseEnvelope<GrepOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.grep);
      const conversationId = createConversationId(
        readRequiredString(payload, 'conversationId', TOOL_NAMES.grep),
      );
      const pattern = readRequiredString(payload, 'pattern', TOOL_NAMES.grep);
      const scopeRaw = readOptionalString(payload, 'scope', TOOL_NAMES.grep);
      const scope = scopeRaw === undefined ? undefined : createSummaryNodeId(scopeRaw);

      const grepInput: GrepInput =
        scope === undefined
          ? {
              conversationId,
              pattern,
            }
          : {
              conversationId,
              pattern,
              scope,
            };

      const output = await engine.grep(grepInput);
      const references = mergeReferences(
        extractReferences(output),
        deriveGrepReferences(scopeRaw, output),
      );
      return references === undefined
        ? toToolSuccessEnvelope(output)
        : toToolSuccessEnvelope(output, { references });
    } catch (error) {
      return toToolErrorEnvelope(error);
    }
  },
});

const createDescribeTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.describe,
  description: 'Describe memory metadata for a summary or artifact identifier.',
  parameters: describeParameters,
  execute: async (input: unknown): Promise<ToolResponseEnvelope<DescribeOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.describe);
      const id = readRequiredString(payload, 'id', TOOL_NAMES.describe);

      const describeInput: DescribeInput = {
        id: id as DescribeInput['id'],
      };

      const output = await engine.describe(describeInput);
      const references = mergeReferences(
        extractReferences(output),
        deriveDescribeReferences(id, output),
      );
      return references === undefined
        ? toToolSuccessEnvelope(output)
        : toToolSuccessEnvelope(output, { references });
    } catch (error) {
      return toToolErrorEnvelope(error);
    }
  },
});

const createExpandTool = (engine: MemoryEngine): ToolDefinition => ({
  name: TOOL_NAMES.expand,
  description: 'Expand a summary node to recover original ledger messages.',
  parameters: expandParameters,
  execute: async (input: unknown): Promise<ToolResponseEnvelope<ExpandOutput>> => {
    try {
      const payload = parseToolInput(input, TOOL_NAMES.expand);
      const summaryId = createSummaryNodeId(readRequiredString(payload, 'summaryId', TOOL_NAMES.expand));
      const callerContext = parseCallerContext(payload, TOOL_NAMES.expand);

      const expandInput: ExpandInput = {
        summaryId,
        callerContext,
      };

      const output = await engine.expand(expandInput);
      const references = mergeReferences(
        extractReferences(output),
        deriveExpandReferences(String(summaryId), output),
      );
      return references === undefined
        ? toToolSuccessEnvelope(output)
        : toToolSuccessEnvelope(output, { references });
    } catch (error) {
      return toToolErrorEnvelope(error);
    }
  },
});

const createToolDefinitions = (engine: MemoryEngine): ToolDefinition[] => [
  createGrepTool(engine),
  createDescribeTool(engine),
  createExpandTool(engine),
];

export type VercelMemoryToolSet = ToolSet;

/**
 * Creates Vercel AI SDK-native memory tools.
 */
export const createVercelMemoryTools = (engine: MemoryEngine): VercelMemoryToolSet => {
  assertValidMemoryEngine(engine);

  const definitions = createToolDefinitions(engine);

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
  createTools(engine: MemoryEngine): ToolDefinition[] {
    assertValidMemoryEngine(engine);
    return createToolDefinitions(engine);
  }
}
