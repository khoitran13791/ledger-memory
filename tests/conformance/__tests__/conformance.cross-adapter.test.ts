import { runConformance, type ConformanceAdapterDefinition } from '../run-conformance';

import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  InvariantViolationError,
  type EventId,
  type SummaryNodeId,
} from '@ledgermind/domain';
import {
  createInMemoryPersistenceState,
  InMemoryArtifactStore,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
} from '@ledgermind/adapters';

import { createPostgresTestHarness } from '../../../packages/infrastructure/src/postgres/__tests__/postgres-test-harness';

const createConversationCfg = (modelName: string) => {
  return createConversationConfig({
    modelName,
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

const createInMemoryAdapter = (): ConformanceAdapterDefinition => {
  return {
    adapterName: 'in-memory',
    capabilities: {
      fullTextSearch: false,
      regexSearch: true,
      recursiveCTE: true,
      concurrentWrites: false,
    },
    createRuntime: async () => {
      const state = createInMemoryPersistenceState();
      const unitOfWork = new InMemoryUnitOfWork(state);
      const ledger = new InMemoryLedgerStore(state);
      const context = new InMemoryContextProjection(state);
      const dag = new InMemorySummaryDag(state);
      const artifacts = new InMemoryArtifactStore(state);
      const conversations = new InMemoryConversationStore(state);

      const conversation = await conversations.create(createConversationCfg('conformance-in-memory'));

      return {
        defaultConversationId: conversation.id,
        unitOfWork,
        ledger,
        context,
        dag,
        artifacts,
        conversations,
        corruption: {
          canInjectOrphanSummaryMessageEdge: false,
          async injectOrphanSummaryMessageEdge() {
            throw new InvariantViolationError('Orphan edge injection is not supported for in-memory adapter.');
          },
        },
        destroy: async () => undefined,
      };
    },
  };
};

const createPostgresAdapter = (): ConformanceAdapterDefinition => {
  return {
    adapterName: 'postgres',
    capabilities: {
      fullTextSearch: true,
      regexSearch: true,
      recursiveCTE: true,
      concurrentWrites: true,
    },
    createRuntime: async () => {
      const harness = await createPostgresTestHarness();

      const createdConversation = await harness.conversations.create(createConversationCfg('conformance-postgres'));

      return {
        defaultConversationId: createdConversation.id,
        unitOfWork: harness.unitOfWork,
        ledger: harness.ledger,
        context: harness.context,
        dag: harness.dag,
        artifacts: harness.artifacts,
        conversations: harness.conversations,
        corruption: {
          canInjectOrphanSummaryMessageEdge: true,
          async injectOrphanSummaryMessageEdge(input: {
            readonly summaryId: SummaryNodeId;
            readonly missingMessageId: EventId;
          }): Promise<void> {
            await harness.withClient(async (client) => {
              await client.query(`SET session_replication_role = replica`);

              try {
                await client.query(
                  `INSERT INTO summary_message_edges (summary_id, message_id, ord)
                   VALUES ($1, $2, (
                     SELECT COALESCE(MAX(ord), -1) + 1
                     FROM summary_message_edges
                     WHERE summary_id = $1
                   ))`,
                  [input.summaryId, input.missingMessageId],
                );
              } finally {
                await client.query(`SET session_replication_role = DEFAULT`);
              }
            });
          },
        },
        destroy: async () => {
          await harness.destroy();
        },
      };
    },
  };
};

const adapters: readonly ConformanceAdapterDefinition[] = [createInMemoryAdapter(), createPostgresAdapter()];

for (const adapter of adapters) {
  runConformance(adapter);
}
