import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCompactionThresholds,
  createConversationConfig,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  type ConversationId,
  type LedgerEvent,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteConversationStore } from '../sqlite-conversation-store';
import { SqliteLedgerStore } from '../sqlite-ledger-store';
import { createSqliteUnitOfWork } from '../sqlite-unit-of-work';

const tempDirs: string[] = [];

const createConfig = () => {
  return createConversationConfig({
    modelName: 'sqlite-uow-test',
    contextWindow: createTokenCount(4096),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });
};

const createEvent = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(`evt_sqlite_uow_${sequence}_${content.replace(/\W+/g, '_')}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(
      new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`),
    ),
    metadata: {},
  });
};

const createTestDatabase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-uow-'));
  tempDirs.push(dir);
  const database = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });

  return {
    database,
    unitOfWork: createSqliteUnitOfWork(database.db),
    conversations: new SqliteConversationStore(database.db),
    ledger: new SqliteLedgerStore(database.db),
  };
};

const countRows = (
  database: Awaited<ReturnType<typeof openSqliteDatabase>>,
  tableName: 'conversations' | 'ledger_events',
): number => {
  const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as
    | { readonly count: number }
    | undefined;
  return row?.count ?? 0;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteUnitOfWork', () => {
  it('commits all mutations on success', async () => {
    const { database, unitOfWork, conversations, ledger } = await createTestDatabase();

    try {
      const created = await unitOfWork.execute(async (tx) => {
        const conversation = await tx.conversations.create(createConfig());
        const event = createEvent(conversation.id, 1, 'committed event');

        await tx.ledger.appendEvents(conversation.id, [event]);

        return { conversationId: conversation.id, event };
      });

      await expect(conversations.get(created.conversationId)).resolves.not.toBeNull();
      await expect(ledger.getEvents(created.conversationId)).resolves.toEqual([created.event]);
    } finally {
      database.close();
    }
  });

  it('rolls back all mutations when work throws', async () => {
    const { database, unitOfWork } = await createTestDatabase();

    try {
      await expect(
        unitOfWork.execute(async (tx) => {
          const conversation = await tx.conversations.create(createConfig());
          const event = createEvent(conversation.id, 1, 'rolled back event');

          await tx.ledger.appendEvents(conversation.id, [event]);

          throw new Error('abort sqlite unit of work');
        }),
      ).rejects.toThrow('abort sqlite unit of work');

      expect(countRows(database, 'conversations')).toBe(0);
      expect(countRows(database, 'ledger_events')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('rejects nested execute calls', async () => {
    const { database, unitOfWork } = await createTestDatabase();

    try {
      await expect(
        unitOfWork.execute(async () => {
          await unitOfWork.execute(async (tx) => tx.conversations.create(createConfig()));
        }),
      ).rejects.toThrow('Nested SQLite unit of work is not supported.');
    } finally {
      database.close();
    }
  });
});
