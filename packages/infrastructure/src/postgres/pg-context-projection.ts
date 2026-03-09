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

import { mapPgError } from './errors';
import type { PgExecutor } from './types';

interface ContextVersionRow {
  readonly version: number | string;
}

interface ContextItemRow {
  readonly position: number | string;
  readonly message_id: string | null;
  readonly summary_id: string | null;
}

interface ContextSnapshotRow {
  readonly version: number | string;
  readonly position: number | string | null;
  readonly message_id: string | null;
  readonly summary_id: string | null;
}

interface ContextTokenCountRow {
  readonly total_tokens: number | string | null;
}

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
  const position = parsePgVersion(row.position, 'context_items.position');

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

const parsePgVersion = (value: number | string, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvariantViolationError(`Invalid ${fieldName} from PostgreSQL row.`);
  }

  return parsed;
};

export class PgContextProjection implements ContextProjectionPort {
  constructor(private readonly executor: PgExecutor) {}

  private async ensureVersionRow(conversationId: ConversationId): Promise<void> {
    await this.executor.query(
      `INSERT INTO context_versions (conversation_id, version)
       VALUES ($1, 0)
       ON CONFLICT (conversation_id) DO NOTHING`,
      [conversationId],
    );
  }

  private async getCurrentVersion(conversationId: ConversationId): Promise<ContextVersion> {
    const result = await this.executor.query<ContextVersionRow>(
      `SELECT version
       FROM context_versions
       WHERE conversation_id = $1`,
      [conversationId],
    );

    const rawVersion = parsePgVersion(result.rows[0]?.version ?? 0, 'context_versions.version');
    return createContextVersion(rawVersion);
  }

