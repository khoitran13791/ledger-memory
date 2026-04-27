import { describe, expect, it, vi } from 'vitest';

import { createConversationId } from '@ledgermind/domain';
import { createInMemorySessionBindingStore } from '@ledgermind/mcp-server';

import type { CockpitConfig } from '../config';
import { createCockpitRuntime, resolveCockpitBinding } from '../runtime';

const baseConfig: CockpitConfig = {
  storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
  bindingStorePath: '.ledgermind/session-bindings.json',
  runtimeSessionId: 'workspace',
  userScope: 'khoi',
  workspaceScope: '/repo',
  output: 'human',
};

describe('resolveCockpitBinding', () => {
  it('creates a real conversation for a new workspace binding', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi.fn(async () => createConversationId('conv_cli_001'));

    const binding = await resolveCockpitBinding({
      store,
      config: baseConfig,
      createConversation,
    });

    expect(binding.conversationId).toBe(createConversationId('conv_cli_001'));
    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing workspace binding', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi.fn(async () => createConversationId('conv_cli_001'));

    await resolveCockpitBinding({
      store,
      config: baseConfig,
      createConversation,
    });
    await resolveCockpitBinding({
      store,
      config: baseConfig,
      createConversation,
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('propagates branch scope into the binding lookup', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi.fn(async () => createConversationId('conv_cli_001'));

    const binding = await resolveCockpitBinding({
      store,
      config: { ...baseConfig, branchScope: 'main' },
      createConversation,
    });

    expect(binding.branchScope).toBe('main');
  });

  it('propagates parent runtime session into the binding lookup', async () => {
    const store = createInMemorySessionBindingStore();
    const createParentConversation = vi.fn(async () => createConversationId('conv_cli_parent'));
    const createChildConversation = vi.fn(async () => createConversationId('conv_cli_child'));

    const parent = await resolveCockpitBinding({
      store,
      config: { ...baseConfig, runtimeSessionId: 'parent-runtime' },
      createConversation: createParentConversation,
    });
    const child = await resolveCockpitBinding({
      store,
      config: {
        ...baseConfig,
        runtimeSessionId: 'child-runtime',
        parentRuntimeSessionId: 'parent-runtime',
      },
      createConversation: createChildConversation,
    });

    expect(child.parentConversationId).toBe(parent.conversationId);
    expect(createChildConversation).toHaveBeenCalledWith({
      parentConversationId: parent.conversationId,
    });
  });
});

describe('createCockpitRuntime', () => {
  it('requires postgres durable storage', () => {
    expect(() =>
      createCockpitRuntime({
        ...baseConfig,
        storage: { type: 'in-memory' },
      }),
    ).toThrow(
      'Memory commands need --db or LEDGERMIND_DB_URL for durable storage. Run ledgermind doctor for setup help.',
    );
  });
});
