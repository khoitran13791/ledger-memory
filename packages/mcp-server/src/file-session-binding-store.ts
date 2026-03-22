import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createConversationId } from '@ledgermind/domain';

import type {
  SessionBindingLookup,
  SessionBindingRecord,
  SessionBindingStore,
} from './session-binding-store';

interface SerializedSessionBindingRecord {
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly userScope: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
  readonly conversationId: string;
  readonly parentConversationId?: string;
}

const matchesBinding = (candidate: SessionBindingRecord, lookup: SessionBindingLookup): boolean =>
  candidate.runtime === lookup.runtime &&
  candidate.runtimeSessionId === lookup.runtimeSessionId &&
  candidate.userScope === lookup.userScope &&
  candidate.workspaceScope === lookup.workspaceScope &&
  candidate.branchScope === lookup.branchScope;

const deserialize = (binding: SerializedSessionBindingRecord): SessionBindingRecord => ({
  runtime: binding.runtime,
  runtimeSessionId: binding.runtimeSessionId,
  userScope: binding.userScope,
  workspaceScope: binding.workspaceScope,
  ...(binding.branchScope === undefined ? {} : { branchScope: binding.branchScope }),
  conversationId: createConversationId(binding.conversationId),
  ...(binding.parentConversationId === undefined
    ? {}
    : { parentConversationId: createConversationId(binding.parentConversationId) }),
});

const serialize = (binding: SessionBindingRecord): SerializedSessionBindingRecord => ({
  runtime: binding.runtime,
  runtimeSessionId: binding.runtimeSessionId,
  userScope: binding.userScope,
  workspaceScope: binding.workspaceScope,
  ...(binding.branchScope === undefined ? {} : { branchScope: binding.branchScope }),
  conversationId: String(binding.conversationId),
  ...(binding.parentConversationId === undefined
    ? {}
    : { parentConversationId: String(binding.parentConversationId) }),
});

const readBindings = async (bindingStorePath: string): Promise<readonly SessionBindingRecord[]> => {
  try {
    const contents = await readFile(bindingStorePath, 'utf8');
    const parsed = JSON.parse(contents) as SerializedSessionBindingRecord[];
    return parsed.map(deserialize);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const writeBindings = async (
  bindingStorePath: string,
  bindings: readonly SessionBindingRecord[],
): Promise<void> => {
  await mkdir(dirname(bindingStorePath), { recursive: true });
  await writeFile(bindingStorePath, JSON.stringify(bindings.map(serialize), null, 2), 'utf8');
};

export const createFileSessionBindingStore = (bindingStorePath: string): SessionBindingStore => ({
  async find(binding) {
    return (await readBindings(bindingStorePath)).find((candidate) => matchesBinding(candidate, binding));
  },
  async save(binding) {
    const existing = await readBindings(bindingStorePath);
    const next = existing.filter((candidate) => !matchesBinding(candidate, binding));
    next.push(binding);
    await writeBindings(bindingStorePath, next);
  },
  async list() {
    return readBindings(bindingStorePath);
  },
});
