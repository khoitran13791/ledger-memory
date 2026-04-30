import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StaleContextVersionError } from '@ledgermind/application';
import {
  createContextItem,
  createContextVersion,
  createConversationId,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  InvariantViolationError,
  type ConversationId,
  type LedgerEvent,
  type SummaryNodeId,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteContextProjection } from '../sqlite-context-projection';
import { SqliteLedgerStore } from '../sqlite-ledger-store';

const tempDirs: string[] = [];

const createMessage = (
  conversationId: ConversationId,
  id: string,
  sequence: number,
  tokenCount: number,
): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(id),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content: `message-${id}`,
    tokenCount: createTokenCount(tokenCount),
    occurredAt: createTimestamp(
      new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`),
    ),
    metadata: {},
  });
};

const createTestDatabase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-context-'));
  tempDirs.push(dir);
  const path = join(dir, 'memory.sqlite');
  const database = await openSqliteDatabase({ path });
  const conversationId = createConversationId('conv_sqlite_context_001');

  database.db
    .prepare(
      `INSERT INTO conversations (
        id,
        model_name,
        context_window,
        soft_threshold,
        hard_threshold
      )
      VALUES (?, ?, ?, ?, ?)`,
    )
    .run(conversationId, 'sqlite-local', 8192, 0.6, 0.9);

  return {
    context: new SqliteContextProjection(database.db),
    database,
    ledger: new SqliteLedgerStore(database.db),
    conversationId,
    path,
  };
};

const insertSummaryNode = (
  database: Awaited<ReturnType<typeof openSqliteDatabase>>,
  conversationId: ConversationId,
  summaryId: SummaryNodeId,
  tokenCount: number,
): void => {
  database.db
    .prepare(
      `INSERT INTO summary_nodes (
        id,
        conversation_id,
        kind,
        content,
        retrieval_text,
        token_count,
        artifact_ids_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      summaryId,
      conversationId,
      'leaf',
      `summary ${summaryId}`,
      `summary ${summaryId}`,
      tokenCount,
      '[]',
      '2026-01-01T00:10:00.000Z',
    );
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteContextProjection', () => {
  it('returns empty context snapshot with initialized version for a new conversation', async () => {
    const { context, database, conversationId } = await createTestDatabase();

    try {
      const snapshot = await context.getCurrentContext(conversationId);

      expect(snapshot.items).toEqual([]);
      expect(snapshot.version).toBe(createContextVersion(0));
    } finally {
      database.close();
    }
  });

  it('appends context items with contiguous positions and survives reopen', async () => {
    const { context, database, ledger, conversationId, path } = await createTestDatabase();
    const event = createMessage(conversationId, 'evt_sqlite_context_append', 1, 13);

    try {
      await ledger.appendEvents(conversationId, [event]);

      const version = await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 99,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      expect(version).toBe(createContextVersion(1));

      const snapshot = await context.getCurrentContext(conversationId);
      expect(snapshot.items.map((item) => item.position)).toEqual([0]);
      expect(snapshot.items[0]?.ref).toEqual(createMessageContextItemRef(event.id));
      expect((await context.getContextTokenCount(conversationId)).value).toBe(
        event.tokenCount.value,
      );
    } finally {
      database.close();
    }

    const reopened = await openSqliteDatabase({ path });
    try {
      const reopenedContext = new SqliteContextProjection(reopened.db);
      const snapshot = await reopenedContext.getCurrentContext(conversationId);

      expect(snapshot.version).toBe(createContextVersion(1));
      expect(snapshot.items.map((item) => item.position)).toEqual([0]);
    } finally {
      reopened.close();
    }
  });

  it('computes token count from ledger events and summary nodes', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const event = createMessage(conversationId, 'evt_sqlite_context_tokens', 1, 11);
    const summaryId = createSummaryNodeId('sum_sqlite_context_tokens');

    try {
      await ledger.appendEvents(conversationId, [event]);
      insertSummaryNode(database, conversationId, summaryId, 7);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 100,
          ref: createMessageContextItemRef(event.id),
        }),
        createContextItem({
          conversationId,
          position: 200,
          ref: createSummaryContextItemRef(summaryId),
        }),
      ]);

      expect((await context.getContextTokenCount(conversationId)).value).toBe(18);
    } finally {
      database.close();
    }
  });

  it('returns current version without bumping when appending an empty item list', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const event = createMessage(conversationId, 'evt_sqlite_context_empty_append', 1, 5);

    try {
      await ledger.appendEvents(conversationId, [event]);
      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 99,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      const version = await context.appendContextItems(conversationId, []);
      const snapshot = await context.getCurrentContext(conversationId);

      expect(version).toBe(createContextVersion(1));
      expect(snapshot.version).toBe(createContextVersion(1));
      expect(snapshot.items).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('rejects append context items for a different conversation', async () => {
    const { context, database, conversationId } = await createTestDatabase();
    const otherConversationId = createConversationId('conv_sqlite_context_other');

    try {
      await expect(
        context.appendContextItems(conversationId, [
          createContextItem({
            conversationId: otherConversationId,
            position: 0,
            ref: createMessageContextItemRef(createEventId('evt_sqlite_context_other')),
          }),
        ]),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    } finally {
      database.close();
    }
  });

  it('replaces removed positions with one item, reindexes, and bumps version', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const events = [
      createMessage(conversationId, 'evt_sqlite_context_replace_a', 1, 5),
      createMessage(conversationId, 'evt_sqlite_context_replace_b', 2, 7),
      createMessage(conversationId, 'evt_sqlite_context_replace_c', 3, 9),
      createMessage(conversationId, 'evt_sqlite_context_replace_d', 4, 11),
    ];
    const summaryId = createSummaryNodeId('sum_sqlite_context_replace');

    try {
      await ledger.appendEvents(conversationId, events);
      insertSummaryNode(database, conversationId, summaryId, 13);
      await context.appendContextItems(
        conversationId,
        events.map((event, position) =>
          createContextItem({
            conversationId,
            position,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );

      const version = await context.replaceContextItems(
        conversationId,
        createContextVersion(1),
        [1, 2],
        createContextItem({
          conversationId,
          position: 999,
          ref: createSummaryContextItemRef(summaryId),
        }),
      );
      const snapshot = await context.getCurrentContext(conversationId);

      expect(version).toBe(createContextVersion(2));
      expect(snapshot.version).toBe(createContextVersion(2));
      expect(snapshot.items.map((item) => item.position)).toEqual([0, 1, 2]);
      expect(snapshot.items.map((item) => item.ref)).toEqual([
        createMessageContextItemRef(events[0]!.id),
        createSummaryContextItemRef(summaryId),
        createMessageContextItemRef(events[3]!.id),
      ]);
    } finally {
      database.close();
    }
  });

  it('dedupes and sorts replace remove positions before reindexing', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const events = [
      createMessage(conversationId, 'evt_sqlite_context_dedupe_a', 1, 5),
      createMessage(conversationId, 'evt_sqlite_context_dedupe_b', 2, 7),
      createMessage(conversationId, 'evt_sqlite_context_dedupe_c', 3, 9),
      createMessage(conversationId, 'evt_sqlite_context_dedupe_d', 4, 11),
    ];
    const summaryId = createSummaryNodeId('sum_sqlite_context_dedupe');

    try {
      await ledger.appendEvents(conversationId, events);
      insertSummaryNode(database, conversationId, summaryId, 13);
      await context.appendContextItems(
        conversationId,
        events.map((event, position) =>
          createContextItem({
            conversationId,
            position,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );

      await context.replaceContextItems(
        conversationId,
        createContextVersion(1),
        [2, 1, 2],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summaryId),
        }),
      );
      const snapshot = await context.getCurrentContext(conversationId);

      expect(snapshot.items.map((item) => item.position)).toEqual([0, 1, 2]);
      expect(snapshot.items.map((item) => item.ref)).toEqual([
        createMessageContextItemRef(events[0]!.id),
        createSummaryContextItemRef(summaryId),
        createMessageContextItemRef(events[3]!.id),
      ]);
    } finally {
      database.close();
    }
  });

  it('returns current version without bumping when replacing an empty position list', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const event = createMessage(conversationId, 'evt_sqlite_context_empty_replace', 1, 5);

    try {
      await ledger.appendEvents(conversationId, [event]);
      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      const version = await context.replaceContextItems(
        conversationId,
        createContextVersion(1),
        [],
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(event.id),
        }),
      );
      const snapshot = await context.getCurrentContext(conversationId);

      expect(version).toBe(createContextVersion(1));
      expect(snapshot.version).toBe(createContextVersion(1));
      expect(snapshot.items.map((item) => item.ref)).toEqual([
        createMessageContextItemRef(event.id),
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects replacement context items for a different conversation', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const event = createMessage(conversationId, 'evt_sqlite_context_replacement_mismatch', 1, 5);
    const otherConversationId = createConversationId('conv_sqlite_context_replacement_other');

    try {
      await ledger.appendEvents(conversationId, [event]);
      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      await expect(
        context.replaceContextItems(
          conversationId,
          createContextVersion(1),
          [0],
          createContextItem({
            conversationId: otherConversationId,
            position: 0,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    } finally {
      database.close();
    }
  });

  it('rejects out-of-range replace positions', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const event = createMessage(conversationId, 'evt_sqlite_context_out_of_range', 1, 5);

    try {
      await ledger.appendEvents(conversationId, [event]);
      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(event.id),
        }),
      ]);

      await expect(
        context.replaceContextItems(
          conversationId,
          createContextVersion(1),
          [1],
          createContextItem({
            conversationId,
            position: 0,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    } finally {
      database.close();
    }
  });

  it('throws StaleContextVersionError when replacing with an old version', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const events = [
      createMessage(conversationId, 'evt_sqlite_context_stale_a', 1, 5),
      createMessage(conversationId, 'evt_sqlite_context_stale_b', 2, 7),
    ];

    try {
      await ledger.appendEvents(conversationId, events);
      await context.appendContextItems(
        conversationId,
        events.map((event, position) =>
          createContextItem({
            conversationId,
            position,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );

      const replacement = createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(events[0]!.id),
      });

      await expect(
        context.replaceContextItems(conversationId, createContextVersion(0), [0], replacement),
      ).rejects.toMatchObject({
        actualVersion: createContextVersion(1),
      });
      await expect(
        context.replaceContextItems(conversationId, createContextVersion(0), [0], replacement),
      ).rejects.toBeInstanceOf(StaleContextVersionError);
    } finally {
      database.close();
    }
  });

  it('composes append and replace savepoints inside an existing SQLite transaction', async () => {
    const { context, database, ledger, conversationId } = await createTestDatabase();
    const events = [
      createMessage(conversationId, 'evt_sqlite_context_tx_a', 1, 5),
      createMessage(conversationId, 'evt_sqlite_context_tx_b', 2, 7),
    ];
    const summaryId = createSummaryNodeId('sum_sqlite_context_tx');

    try {
      await ledger.appendEvents(conversationId, events);
      insertSummaryNode(database, conversationId, summaryId, 11);

      database.db.exec('BEGIN');
      await context.appendContextItems(
        conversationId,
        events.map((event, position) =>
          createContextItem({
            conversationId,
            position,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );
      await context.replaceContextItems(
        conversationId,
        createContextVersion(1),
        [0],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(summaryId),
        }),
      );
      database.db.exec('COMMIT');

      const snapshot = await context.getCurrentContext(conversationId);
      expect(snapshot.version).toBe(createContextVersion(2));
      expect(snapshot.items.map((item) => item.position)).toEqual([0, 1]);
      expect(snapshot.items.map((item) => item.ref)).toEqual([
        createSummaryContextItemRef(summaryId),
        createMessageContextItemRef(events[1]!.id),
      ]);
    } finally {
      database.close();
    }
  });
});
