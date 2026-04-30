import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  createCompactionThresholds,
  createConversationConfig,
  createConversationId,
  createTokenCount,
  InvariantViolationError,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteConversationStore } from '../sqlite-conversation-store';

const tempDirs: string[] = [];

const createConfig = () =>
  createConversationConfig({
    modelName: 'sqlite-local',
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });

const createRetryingInsertDatabase = (conflictsBeforeSuccess = 1): DatabaseSync => {
  const rows = new Map<string, Record<string, unknown>>();
  let nextOrdinal = 1;
  let insertAttempts = 0;

  return {
    prepare(sql: string) {
      if (sql.includes('next_ordinal')) {
        return {
          get: () => {
            const ordinal = nextOrdinal;
            nextOrdinal += 1;
            return { next_ordinal: ordinal };
          },
        };
      }

      if (sql.includes('INSERT INTO conversations')) {
        return {
          run: (
            id: string,
            parentId: string | null,
            modelName: string,
            contextWindow: number,
            softThreshold: number,
            hardThreshold: number,
          ) => {
            insertAttempts += 1;

            if (insertAttempts <= conflictsBeforeSuccess) {
              const error = new Error('UNIQUE constraint failed: conversations.id') as Error & {
                code: string;
                errcode: number;
                errstr: string;
              };
              error.code = 'ERR_SQLITE_ERROR';
              error.errcode = 1555;
              error.errstr = 'constraint failed';
              throw error;
            }

            rows.set(id, {
              id,
              parent_id: parentId,
              model_name: modelName,
              context_window: contextWindow,
              soft_threshold: softThreshold,
              hard_threshold: hardThreshold,
              created_at: '2026-04-30T00:00:00.000Z',
            });
          },
        };
      }

      if (sql.includes('SELECT id, parent_id')) {
        return {
          get: (id: string) => rows.get(id),
        };
      }

      if (sql.includes('WITH RECURSIVE chain')) {
        return {
          all: () => [],
        };
      }

      return {
        get: () => undefined,
      };
    },
  } as unknown as DatabaseSync;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteConversationStore', () => {
  it('creates, reads, and restores ancestor chains after reopening the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-conversations-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');

    const firstDb = await openSqliteDatabase({ path });

    try {
      const firstStore = new SqliteConversationStore(firstDb.db);
      const parent = await firstStore.create(createConfig());
      const child = await firstStore.create(createConfig(), parent.id);

      expect(parent.id).toBe(createConversationId('conv_000001'));
      expect(child.id).toBe(createConversationId('conv_000002'));
    } finally {
      firstDb.close();
    }

    const secondDb = await openSqliteDatabase({ path });

    try {
      const secondStore = new SqliteConversationStore(secondDb.db);
      const parentId = createConversationId('conv_000001');
      const childId = createConversationId('conv_000002');

      expect(await secondStore.get(parentId)).toMatchObject({ id: parentId, parentId: null });
      expect(await secondStore.get(childId)).toMatchObject({ id: childId, parentId });
      expect(await secondStore.getAncestorChain(childId)).toEqual([parentId]);
    } finally {
      secondDb.close();
    }
  });

  it('throws when creating a child for a missing parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-conversations-missing-parent-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const database = await openSqliteDatabase({ path });

    try {
      const store = new SqliteConversationStore(database.db);

      await expect(
        store.create(createConfig(), createConversationId('conv_999999')),
      ).rejects.toThrow(new InvariantViolationError('Parent conversation does not exist.'));
    } finally {
      database.close();
    }
  });

  it('retries deterministic ID allocation when a conversation primary key conflict races insert', async () => {
    const store = new SqliteConversationStore(createRetryingInsertDatabase());

    const created = await store.create(createConfig());

    expect(created.id).toBe(createConversationId('conv_000002'));
  });

  it('throws a clear error when deterministic ID allocation conflicts exhaust retries', async () => {
    const store = new SqliteConversationStore(createRetryingInsertDatabase(3));

    await expect(store.create(createConfig())).rejects.toThrow(
      'Failed to create conversation after retry attempts.',
    );
  });

  it('returns null and an empty ancestor chain for unknown conversations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-conversations-unknown-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const database = await openSqliteDatabase({ path });

    try {
      const store = new SqliteConversationStore(database.db);
      const unknownId = createConversationId('conv_404404');

      expect(await store.get(unknownId)).toBeNull();
      expect(await store.getAncestorChain(unknownId)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
