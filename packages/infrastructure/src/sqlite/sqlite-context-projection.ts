import type { ContextProjectionPort } from '@ledgermind/application';
import { StaleContextVersionError } from '@ledgermind/application';
import {
  createContextItem,
  createContextVersion,
  createEventId,
  createMessageContextItemRef,
  createSummaryContextItemRef,
  createSummaryNodeId,
  createTokenCount,
  InvariantViolationError,
  type ContextItem,
  type ContextVersion,
  type ConversationId,
  type TokenCount,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';

interface ContextVersionRow {
  readonly version: unknown;
}

interface ContextItemRow {
  readonly position: unknown;
  readonly message_id: string | null;
  readonly summary_id: string | null;
}

interface ContextSnapshotRow {
  readonly version: unknown;
  readonly position: unknown | null;
  readonly message_id: string | null;
  readonly summary_id: string | null;
}

interface ContextTokenCountRow {
  readonly total_tokens: unknown;
}

const SQLITE_CONTEXT_APPEND_SAVEPOINT = 'sqlite_context_append';
const SQLITE_CONTEXT_REPLACE_SAVEPOINT = 'sqlite_context_replace';

const parseSqliteNonNegativeInteger = (value: unknown, fieldName: string): number => {
  const parsed = parseSqliteInteger(value, fieldName);

  if (parsed < 0) {
    throw new InvariantViolationError(`Invalid ${fieldName} from SQLite row.`);
  }

  return parsed;
};

const dedupeAndSortPositions = (positions: readonly number[]): number[] => {
  return [...new Set(positions)].sort((left, right) => left - right);
};

const normalizePositions = (
  conversationId: ConversationId,
  items: readonly ContextItem[],
): ContextItem[] => {
  return [...items]
    .sort((left, right) => left.position - right.position)
    .map((item, index) =>
      createContextItem({
        conversationId,
        position: index,
        ref: item.ref,
      }),
    );
};

const toContextItem = (conversationId: ConversationId, row: ContextItemRow): ContextItem => {
  const position = parseSqliteNonNegativeInteger(row.position, 'context_items.position');

  if (row.message_id !== null && row.summary_id === null) {
    return createContextItem({
      conversationId,
      position,
      ref: createMessageContextItemRef(createEventId(row.message_id)),
    });
  }

  if (row.summary_id !== null && row.message_id === null) {
    return createContextItem({
      conversationId,
      position,
      ref: createSummaryContextItemRef(createSummaryNodeId(row.summary_id)),
    });
  }

  throw new InvariantViolationError('Context row must reference exactly one message or summary.');
};

const toInsertionColumns = (
  item: ContextItem,
): { readonly messageId: string | null; readonly summaryId: string | null } => {
  if (item.ref.type === 'message') {
    return {
      messageId: item.ref.messageId,
      summaryId: null,
    };
  }

  return {
    messageId: null,
    summaryId: item.ref.summaryId,
  };
};

const withSavepoint = <T>(db: DatabaseSync, name: string, work: () => T): T => {
  db.exec(`SAVEPOINT ${name}`);

  try {
    const result = work();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
};

export class SqliteContextProjection implements ContextProjectionPort {
  constructor(private readonly db: DatabaseSync) {}

  private ensureVersionRow(conversationId: ConversationId): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO context_versions (conversation_id, version)
         VALUES (?, 0)`,
      )
      .run(conversationId);
  }

  private getCurrentVersion(conversationId: ConversationId): ContextVersion {
    const row = this.db
      .prepare(
        `SELECT version
         FROM context_versions
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as ContextVersionRow | undefined;

    return createContextVersion(
      parseSqliteNonNegativeInteger(row?.version ?? 0, 'context_versions.version'),
    );
  }

  private getNormalizedContextItems(conversationId: ConversationId): ContextItem[] {
    const rows = this.db
      .prepare(
        `SELECT position, message_id, summary_id
         FROM context_items
         WHERE conversation_id = ?
         ORDER BY position ASC`,
      )
      .all(conversationId) as unknown as ContextItemRow[];

    return normalizePositions(
      conversationId,
      rows.map((row) => toContextItem(conversationId, row)),
    );
  }

  async getCurrentContext(conversationId: ConversationId): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ContextVersion;
  }> {
    this.ensureVersionRow(conversationId);

    const rows = this.db
      .prepare(
        `SELECT
          cv.version,
          ci.position,
          ci.message_id,
          ci.summary_id
         FROM context_versions cv
         LEFT JOIN context_items ci
           ON ci.conversation_id = cv.conversation_id
         WHERE cv.conversation_id = ?
         ORDER BY ci.position ASC`,
      )
      .all(conversationId) as unknown as ContextSnapshotRow[];

    const firstRow = rows[0];
    const version = createContextVersion(
      parseSqliteNonNegativeInteger(firstRow?.version ?? 0, 'context_versions.version'),
    );
    const itemRows = rows.flatMap((row) => {
      if (row.position === null) {
        return [];
      }

      return [
        {
          position: row.position,
          message_id: row.message_id,
          summary_id: row.summary_id,
        } satisfies ContextItemRow,
      ];
    });

    return {
      items: normalizePositions(
        conversationId,
        itemRows.map((row) => toContextItem(conversationId, row)),
      ),
      version,
    };
  }

  async getContextTokenCount(conversationId: ConversationId): Promise<TokenCount> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(
          SUM(
            CASE
              WHEN ci.message_id IS NOT NULL THEN le.token_count
              WHEN ci.summary_id IS NOT NULL THEN sn.token_count
              ELSE 0
            END
          ),
          0
        ) AS total_tokens
        FROM context_items ci
        LEFT JOIN ledger_events le ON le.id = ci.message_id
        LEFT JOIN summary_nodes sn ON sn.id = ci.summary_id
        WHERE ci.conversation_id = ?`,
      )
      .get(conversationId) as ContextTokenCountRow | undefined;

    return createTokenCount(
      parseSqliteNonNegativeInteger(row?.total_tokens ?? 0, 'context token count'),
    );
  }

  async appendContextItems(
    conversationId: ConversationId,
    items: readonly ContextItem[],
  ): Promise<ContextVersion> {
    return withSavepoint(this.db, SQLITE_CONTEXT_APPEND_SAVEPOINT, () => {
      this.ensureVersionRow(conversationId);

      if (items.length === 0) {
        return this.getCurrentVersion(conversationId);
      }

      const existing = this.getNormalizedContextItems(conversationId);
      let nextPosition = existing.length;

      for (const item of items) {
        if (item.conversationId !== conversationId) {
          throw new InvariantViolationError('Context item conversation mismatch during append.');
        }

        const columns = toInsertionColumns(item);
        this.db
          .prepare(
            `INSERT INTO context_items (conversation_id, position, message_id, summary_id)
             VALUES (?, ?, ?, ?)`,
          )
          .run(conversationId, nextPosition, columns.messageId, columns.summaryId);
        nextPosition += 1;
      }

      const updateResult = this.db
        .prepare(
          `UPDATE context_versions
           SET version = version + 1
           WHERE conversation_id = ?`,
        )
        .run(conversationId);

      if (updateResult.changes !== 1) {
        throw new InvariantViolationError(
          'Failed to append context items and increment context version.',
        );
      }

      return this.getCurrentVersion(conversationId);
    });
  }

  async replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: readonly number[],
    replacement: ContextItem,
  ): Promise<ContextVersion> {
    return withSavepoint(this.db, SQLITE_CONTEXT_REPLACE_SAVEPOINT, () => {
      this.ensureVersionRow(conversationId);

      const currentVersion = this.getCurrentVersion(conversationId);
      if (currentVersion !== expectedVersion) {
        throw new StaleContextVersionError(expectedVersion, currentVersion);
      }

      if (replacement.conversationId !== conversationId) {
        throw new InvariantViolationError('Replacement context item conversation mismatch.');
      }

      const removalPositions = dedupeAndSortPositions(positionsToRemove);
      if (removalPositions.length === 0) {
        return currentVersion;
      }

      const existing = this.getNormalizedContextItems(conversationId);
      for (const position of removalPositions) {
        if (!Number.isSafeInteger(position) || position < 0 || position >= existing.length) {
          throw new InvariantViolationError(
            'positionsToRemove contains an out-of-range context position.',
          );
        }
      }

      const removalSet = new Set(removalPositions);
      const insertionIndex = removalPositions[0];
      if (insertionIndex === undefined) {
        return currentVersion;
      }

      const retained = existing.filter((item) => !removalSet.has(item.position));
      const merged = [
        ...retained.slice(0, insertionIndex),
        createContextItem({
          conversationId,
          position: insertionIndex,
          ref: replacement.ref,
        }),
        ...retained.slice(insertionIndex),
      ];
      const normalizedMerged = normalizePositions(conversationId, merged);

      this.db
        .prepare(
          `DELETE FROM context_items
           WHERE conversation_id = ?`,
        )
        .run(conversationId);

      const insert = this.db.prepare(
        `INSERT INTO context_items (conversation_id, position, message_id, summary_id)
         VALUES (?, ?, ?, ?)`,
      );

      for (const item of normalizedMerged) {
        const columns = toInsertionColumns(item);
        insert.run(conversationId, item.position, columns.messageId, columns.summaryId);
      }

      const updateResult = this.db
        .prepare(
          `UPDATE context_versions
           SET version = version + 1
           WHERE conversation_id = ?
             AND version = ?`,
        )
        .run(conversationId, expectedVersion);

      if (updateResult.changes !== 1) {
        const actualVersion = this.getCurrentVersion(conversationId);
        throw new StaleContextVersionError(expectedVersion, actualVersion);
      }

      return this.getCurrentVersion(conversationId);
    });
  }
}
