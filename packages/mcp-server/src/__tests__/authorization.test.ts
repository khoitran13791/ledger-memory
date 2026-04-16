import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '@ledgermind/application';

import {
  authorizeMcpToolInvocation,
  canExposeMcpTool,
} from '../authorization';

const createToolDefinition = (
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition => ({
  name: 'memory.expand',
  description: 'Expand a summary node to recover original ledger messages.',
  parameters: { type: 'object', properties: {}, required: [] },
  access: 'privileged',
  requiresApproval: true,
  subAgentOnly: true,
  idempotent: true,
  execute: async () => ({ ok: true, data: {} }),
  ...overrides,
});

describe('MCP authorization policy', () => {
  it('blocks privileged expand calls when the caller is not an authorized sub-agent', () => {
    const tool = createToolDefinition();

    const decision = authorizeMcpToolInvocation({
      tool,
      config: {
        storage: { type: 'in-memory' },
        enableWriteTools: false,
        readOnly: true,
      },
      metadata: undefined,
      argumentsInput: {
        summaryId: 'sum_leaf_1',
        callerContext: {
          conversationId: 'conv_1',
          isSubAgent: false,
        },
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('authorized sub-agent');
  });

  it('hides write tools unless the server config explicitly enables them', () => {
    const writeTool = createToolDefinition({
      name: 'memory.store',
      access: 'write',
      requiresApproval: true,
      subAgentOnly: false,
    });

    expect(
      canExposeMcpTool(writeTool, {
        storage: { type: 'in-memory' },
        enableWriteTools: false,
        readOnly: true,
      }),
    ).toBe(false);

    expect(
      canExposeMcpTool(writeTool, {
        storage: { type: 'in-memory' },
        enableWriteTools: true,
        readOnly: false,
      }),
    ).toBe(true);
  });
});
