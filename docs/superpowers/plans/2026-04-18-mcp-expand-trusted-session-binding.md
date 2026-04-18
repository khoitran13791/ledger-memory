# MCP Expand Trusted Session Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `memory.expand` in `@ledgermind/mcp-server` derives sub-agent identity and caller lineage only from trusted runtime/session binding metadata, never from caller-supplied `callerContext.isSubAgent`.

**Architecture:** Keep the authorization policy fix at the MCP adapter boundary. `packages/application/src/use-cases/expand.ts` already enforces child-lineage and ownership once it receives trusted `callerContext`, so this change should make the MCP server deny `subAgentOnly` tools unless trusted metadata marks the caller as a sub-agent and should always overwrite `memory.expand` caller context from the resolved session binding before execution.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspaces, Vitest, MCP SDK, existing `@ledgermind/mcp-server` clean-architecture boundaries.

---

## Scope And Root Cause

- `packages/mcp-server/src/authorization.ts` currently prefers `argumentsInput.callerContext.isSubAgent` over `metadata.isSubAgent`, which lets a caller self-attest `isSubAgent: true`.
- `packages/mcp-server/src/session-binding.ts` only injects `callerContext` for `memory.expand` when the payload omits it, so spoofed `conversationId`, `parentConversationId`, and `isSubAgent` survive even when trusted binding metadata exists.
- `docs/high-level-design.md` is already correct at lines 1183-1190 and 1929-1938. Treat this as an implementation regression, not a product-policy change.
- Do not change `packages/application/src/use-cases/expand.ts` or `packages/adapters/src/auth/sub-agent-authorization.adapter.ts` in this fix. They already enforce the intended policy once the MCP boundary passes trusted caller data.

## File Structure

### Existing Files To Modify

- `packages/mcp-server/src/authorization.ts` - stop reading sub-agent identity from tool arguments; gate `subAgentOnly` tools from trusted session metadata only.
- `packages/mcp-server/src/session-binding.ts` - always overwrite `memory.expand` `callerContext` from the resolved binding plus runtime metadata.
- `packages/mcp-server/src/__tests__/authorization.test.ts` - add unit regressions for self-attested `isSubAgent` and metadata precedence.
- `packages/mcp-server/src/__tests__/session-binding.test.ts` - add helper-level regressions for caller-context overwrite behavior.
- `packages/mcp-server/src/__tests__/server.integration.test.ts` - add an end-to-end MCP test proving spoofed `callerContext` cannot bypass the gate.

### Reference Files Only

- `docs/high-level-design.md` - use as the policy contract; do not edit unless implementation introduces vocabulary that no longer matches the document.

---

### Task 1: Lock The Regression With Red Tests

**Files:**
- Modify: `packages/mcp-server/src/__tests__/authorization.test.ts`
- Modify: `packages/mcp-server/src/__tests__/session-binding.test.ts`
- Modify: `packages/mcp-server/src/__tests__/server.integration.test.ts`

- [ ] **Step 1: Add authorization unit tests that encode trusted-metadata precedence.**

```ts
import type { SessionBindingRuntimeMetadata } from '../session-binding';

const createMetadata = (
  overrides: Partial<SessionBindingRuntimeMetadata> = {},
): SessionBindingRuntimeMetadata => ({
  runtime: 'amp',
  runtimeSessionId: 'thread-001',
  userScope: 'alice',
  workspaceScope: '/workspace/ledger-memory',
  ...overrides,
});

it('denies privileged expand calls when callerContext self-attests sub-agent status without trusted metadata', () => {
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
        conversationId: 'conv_spoofed',
        isSubAgent: true,
      },
    },
  });

  expect(decision).toEqual({
    allowed: false,
    reason: 'memory.expand requires an authorized sub-agent caller.',
  });
});

it('denies privileged expand calls when trusted metadata says the caller is not a sub-agent', () => {
  const tool = createToolDefinition();

  const decision = authorizeMcpToolInvocation({
    tool,
    config: {
      storage: { type: 'in-memory' },
      enableWriteTools: false,
      readOnly: true,
    },
    metadata: createMetadata({ isSubAgent: false }),
    argumentsInput: {
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_spoofed',
        isSubAgent: true,
      },
    },
  });

  expect(decision.allowed).toBe(false);
});

it('allows privileged expand calls only when trusted metadata marks the caller as a sub-agent', () => {
  const tool = createToolDefinition();

  const decision = authorizeMcpToolInvocation({
    tool,
    config: {
      storage: { type: 'in-memory' },
      enableWriteTools: false,
      readOnly: true,
    },
    metadata: createMetadata({ isSubAgent: true }),
    argumentsInput: {
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_spoofed',
        isSubAgent: false,
      },
    },
  });

  expect(decision.allowed).toBe(true);
});
```

