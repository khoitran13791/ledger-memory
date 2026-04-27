import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  type ConversationId,
} from '@ledgermind/domain';
import { asPgExecutor, createPgPool, PgConversationStore } from '@ledgermind/infrastructure';
import {
  createFileSessionBindingStore,
  resolveSessionBinding,
  type SessionBindingRecord,
  type SessionBindingStore,
} from '@ledgermind/mcp-server';
import { createPostgresMemoryEngine, type MemoryEngine } from '@ledgermind/sdk';

import type { CockpitConfig } from './config';

const DURABLE_STORAGE_ERROR =
  'Memory commands need --db or LEDGERMIND_DB_URL for durable storage. Run ledgermind doctor for setup help.';

export interface CockpitRuntime {
  readonly engine: MemoryEngine;
  readonly bindingStore: SessionBindingStore;
  readonly resolveBinding: () => Promise<SessionBindingRecord>;
  close(): Promise<void>;
}

export interface ResolveCockpitBindingInput {
  readonly store: SessionBindingStore;
  readonly config: CockpitConfig;
  createConversation(input: { readonly parentConversationId?: ConversationId }): Promise<ConversationId>;
}

const createDefaultConversationConfig = () =>
  createConversationConfig({
    modelName: 'ledgermind-cli',
    contextWindow: createTokenCount(32_768),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });

export const resolveCockpitBinding = ({
  store,
  config,
  createConversation,
}: ResolveCockpitBindingInput): Promise<SessionBindingRecord> =>
  resolveSessionBinding(store, {
    runtime: 'ledgermind-cli',
    runtimeSessionId: config.runtimeSessionId,
    ...(config.parentRuntimeSessionId === undefined
      ? {}
      : { parentRuntimeSessionId: config.parentRuntimeSessionId }),
    userScope: config.userScope,
    workspaceScope: config.workspaceScope,
    ...(config.branchScope === undefined ? {} : { branchScope: config.branchScope }),
    createConversation,
  });

export const createCockpitRuntime = (config: CockpitConfig): CockpitRuntime => {
  if (config.storage.type !== 'postgres') {
    throw new Error(DURABLE_STORAGE_ERROR);
  }

  const pool = createPgPool({ connectionString: config.storage.connectionString });
  const executor = asPgExecutor(pool);
  const conversations = new PgConversationStore(executor);
  const engine = createPostgresMemoryEngine({
    connectionString: config.storage.connectionString,
    executor,
  });
  const bindingStore = createFileSessionBindingStore(config.bindingStorePath);

  return {
    engine,
    bindingStore,
    resolveBinding: () =>
      resolveCockpitBinding({
        store: bindingStore,
        config,
        createConversation: async ({ parentConversationId }) => {
          const conversation = await conversations.create(
            createDefaultConversationConfig(),
            parentConversationId,
          );
          return conversation.id;
        },
      }),
    async close() {
      await pool.end();
    },
  };
};
