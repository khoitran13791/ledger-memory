import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  type EventId,
  type SummaryNodeId,
} from '@ledgermind/domain';

import {
  createSqliteUnitOfWork,
  openSqliteDatabase,
  SqliteArtifactStore,
  SqliteContextProjection,
  SqliteConversationStore,
  SqliteLedgerStore,
  SqliteOperatorExecutionStore,
  SqliteSummaryDag,
} from '../../packages/infrastructure/src/sqlite';

import type { ConformanceAdapterDefinition } from './run-conformance';

const createConversationCfg = (modelName: string) => {
  return createConversationConfig({
    modelName,
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

export const createSqliteAdapter = (): ConformanceAdapterDefinition => {
  return {
    adapterName: 'sqlite',
    capabilities: {
      fullTextSearch: false,
      regexSearch: true,
      recursiveCTE: true,
      concurrentWrites: false,
    },
    createRuntime: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ledgermind-conformance-sqlite-'));
      let database: Awaited<ReturnType<typeof openSqliteDatabase>> | undefined;

      try {
        const openedDatabase = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });
        database = openedDatabase;

        const unitOfWork = createSqliteUnitOfWork(openedDatabase.db);
        const ledger = new SqliteLedgerStore(openedDatabase.db);
        const context = new SqliteContextProjection(openedDatabase.db);
        const dag = new SqliteSummaryDag(openedDatabase.db);
        const artifacts = new SqliteArtifactStore(openedDatabase.db);
        const conversations = new SqliteConversationStore(openedDatabase.db);
        const operators = new SqliteOperatorExecutionStore(openedDatabase.db);

        const conversation = await conversations.create(
          createConversationCfg('conformance-sqlite'),
        );

        return {
          defaultConversationId: conversation.id,
          unitOfWork,
          ledger,
          context,
          dag,
          artifacts,
          conversations,
          operators,
          corruption: {
            canInjectOrphanSummaryMessageEdge: true,
            async injectOrphanSummaryMessageEdge(input: {
              readonly summaryId: SummaryNodeId;
              readonly missingMessageId: EventId;
            }): Promise<void> {
              openedDatabase.db.exec('PRAGMA foreign_keys = OFF');

              try {
                openedDatabase.db
                  .prepare(
                    `INSERT INTO summary_message_edges (summary_id, message_id, ord)
                     VALUES (?, ?, (
                       SELECT COALESCE(MAX(ord), -1) + 1
                       FROM summary_message_edges
                       WHERE summary_id = ?
                     ))`,
                  )
                  .run(input.summaryId, input.missingMessageId, input.summaryId);
              } finally {
                openedDatabase.db.exec('PRAGMA foreign_keys = ON');
              }
            },
          },
          destroy: async () => {
            try {
              openedDatabase.close();
            } finally {
              await rm(dir, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        if (database !== undefined) {
          database.close();
        }

        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          // Preserve the setup failure; temp cleanup is best-effort in this branch.
        }

        throw error;
      }
    },
  };
};
