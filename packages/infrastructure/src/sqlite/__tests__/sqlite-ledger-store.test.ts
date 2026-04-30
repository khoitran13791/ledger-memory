import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IdempotencyConflictError } from '@ledgermind/application';
import {
  createConversationId,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  InvariantViolationError,
  NonMonotonicSequenceError,
  type ConversationId,
  type EventMetadata,
  type LedgerEvent,
  type SummaryNodeId,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../sqlite-connection';
import { SqliteLedgerStore } from '../sqlite-ledger-store';

const tempDirs: string[] = [];

const createEvent = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
  metadata: EventMetadata = {},
): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(`evt_${conversationId}_${sequence}_${content.replace(/\W+/g, '_')}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(
      new Date(`2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`),
    ),
    metadata,
  });
};

const createTestDatabase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-ledger-'));
  tempDirs.push(dir);
  const database = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });
  const conversationId = createConversationId('conv_ledger_001');

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
    database,
    conversationId,
    ledger: new SqliteLedgerStore(database.db),
  };
};

const insertSummaryNode = (
  database: Awaited<ReturnType<typeof openSqliteDatabase>>,
  conversationId: ConversationId,
  summaryId: SummaryNodeId,
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
      1,
      '[]',
      '2026-01-01T00:10:00.000Z',
    );
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteLedgerStore', () => {
  it('appends, reopens, preserves metadata, searches, regexes, and reports next sequence', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const path = database.path;
    const first = createEvent(conversationId, 1, 'alpha event with metadata', {
      artifactIds: ['file_sqlite_1'],
      nested: { attempt: 1 },
    });
    const second = createEvent(conversationId, 2, 'beta event searchable by regex');

    try {
      await ledger.appendEvents(conversationId, [first, second]);
      expect(await ledger.getNextSequence(conversationId)).toBe(createSequenceNumber(3));
    } finally {
      database.close();
    }

    const reopened = await openSqliteDatabase({ path });

    try {
      const reopenedLedger = new SqliteLedgerStore(reopened.db);
      const allEvents = await reopenedLedger.getEvents(conversationId);

      expect(allEvents).toEqual([first, second]);
      expect(allEvents[0]?.metadata).toEqual({
        artifactIds: ['file_sqlite_1'],
        nested: { attempt: 1 },
      });
      await expect(reopenedLedger.searchEvents(conversationId, '   ')).resolves.toEqual([]);
      expect(
        (await reopenedLedger.searchEvents(conversationId, 'EVENT')).map((event) => event.id),
      ).toEqual([first.id, second.id]);

      const regexPage = await reopenedLedger.regexSearchEvents(conversationId, 'searchable', {
        offset: 0,
        limit: 10,
      });

      expect(regexPage.totalMatchCount).toBe(1);
      expect(regexPage.matches[0]).toMatchObject({
        eventId: second.id,
        sequence: second.sequence,
      });
      expect(regexPage.matches[0]?.excerpt).toContain('searchable');
    } finally {
      reopened.close();
    }
  });

  it('treats duplicate event IDs and same idempotency digest retries as no-ops', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'payload alpha', {
      __ledgermind_idempotencyKey: 'shared-key',
      __ledgermind_idempotencyDigest: 'digest-alpha',
    });
    const retry = createEvent(conversationId, 2, 'payload retry', {
      __ledgermind_idempotencyKey: 'shared-key',
      __ledgermind_idempotencyDigest: 'digest-alpha',
    });

    try {
      await ledger.appendEvents(conversationId, [first]);
      await ledger.appendEvents(conversationId, [first]);
      await ledger.appendEvents(conversationId, [retry]);

      const allEvents = await ledger.getEvents(conversationId);
      expect(allEvents).toEqual([first]);
      expect(await ledger.getNextSequence(conversationId)).toBe(createSequenceNumber(2));
    } finally {
      database.close();
    }
  });

  it('throws typed conflict for same idempotency key with different digest', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'payload alpha', {
      __ledgermind_idempotencyKey: 'shared-key',
      __ledgermind_idempotencyDigest: 'digest-alpha',
    });
    const conflicting = createEvent(conversationId, 2, 'payload beta', {
      __ledgermind_idempotencyKey: 'shared-key',
      __ledgermind_idempotencyDigest: 'digest-beta',
    });

    try {
      await ledger.appendEvents(conversationId, [first]);

      await expect(ledger.appendEvents(conversationId, [conflicting])).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
      expect(await ledger.getEvents(conversationId)).toEqual([first]);
    } finally {
      database.close();
    }
  });

  it('returns inclusive ranges in ascending sequence order', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const events = [
      createEvent(conversationId, 1, 'first'),
      createEvent(conversationId, 2, 'second'),
      createEvent(conversationId, 3, 'third'),
    ];

    try {
      await ledger.appendEvents(conversationId, events);

      const range = await ledger.getEvents(conversationId, {
        start: createSequenceNumber(2),
        end: createSequenceNumber(3),
      });

      expect(range.map((event) => event.sequence)).toEqual([2, 3]);
      expect(range.map((event) => event.content)).toEqual(['second', 'third']);
    } finally {
      database.close();
    }
  });

  it('composes append atomically inside an existing SQLite transaction', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'nested transaction first');
    const second = createEvent(conversationId, 2, 'nested transaction second');

    try {
      database.db.exec('BEGIN');
      await ledger.appendEvents(conversationId, [first]);
      await ledger.appendEvents(conversationId, [second]);
      database.db.exec('COMMIT');

      expect(await ledger.getEvents(conversationId)).toEqual([first, second]);
    } finally {
      database.close();
    }
  });

  it('tokenizes natural-language search queries and ignores stopword-only searches', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'remember the orbital launch plan');
    const second = createEvent(conversationId, 2, 'coffee preferences');

    try {
      await ledger.appendEvents(conversationId, [first, second]);

      const naturalLanguageMatches = await ledger.searchEvents(
        conversationId,
        'please find what we said about orbital details',
      );
      expect(naturalLanguageMatches.map((event) => event.id)).toEqual([first.id]);
      await expect(ledger.searchEvents(conversationId, 'the and of what we did')).resolves.toEqual(
        [],
      );
    } finally {
      database.close();
    }
  });

  it('rejects conversation mismatches and sequence gaps without partial writes', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();

    try {
      await expect(
        ledger.appendEvents(conversationId, [
          createEvent(createConversationId('conv_other'), 1, 'wrong conversation'),
        ]),
      ).rejects.toBeInstanceOf(InvariantViolationError);

      await expect(
        ledger.appendEvents(conversationId, [createEvent(conversationId, 2, 'gap')]),
      ).rejects.toBeInstanceOf(NonMonotonicSequenceError);

      expect(await ledger.getEvents(conversationId)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('filters search and regex results through scoped summary coverage', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'alpha scope one');
    const second = createEvent(conversationId, 2, 'alpha scope two');
    const third = createEvent(conversationId, 3, 'alpha outside');
    const leafSummaryId = createSummaryNodeId('sum_sqlite_scope_leaf');
    const condensedSummaryId = createSummaryNodeId('sum_sqlite_scope_condensed');

    try {
      await ledger.appendEvents(conversationId, [first, second, third]);
      insertSummaryNode(database, conversationId, leafSummaryId);
      insertSummaryNode(database, conversationId, condensedSummaryId);
      database.db
        .prepare(
          `INSERT INTO summary_message_edges (summary_id, message_id, ord)
           VALUES (?, ?, ?), (?, ?, ?)`,
        )
        .run(leafSummaryId, first.id, 0, leafSummaryId, second.id, 1);
      database.db
        .prepare(
          `INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(condensedSummaryId, leafSummaryId, 0);

      const scopedSearch = await ledger.searchEvents(conversationId, 'alpha', condensedSummaryId);
      expect(scopedSearch.map((event) => event.id)).toEqual([first.id, second.id]);

      const scopedRegex = await ledger.regexSearchEvents(conversationId, 'alpha', {
        scope: condensedSummaryId,
        offset: 0,
        limit: 10,
      });
      expect(scopedRegex.totalMatchCount).toBe(2);
      expect(scopedRegex.matches.map((match) => match.eventId)).toEqual([first.id, second.id]);
      expect(
        scopedRegex.matches.every((match) => match.coveringSummaryId === condensedSummaryId),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it('returns active covering summaries for unscoped regex matches', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'alpha active coverage');
    const second = createEvent(conversationId, 2, 'alpha uncovered');
    const activeSummaryId = createSummaryNodeId('sum_sqlite_active_summary');

    try {
      await ledger.appendEvents(conversationId, [first, second]);
      insertSummaryNode(database, conversationId, activeSummaryId);
      database.db
        .prepare(
          `INSERT INTO summary_message_edges (summary_id, message_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(activeSummaryId, first.id, 0);
      database.db
        .prepare(
          `INSERT INTO context_items (conversation_id, position, summary_id)
           VALUES (?, ?, ?)`,
        )
        .run(conversationId, 0, activeSummaryId);

      const page = await ledger.regexSearchEvents(conversationId, 'alpha', {
        offset: 0,
        limit: 10,
      });

      expect(page.totalMatchCount).toBe(2);
      expect(page.matches.map((match) => match.eventId)).toEqual([first.id, second.id]);
      expect(page.matches[0]?.coveringSummaryId).toBe(activeSummaryId);
      expect(page.matches[1]?.coveringSummaryId).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('uses case-sensitive JavaScript regex semantics', async () => {
    const { database, conversationId, ledger } = await createTestDatabase();
    const first = createEvent(conversationId, 1, 'Needle in mixed case');

    try {
      await ledger.appendEvents(conversationId, [first]);

      await expect(
        ledger.regexSearchEvents(conversationId, 'needle', { offset: 0, limit: 10 }),
      ).resolves.toEqual({
        matches: [],
        totalMatchCount: 0,
      });

      const exactCase = await ledger.regexSearchEvents(conversationId, 'Needle', {
        offset: 0,
        limit: 10,
      });
      expect(exactCase.totalMatchCount).toBe(1);
      expect(exactCase.matches[0]?.eventId).toBe(first.id);
    } finally {
      database.close();
    }
  });
});
