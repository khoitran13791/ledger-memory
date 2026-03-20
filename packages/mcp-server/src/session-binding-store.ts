import type { ConversationId } from '@ledgermind/domain';

export interface SessionBindingRecord {
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly userScope: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
  readonly conversationId: ConversationId;
  readonly parentConversationId?: ConversationId;
}

export interface SessionBindingLookup {
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly userScope: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
}

export interface SessionBindingStore {
  find(binding: SessionBindingLookup): Promise<SessionBindingRecord | undefined>;
  save(binding: SessionBindingRecord): Promise<void>;
  list(): Promise<readonly SessionBindingRecord[]>;
}

export const createInMemorySessionBindingStore = (): SessionBindingStore => {
  const bindings = new Map<string, SessionBindingRecord>();

  const getKey = (binding: SessionBindingLookup): string =>
    JSON.stringify([
      binding.runtime,
      binding.runtimeSessionId,
      binding.userScope,
      binding.workspaceScope,
      binding.branchScope ?? null,
    ]);

  return {
    async find(binding) {
      return bindings.get(getKey(binding));
    },
    async save(binding) {
      bindings.set(getKey(binding), binding);
    },
    async list() {
      return [...bindings.values()];
    },
  };
};
