import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createCompactionThresholds } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';
import { createConversationConfig } from '@ledgermind/domain';
import { createConversationId } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

import { createExecutorForClient, createPostgresTestHarness } from './postgres-test-harness';
import { PgConversationStore } from '../pg-conversation-store';

const createConfig = (modelName: string) => {
  return createConversationConfig({
    modelName,
    contextWindow: createTokenCount(8_192),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

describe('PgConversationStore', () => {
  it('re-applying migration SQL files is idempotent', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const migrationPaths = [
        new URL('../../sql/postgres/migrations/0001_phase1_schema.sql', import.meta.url),
        new URL('../../sql/postgres/migrations/0002_phase1_indexes.sql', import.meta.url),
      ] as const;

      for (const migrationPath of migrationPaths) {
        const migrationSql = await readFile(migrationPath, 'utf8');
        const [upSqlRaw] = migrationSql.split('-- Down Migration');
        const upSql = upSqlRaw?.trim();

        if (!upSql) {
          throw new Error(`Migration file missing up migration SQL: ${migrationPath.toString()}`);
        }

        await harness.withClient(async (client) => {
          await client.query(upSql);
        });
      }

      await harness.withClient(async (client) => {
        const tableResult = await client.query<{ readonly count: string }>(
          `
            SELECT COUNT(*)::text AS count
            FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name = ANY($1::text[])
          `,
          [
            [
              'conversations',
              'ledger_events',
              'summary_nodes',
              'summary_message_edges',
              'summary_parent_edges',
              'context_items',
              'context_versions',
              'artifacts',
            ],
          ],
        );

        expect(tableResult.rows[0]?.count).toBe('8');
      });
    } finally {
      await harness.destroy();
    }
  });
  it('rejects missing parent with deterministic domain error before insert', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversations } = harness;

      await expect(
        conversations.create(createConfig('invalid'), createConversationId('conv_missing')),
      ).rejects.toEqual(new InvariantViolationError('Parent conversation does not exist.'));
    } finally {
      await harness.destroy();
    }
  });

  it('does not allocate a new conversation ID when parent validation fails', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversations } = harness;

      await expect(
        conversations.create(createConfig('invalid'), createConversationId('conv_missing')),
      ).rejects.toEqual(new InvariantViolationError('Parent conversation does not exist.'));

      const created = await conversations.create(createConfig('after-failure'));
      expect(created.id).toBe('conv_000002');
    } finally {
      await harness.destroy();
    }
  });

  it('supports restart-and-recovery for create/get/ancestor chain', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { pool, schemaName, conversations } = harness;

      const root = await conversations.create(createConfig('root'));
      const child = await conversations.create(createConfig('child'), root.id);
      const grandChild = await conversations.create(createConfig('grandchild'), child.id);

      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName.replaceAll('"', '""')}", public`);
        const recoveredStore = new PgConversationStore(createExecutorForClient(client));

        const recovered = await recoveredStore.get(grandChild.id);
        expect(recovered?.id).toBe(grandChild.id);

        const recoveredAncestors = await recoveredStore.getAncestorChain(grandChild.id);
        expect(recoveredAncestors).toEqual([root.id, child.id]);

        const nextAfterRestart = await recoveredStore.create(createConfig('after-restart'));
        expect(nextAfterRestart.id).toBe('conv_000005');
      } finally {
        client.release();
      }
    } finally {
      await harness.destroy();
    }
  });

  it('creates conversations with deterministic incremental IDs', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversations } = harness;

      const first = await conversations.create(createConfig('model-a'));
      const second = await conversations.create(createConfig('model-b'));

      expect(first.id).toBe('conv_000002');
      expect(second.id).toBe('conv_000003');
    } finally {
      await harness.destroy();
    }
  });

  it('returns conversation by id and ancestor chain root-to-parent order', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversations } = harness;

      const root = await conversations.create(createConfig('root'));
      const child = await conversations.create(createConfig('child'), root.id);
      const grandChild = await conversations.create(createConfig('grandchild'), child.id);

      const fetched = await conversations.get(grandChild.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(grandChild.id);
      expect(fetched?.parentId).toBe(child.id);
      expect(fetched?.config.modelName).toBe('grandchild');
      expect(fetched?.config.contextWindow.value).toBe(8_192);
      expect(fetched?.config.thresholds.soft).toBe(0.6);
      expect(fetched?.config.thresholds.hard).toBe(1);
      expect(fetched?.createdAt).toBeInstanceOf(Date);

      const ancestors = await conversations.getAncestorChain(grandChild.id);
      expect(ancestors).toEqual([root.id, child.id]);

      const rootAncestors = await conversations.getAncestorChain(root.id);
      expect(rootAncestors).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  it('returns null and empty chain for unknown conversation id', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversations } = harness;

      const unknownId = createConversationId('conv_999999');
      const fetched = await conversations.get(unknownId);
      expect(fetched).toBeNull();

      const ancestors = await conversations.getAncestorChain(unknownId);
      expect(ancestors).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

});
