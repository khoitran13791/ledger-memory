import type { ToolDefinition } from '@ledgermind/application';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolRegistration {
  readonly tool: Tool;
  execute(argumentsInput?: Record<string, unknown>): Promise<CallToolResult>;
}

const toToolAnnotations = (definition: ToolDefinition): Tool['annotations'] => ({
  readOnlyHint: definition.access === 'read',
  destructiveHint: definition.access === 'write',
  idempotentHint: definition.idempotent,
  openWorldHint: false,
});

const toToolMeta = (definition: ToolDefinition): Tool['_meta'] => ({
  'ledgermind/access': definition.access,
  'ledgermind/requiresApproval': definition.requiresApproval,
  'ledgermind/subAgentOnly': definition.subAgentOnly,
  ...(definition.approvalHint === undefined ? {} : { 'ledgermind/approvalHint': definition.approvalHint }),
});

const toStructuredContent = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
};

const toTextContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
};

const toCallToolResult = (value: unknown): CallToolResult => {
  const structuredContent = toStructuredContent(value);
  const isError = structuredContent?.ok === false ? true : undefined;

  return {
    content: [
      {
        type: 'text',
        text: toTextContent(value),
      },
    ],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(isError === undefined ? {} : { isError }),
  };
};

const toMcpTool = (definition: ToolDefinition): Tool => ({
  name: definition.name,
  description: definition.description,
  inputSchema: definition.parameters as Tool['inputSchema'],
  annotations: toToolAnnotations(definition),
  _meta: toToolMeta(definition),
});

export const createMcpToolRegistry = (
  catalog: readonly ToolDefinition[],
): readonly McpToolRegistration[] =>
  catalog.map((definition) => ({
    tool: toMcpTool(definition),
    execute: async (argumentsInput: Record<string, unknown> = {}) =>
      toCallToolResult(await definition.execute(argumentsInput)),
  }));