- [ ] **Step 2: Add a session-binding test that proves `memory.expand` caller context is overwritten, not merely defaulted.**

```ts
import { createConversationId } from '@ledgermind/domain';

import {
  applySessionBindingToToolArguments,
  resolveSessionBinding,
  type ResolveSessionBindingInput,
  type SessionBindingRuntimeMetadata,
} from '../session-binding';

it('overwrites expand callerContext from the resolved binding and trusted runtime metadata', () => {
  const boundArguments = applySessionBindingToToolArguments(
    'memory.expand',
    {
      summaryId: 'sum_leaf_1',
      callerContext: {
        conversationId: 'conv_spoofed',
        isSubAgent: true,
        parentConversationId: 'conv_spoofed_parent',
      },
    },
    {
      runtime: 'amp',
      runtimeSessionId: 'thread-child',
      userScope: 'alice',
      workspaceScope: '/workspace/ledger-memory',
      conversationId: createConversationId('conv_bound_child'),
      parentConversationId: createConversationId('conv_bound_parent'),
    },
    {
      runtime: 'amp',
      runtimeSessionId: 'thread-child',
      userScope: 'alice',
      workspaceScope: '/workspace/ledger-memory',
      isSubAgent: false,
    } satisfies SessionBindingRuntimeMetadata,
  );

  expect(boundArguments).toEqual({
    summaryId: 'sum_leaf_1',
    callerContext: {
      conversationId: 'conv_bound_child',
      isSubAgent: false,
      parentConversationId: 'conv_bound_parent',
    },
  });
});
```

- [ ] **Step 3: Add an MCP integration regression that proves spoofed `callerContext.isSubAgent` cannot cross the boundary.**

```ts
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
  });

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
```

- [ ] **Step 4: Run the focused regression suite and confirm it is red for the right reasons.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/authorization.test.ts src/__tests__/session-binding.test.ts src/__tests__/server.integration.test.ts`

Expected: FAIL.
- `authorization.test.ts` should fail because `authorizeMcpToolInvocation()` still trusts `callerContext.isSubAgent`.
- `session-binding.test.ts` should fail because `applySessionBindingToToolArguments()` preserves the spoofed `callerContext`.
- `server.integration.test.ts` should fail because `memory.expand` is still treated as authorized when the payload self-attests `isSubAgent: true`.

---

### Task 2: Fix The Authorization Gate To Trust Runtime Metadata Only

**Files:**
- Modify: `packages/mcp-server/src/authorization.ts`
- Test: `packages/mcp-server/src/__tests__/authorization.test.ts`
- Test: `packages/mcp-server/src/__tests__/server.integration.test.ts`

- [ ] **Step 1: Replace the argument-based sub-agent check with a metadata-only check.**

```ts
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
```

- [ ] **Step 2: Re-run the authorization and server regression tests first.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/authorization.test.ts src/__tests__/server.integration.test.ts`

Expected: PASS.

