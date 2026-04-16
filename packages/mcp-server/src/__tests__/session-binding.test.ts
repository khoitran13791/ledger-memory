import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveSessionBinding,
  type ResolveSessionBindingInput,
} from '../session-binding';
import {
  createFileSessionBindingStore,
} from '../file-session-binding-store';
import {
  createInMemorySessionBindingStore,
} from '../session-binding-store';

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

  it('persists child bindings with parent conversation lineage in the file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-mcp-session-binding-'));
    tempDirectories.push(directory);
    const bindingStorePath = join(directory, 'bindings.json');

    const store = createFileSessionBindingStore(bindingStorePath);
    const parent = await resolveSessionBinding(store, createBaseInput({ runtimeSessionId: 'thread-parent' }));
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
