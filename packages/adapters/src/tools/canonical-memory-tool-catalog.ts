import type {
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  GrepInput,
  GrepOutput,
  MemoryEngine,
  ToolDefinition,
} from '@ledgermind/application';
import { createConversationId, createSummaryNodeId } from '@ledgermind/domain';

import {
  assertValidMemoryEngine,
  parseCallerContext,
  parseToolInput,
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
} from './shared/input-parsers';
import {
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
} as const;

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
      const conversationId = createConversationId(readRequiredString(payload, 'conversationId', TOOL_NAMES.recall));
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
  approvalHint: 'Expanding a summary can reveal raw historical context and should stay sub-agent scoped.',
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

export const createCanonicalMemoryToolCatalog = (engine: MemoryEngine): readonly ToolDefinition[] => {
  assertValidMemoryEngine(engine);

  return [createRecallTool(engine), createDescribeTool(engine), createExpandTool(engine)];
};