- [ ] **Step 3: Re-run the session-binding regression to prove one red test still remains for caller-context overwrite.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/session-binding.test.ts`

Expected: FAIL because `memory.expand` still preserves caller-supplied `conversationId` / `parentConversationId` / `isSubAgent` when `callerContext` is present.

---

### Task 3: Overwrite `memory.expand` Caller Context From The Trusted Binding

**Files:**
- Modify: `packages/mcp-server/src/session-binding.ts`
- Test: `packages/mcp-server/src/__tests__/session-binding.test.ts`
- Test: `packages/mcp-server/src/__tests__/server.integration.test.ts`

- [ ] **Step 1: Change `applySessionBindingToToolArguments()` so `memory.expand` always gets binding-derived caller context.**

```ts
export const applySessionBindingToToolArguments = (
  toolName: string,
  argumentsInput: Record<string, unknown> | undefined,
  binding: SessionBindingRecord,
  metadata: SessionBindingRuntimeMetadata,
): Record<string, unknown> => {
  const nextArguments = { ...(argumentsInput ?? {}) };

  if (toolName === 'memory.recall' && nextArguments.conversationId === undefined) {
    nextArguments.conversationId = String(binding.conversationId);
  }

  if (toolName === 'memory.expand') {
    nextArguments.callerContext = {
      conversationId: String(binding.conversationId),
      isSubAgent: metadata.isSubAgent === true,
      ...(binding.parentConversationId === undefined
        ? {}
        : { parentConversationId: String(binding.parentConversationId) }),
    };
  }

  return nextArguments;
};
```

- [ ] **Step 2: Re-run the focused regression suite and require all three files to pass together.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/authorization.test.ts src/__tests__/session-binding.test.ts src/__tests__/server.integration.test.ts`

Expected: PASS.

- [ ] **Step 3: Re-run the full `@ledgermind/mcp-server` test package to catch any nearby regressions.**

Run: `pnpm --filter @ledgermind/mcp-server test`

Expected: PASS.

---

### Task 4: Verify The Package And Land The Narrow Fix

**Files:**
- Modify: `packages/mcp-server/src/authorization.ts`
- Modify: `packages/mcp-server/src/session-binding.ts`
- Modify: `packages/mcp-server/src/__tests__/authorization.test.ts`
- Modify: `packages/mcp-server/src/__tests__/session-binding.test.ts`
- Modify: `packages/mcp-server/src/__tests__/server.integration.test.ts`

- [ ] **Step 1: Run package typecheck.**

Run: `pnpm --filter @ledgermind/mcp-server typecheck`

Expected: PASS.

- [ ] **Step 2: Run package lint.**

Run: `pnpm --filter @ledgermind/mcp-server lint`

Expected: PASS.

- [ ] **Step 3: Re-read the policy text and confirm the code now matches the HLD without editing the doc.**

Check:
- `docs/high-level-design.md:1183-1190`
- `docs/high-level-design.md:1929-1938`

Expected: the code now matches the existing rule that runtimes derive or overwrite `isSubAgent` from trusted runtime/session state, so no doc diff is needed for this fix.

- [ ] **Step 4: Commit the fix once package verification is green.**

```bash
git add packages/mcp-server/src/authorization.ts packages/mcp-server/src/session-binding.ts packages/mcp-server/src/__tests__/authorization.test.ts packages/mcp-server/src/__tests__/session-binding.test.ts packages/mcp-server/src/__tests__/server.integration.test.ts
git commit -m "fix: trust runtime-bound expand caller identity"
```

---

## Assumptions And Defaults

- Trusted MCP caller identity for this package is represented by `SessionBindingRuntimeMetadata`; absence of that metadata means `subAgentOnly` tools are not authorized.
- `callerContext` remains part of the `memory.expand` transport payload for compatibility with the canonical tool schema, but the MCP server must treat it as a writable envelope field, not an authority source.
- This plan intentionally does not change application-layer `CallerContext`, `AuthorizationPort`, or `ExpandUseCase` behavior because the reported bug is at the MCP boundary, not in the core engine.
