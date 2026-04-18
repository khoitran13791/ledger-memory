import type { ToolDefinition } from '@ledgermind/application';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpServerConfig } from './config';
import type { SessionBindingRuntimeMetadata } from './session-binding';

export interface McpToolAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

interface AuthorizeMcpToolInvocationInput {
  readonly tool: ToolDefinition;
  readonly config: McpServerConfig;
  readonly argumentsInput: Record<string, unknown> | undefined;
  readonly metadata: SessionBindingRuntimeMetadata | undefined;
}

const readTrustedCallerIsSubAgent = (
  metadata: SessionBindingRuntimeMetadata | undefined,
): boolean => metadata?.isSubAgent === true;

export const canExposeMcpTool = (tool: ToolDefinition, config: McpServerConfig): boolean =>
  !(tool.access === 'write' && config.enableWriteTools === false);

export const authorizeMcpToolInvocation = ({
  tool,
  config,
  metadata,
}: AuthorizeMcpToolInvocationInput): McpToolAuthorizationDecision => {
  if (!canExposeMcpTool(tool, config)) {
    return {
      allowed: false,
      reason: `${tool.name} is disabled until write tools are explicitly enabled.`,
    };
  }

  if (tool.subAgentOnly === true && !readTrustedCallerIsSubAgent(metadata)) {
    return {
      allowed: false,
      reason: `${tool.name} requires an authorized sub-agent caller.`,
    };
  }

  return { allowed: true };
};

export const toAuthorizationErrorResult = (toolName: string, reason: string): CallToolResult => ({
  content: [
    {
      type: 'text',
      text: reason,
    },
  ],
  structuredContent: {
    ok: false,
    error: {
      code: 'MCP_TOOL_ACCESS_DENIED',
      message: reason,
      toolName,
    },
  },
  isError: true,
});
