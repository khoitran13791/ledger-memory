import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationId } from '@ledgermind/domain';

import {
  applySessionBindingToToolArguments,
  resolveSessionBinding,
  type ResolveSessionBindingInput,
  type SessionBindingRuntimeMetadata,
} from '../session-binding';
import { createFileSessionBindingStore } from '../file-session-binding-store';
import { createInMemorySessionBindingStore } from '../session-binding-store';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

const createBaseInput = (
  overrides: Partial<ResolveSessionBindingInput> = {},
): ResolveSessionBindingInput => ({
  runtime: 'amp',
  runtimeSessionId: 'thread-001',
  userScope: 'alice',
  workspaceScope: '/workspace/ledger-memory',
  ...overrides,
});

describe('resolveSessionBinding', () => {
  it('reuses conversation ids for the same runtime session and isolates different workspaces', async () => {
    const store = createInMemorySessionBindingStore();

    const first = await resolveSessionBinding(store, createBaseInput());
    const second = await resolveSessionBinding(store, createBaseInput());
    const otherWorkspace = await resolveSessionBinding(
      store,
      createBaseInput({ workspaceScope: '/workspace/another-repo' }),
    );

    expect(String(second.conversationId)).toBe(String(first.conversationId));
    expect(String(otherWorkspace.conversationId)).not.toBe(String(first.conversationId));
  });

  it('creates a new binding with the supplied conversation factory once and reuses that conversation id', async () => {
    const store = createInMemorySessionBindingStore();
    const conversationId = createConversationId('conv_real_thread_001');
    const createConversation = vi.fn(async () => conversationId);

    const first = await resolveSessionBinding(
      store,
      createBaseInput({
        createConversation,
      }),
    );
    const second = await resolveSessionBinding(
      store,
      createBaseInput({
        createConversation,
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createConversation).toHaveBeenCalledWith({});
    expect(String(first.conversationId)).toBe('conv_real_thread_001');
    expect(String(second.conversationId)).toBe('conv_real_thread_001');
  });

  it('passes parent conversation id to the supplied factory and stores parent conversation lineage', async () => {
    const store = createInMemorySessionBindingStore();
    const parentConversationId = createConversationId('conv_real_parent');
    const childConversationId = createConversationId('conv_real_child');
    const createParentConversation = vi.fn(async () => parentConversationId);
    const createChildConversation = vi.fn(async () => childConversationId);

    const parent = await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-parent',
        createConversation: createParentConversation,
      }),
    );
    const child = await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-child',
        parentRuntimeSessionId: 'thread-parent',
        createConversation: createChildConversation,
      }),
    );

    expect(createParentConversation).toHaveBeenCalledWith({});
    expect(createChildConversation).toHaveBeenCalledTimes(1);
    expect(createChildConversation).toHaveBeenCalledWith({
      parentConversationId,
    });
    expect(String(parent.conversationId)).toBe('conv_real_parent');
    expect(String(child.conversationId)).toBe('conv_real_child');
    expect(child.parentConversationId).toBe(parentConversationId);
  });

  it('rejects explicit parent runtime sessions that are not bound', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi.fn(async () => createConversationId('conv_should_not_create'));

    await expect(
      resolveSessionBinding(
        store,
        createBaseInput({
          runtimeSessionId: 'thread-child',
          parentRuntimeSessionId: 'thread-missing-parent',
          createConversation,
        }),
      ),
    ).rejects.toThrow('Parent runtime session "thread-missing-parent" is not bound.');
    expect(createConversation).not.toHaveBeenCalled();
  });

  it('keeps existing parentless bindings instead of rebinding them to a later parent', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi
      .fn()
      .mockResolvedValueOnce(createConversationId('conv_existing_root'))
      .mockResolvedValueOnce(createConversationId('conv_parent_root'));

    const original = await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-child',
        createConversation,
      }),
    );
    const parent = await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-parent',
        createConversation,
      }),
    );
    const unchanged = await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-child',
        parentRuntimeSessionId: 'thread-parent',
        createConversation,
      }),
    );

    expect(parent.conversationId).toBe(createConversationId('conv_parent_root'));
    expect(unchanged.conversationId).toBe(original.conversationId);
    expect(unchanged.parentConversationId).toBeUndefined();
    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it('rejects explicit parent runtime sessions that differ from existing parent lineage', async () => {
    const store = createInMemorySessionBindingStore();
    const createConversation = vi
      .fn()
      .mockResolvedValueOnce(createConversationId('conv_parent_a'))
      .mockResolvedValueOnce(createConversationId('conv_child'))
      .mockResolvedValueOnce(createConversationId('conv_parent_b'));

    await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-parent-a',
        createConversation,
      }),
    );
    await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-child',
        parentRuntimeSessionId: 'thread-parent-a',
        createConversation,
      }),
    );
    await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-parent-b',
        createConversation,
      }),
    );

    await expect(
      resolveSessionBinding(
        store,
        createBaseInput({
          runtimeSessionId: 'thread-child',
          parentRuntimeSessionId: 'thread-parent-b',
          createConversation,
        }),
      ),
    ).rejects.toThrow(
      'Runtime session "thread-child" is already bound to a different parent conversation.',
    );
    expect(createConversation).toHaveBeenCalledTimes(3);
  });

  it('persists child bindings with parent conversation lineage in the file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-mcp-session-binding-'));
    tempDirectories.push(directory);
    const bindingStorePath = join(directory, 'bindings.json');

    const store = createFileSessionBindingStore(bindingStorePath);
    const parent = await resolveSessionBinding(
      store,
      createBaseInput({ runtimeSessionId: 'thread-parent' }),
    );
    const child = await resolveSessionBinding(
      store,
      createBaseInput({
        runtimeSessionId: 'thread-child',
        parentRuntimeSessionId: 'thread-parent',
      }),
    );

    const reloadedStore = createFileSessionBindingStore(bindingStorePath);
    const reloadedChild = await resolveSessionBinding(
      reloadedStore,
      createBaseInput({
        runtimeSessionId: 'thread-child',
        parentRuntimeSessionId: 'thread-parent',
      }),
    );

    expect(String(child.parentConversationId)).toBe(String(parent.conversationId));
    expect(String(reloadedChild.conversationId)).toBe(String(child.conversationId));
    expect(String(reloadedChild.parentConversationId)).toBe(String(parent.conversationId));
  });
});

describe('applySessionBindingToToolArguments', () => {
  it.each([
    'memory.currentState',
    'memory.nextSteps',
    'memory.recallForTask',
    'memory.recordDecision',
    'memory.recordConstraint',
    'memory.recordProgress',
    'memory.recordVerification',
    'memory.createHandoff',
    'memory.markStale',
  ])('overwrites spoofed conversationId for %s from the resolved binding', (toolName) => {
    const boundArguments = applySessionBindingToToolArguments(
      toolName,
      {
        conversationId: 'conv_spoofed',
        title: 'Keep title',
      },
      {
        runtime: 'amp',
        runtimeSessionId: 'thread-root',
        userScope: 'alice',
        workspaceScope: '/workspace/ledger-memory',
        conversationId: createConversationId('conv_bound_root'),
      },
      {
        runtime: 'amp',
        runtimeSessionId: 'thread-root',
        userScope: 'alice',
        workspaceScope: '/workspace/ledger-memory',
        isSubAgent: false,
      } satisfies SessionBindingRuntimeMetadata,
    );

    expect(boundArguments).toEqual({
      conversationId: 'conv_bound_root',
      title: 'Keep title',
    });
  });

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
});