  async getCurrentContext(conversationId: ConversationId): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ContextVersion;
  }> {
    try {
      await this.ensureVersionRow(conversationId);

      const snapshotResult = await this.executor.query<ContextSnapshotRow>(
        `SELECT
           cv.version,
           ci.position,
           ci.message_id,
           ci.summary_id
         FROM context_versions cv
         LEFT JOIN context_items ci
           ON ci.conversation_id = cv.conversation_id
         WHERE cv.conversation_id = $1
         ORDER BY ci.position ASC NULLS LAST`,
        [conversationId],
      );

      const firstRow = snapshotResult.rows[0];
      const version = createContextVersion(
        parsePgVersion(firstRow?.version ?? 0, 'context_versions.version'),
      );

      const itemRows = snapshotResult.rows.flatMap((row) => {
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

      const items = normalizePositions(
        conversationId,
        itemRows.map((row) => toContextItem(conversationId, row)),
      );

      return {
        items,
        version,
      };
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getContextTokenCount(conversationId: ConversationId): Promise<TokenCount> {
    try {
      const result = await this.executor.query<ContextTokenCountRow>(
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
        WHERE ci.conversation_id = $1`,
        [conversationId],
      );

      const rawTotalTokens = result.rows[0]?.total_tokens;
      const totalTokens =
        rawTotalTokens === null || rawTotalTokens === undefined
          ? 0
          : parsePgVersion(rawTotalTokens, 'context token count');

      return createTokenCount(totalTokens);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async appendContextItems(
    conversationId: ConversationId,
    items: readonly ContextItem[],
  ): Promise<ContextVersion> {
    try {
      await this.ensureVersionRow(conversationId);

      if (items.length === 0) {
        return this.getCurrentVersion(conversationId);
      }

      const messageIds: (string | null)[] = [];
      const summaryIds: (string | null)[] = [];

      for (const item of items) {
        if (item.conversationId !== conversationId) {
          throw new InvariantViolationError('Context item conversation mismatch during append.');
        }

        const columns = toInsertionColumns(item);
        messageIds.push(columns.messageId);
        summaryIds.push(columns.summaryId);
      }

      const appendResult = await this.executor.query<ContextVersionRow>(
        `WITH locked_version AS (
           SELECT version
           FROM context_versions
           WHERE conversation_id = $1
           FOR UPDATE
         ),
         base_position AS (
           SELECT COALESCE(MAX(position), -1) AS max_position
           FROM context_items
           WHERE conversation_id = $1
             AND EXISTS (SELECT 1 FROM locked_version)
         ),
         version_bump AS (
           UPDATE context_versions
           SET version = version + 1
           WHERE conversation_id = $1
             AND EXISTS (SELECT 1 FROM locked_version)
           RETURNING version
         ),
         payload AS (
           SELECT
             ((SELECT max_position FROM base_position) + source.ordinality)::integer AS position,
             source.message_id,
             source.summary_id
           FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS source(message_id, summary_id, ordinality)
         ),
         inserted AS (
           INSERT INTO context_items (conversation_id, position, message_id, summary_id)
           SELECT $1, payload.position, payload.message_id, payload.summary_id
           FROM payload
           WHERE EXISTS (SELECT 1 FROM version_bump)
         )
         SELECT version
         FROM version_bump`,
        [conversationId, messageIds, summaryIds],
      );

      const nextVersion = appendResult.rows[0]?.version;
      if (nextVersion === undefined) {
        throw new InvariantViolationError('Failed to append context items and increment context version.');
      }

      return createContextVersion(parsePgVersion(nextVersion, 'context_versions.version'));
    } catch (error) {
      return mapPgError(error);
    }
  }

  async replaceContextItems(
    conversationId: ConversationId,
    expectedVersion: ContextVersion,
    positionsToRemove: readonly number[],
    replacement: ContextItem,
  ): Promise<ContextVersion> {
    try {
      await this.ensureVersionRow(conversationId);

      const currentVersion = await this.getCurrentVersion(conversationId);
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

      const existingResult = await this.executor.query<ContextItemRow>(
        `SELECT position, message_id, summary_id
         FROM context_items
         WHERE conversation_id = $1
         ORDER BY position ASC`,
        [conversationId],
      );

      const normalizedExisting = normalizePositions(
        conversationId,
        existingResult.rows.map((row) => toContextItem(conversationId, row)),
      );

      for (const position of removalPositions) {
        if (!Number.isSafeInteger(position) || position < 0 || position >= normalizedExisting.length) {
          throw new InvariantViolationError('positionsToRemove contains an out-of-range context position.');
        }
      }

      const removalSet = new Set(removalPositions);
      const insertionIndex = removalPositions[0];
      if (insertionIndex === undefined) {
        return currentVersion;
      }

      const retained = normalizedExisting.filter((item) => !removalSet.has(item.position));
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
      const positions: number[] = [];
      const messageIds: (string | null)[] = [];
      const summaryIds: (string | null)[] = [];

      for (const item of normalizedMerged) {
        const columns = toInsertionColumns(item);
        positions.push(item.position);
        messageIds.push(columns.messageId);
        summaryIds.push(columns.summaryId);
      }

      const updateResult = await this.executor.query<ContextVersionRow>(
        `WITH version_bump AS (
          UPDATE context_versions
          SET version = version + 1
          WHERE conversation_id = $1
            AND version = $2
          RETURNING version
        ),
        upserted AS (
          INSERT INTO context_items (conversation_id, position, message_id, summary_id)
          SELECT
            $1,
            payload.position,
            payload.message_id,
            payload.summary_id
          FROM unnest($3::integer[], $4::text[], $5::text[]) AS payload(position, message_id, summary_id)
          WHERE EXISTS (SELECT 1 FROM version_bump)
          ON CONFLICT (conversation_id, position) DO UPDATE
          SET message_id = EXCLUDED.message_id,
              summary_id = EXCLUDED.summary_id
        ),
        deleted AS (
          DELETE FROM context_items ci
          WHERE ci.conversation_id = $1
            AND EXISTS (SELECT 1 FROM version_bump)
            AND NOT EXISTS (
              SELECT 1
              FROM unnest($3::integer[]) AS keep(position)
              WHERE keep.position = ci.position
            )
        )
        SELECT version
        FROM version_bump`,
        [conversationId, expectedVersion, positions, messageIds, summaryIds],
      );

      const nextVersion = updateResult.rows[0]?.version;
      if (nextVersion === undefined) {
        const actualVersion = await this.getCurrentVersion(conversationId);
        throw new StaleContextVersionError(expectedVersion, actualVersion);
      }

      return createContextVersion(parsePgVersion(nextVersion, 'context_versions.version'));
    } catch (error) {
      if (error instanceof StaleContextVersionError) {
        throw error;
      }

      return mapPgError(error);
    }
  }
}
