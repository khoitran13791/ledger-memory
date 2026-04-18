import {
  IdempotencyConflictError,
  type LedgerAppendPort,
  type LedgerReadGrepMatch,
  type LedgerReadPort,
  type RegexSearchPageInput,
  type RegexSearchPageOutput,
  type SequenceRange,
} from '@ledgermind/application';
import {
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNodeId,
  createTokenCount,
  createTimestamp,
  InvariantViolationError,
  NonMonotonicSequenceError,
  type ConversationId,
  type EventMetadata,
  type LedgerEvent,
  type SequenceNumber,
  type SummaryNodeId,
} from '@ledgermind/domain';

import { mapPgError } from './errors';
import { toJsonObject } from './sql';
import { toRowCount, type PgExecutor } from './types';

interface LedgerEventRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly seq: number | string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly token_count: number;
  readonly occurred_at: string | Date;
  readonly metadata: unknown;
}

interface SequenceRow {
  readonly next_sequence: number | string;
}

interface ConversationLockRow {
  readonly id: string;
}

interface ExistingEventIdRow {
  readonly id: string;
}

interface ExistingIdempotencyRow {
  readonly id: string;
  readonly metadata: unknown;
}

interface PendingLedgerInsertRow {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly role: LedgerEvent['role'];
  readonly content: string;
  readonly tokenCount: number;
  readonly occurredAt: string;
  readonly metadataJson: string;
  readonly idempotencyKey: string | null;
  readonly idempotencyDigest: string | null;
}

interface RegexMatchRow {
  readonly id: string;
  readonly seq: number | string;
  readonly content: string;
  readonly match_start: number;
  readonly match_length: number;
  readonly covering_summary_id: string | null;
  readonly total_match_count: number | string;
}

interface PgErrorConstraintCandidate {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const IDEMPOTENCY_KEY_METADATA_FIELD = '__ledgermind_idempotencyKey';
const IDEMPOTENCY_DIGEST_METADATA_FIELD = '__ledgermind_idempotencyDigest';
const LEDGER_IDEMPOTENCY_CONSTRAINT = 'ledger_events_conversation_id_idempotency_key_key';
const INSERT_SINGLE_LEDGER_EVENT_SQL = `INSERT INTO ledger_events (
  id,
  conversation_id,
  seq,
  role,
  content,
  token_count,
  occurred_at,
  metadata,
  idempotency_key
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
ON CONFLICT (id) DO NOTHING`;
const INSERT_BATCH_LEDGER_EVENTS_SQL = `INSERT INTO ledger_events (
  id,
  conversation_id,
  seq,
  role,
  content,
  token_count,
  occurred_at,
  metadata,
  idempotency_key
)
SELECT
  payload.id,
  payload.conversation_id,
  payload.seq,
  payload.role::message_role,
  payload.content,
  payload.token_count,
  payload.occurred_at,
  payload.metadata,
  payload.idempotency_key
FROM jsonb_to_recordset($1::jsonb) AS payload(
  id text,
  conversation_id text,
  seq bigint,
  role text,
  content text,
  token_count integer,
  occurred_at timestamptz,
  metadata jsonb,
  idempotency_key text
)
ON CONFLICT (id) DO NOTHING`;

const createExcerpt = (content: string, start: number, length: number): string => {
  const excerptStart = Math.max(0, start - 24);
  const excerptEnd = Math.min(content.length, start + Math.max(1, length) + 24);
  return content.slice(excerptStart, excerptEnd);
};

const toEventMetadata = (value: unknown): EventMetadata => {
  return Object.freeze(toJsonObject(value));
};

const toDomainEvent = (row: LedgerEventRow): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(row.id),
    conversationId: row.conversation_id as ConversationId,
    sequence: toEventSequenceNumber(row.seq),
    role: row.role,
    content: row.content,
    tokenCount: createTokenCount(row.token_count),
    occurredAt: createTimestamp(row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at)),
    metadata: toEventMetadata(row.metadata),
  });
};

const normalizeRangeBound = (value: SequenceNumber | undefined): number | null => {
  return value === undefined ? null : value;
};

const parsePgBigInt = (value: number | string, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed)) {
    throw new InvariantViolationError(`Invalid ${fieldName} from PostgreSQL row.`);
  }

  return parsed;
};

const toScopedSummary = (scope?: SummaryNodeId): SummaryNodeId | null => {
  return scope ?? null;
};

const toEventSequenceNumber = (value: number | string): SequenceNumber => {
  return createSequenceNumber(parsePgBigInt(value, 'ledger_events.seq'));
};

const readMetadataStringField = (metadata: EventMetadata, field: string): string | null => {
  const value = metadata[field];
  return typeof value === 'string' ? value : null;
};

const extractIdempotencyMetadata = (event: LedgerEvent): {
  readonly key: string | null;
  readonly digest: string | null;
} => {
  return {
    key: readMetadataStringField(event.metadata, IDEMPOTENCY_KEY_METADATA_FIELD),
    digest: readMetadataStringField(event.metadata, IDEMPOTENCY_DIGEST_METADATA_FIELD),
  };
};

const isUniqueIdempotencyConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as PgErrorConstraintCandidate;
  return candidate.code === '23505' && candidate.constraint === LEDGER_IDEMPOTENCY_CONSTRAINT;
};

const createIdempotencyConflictError = (
  conversationId: ConversationId,
  idempotencyKey: string,
): IdempotencyConflictError => {
  return new IdempotencyConflictError(conversationId, idempotencyKey);
};

const toPendingInsertRow = (
  event: LedgerEvent,
  conversationId: ConversationId,
  idempotencyKey: string | null,
  idempotencyDigest: string | null,
): PendingLedgerInsertRow => {
  return {
    id: event.id,
    conversationId,
    sequence: event.sequence,
    role: event.role,
    content: event.content,
    tokenCount: event.tokenCount.value,
    occurredAt: event.occurredAt.toISOString(),
    metadataJson: JSON.stringify(event.metadata),
    idempotencyKey,
    idempotencyDigest,
  };
};

export class PgLedgerStore implements LedgerAppendPort, LedgerReadPort {
  constructor(private readonly executor: PgExecutor) {}

  private async findExistingByIdempotency(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): Promise<ExistingIdempotencyRow | null> {
    const existingByIdempotency = await this.executor.query<ExistingIdempotencyRow>(
      `SELECT id, metadata
       FROM ledger_events
       WHERE conversation_id = $1
         AND idempotency_key = $2
       LIMIT 1`,
      [conversationId, idempotencyKey],
    );

    return existingByIdempotency.rows[0] ?? null;
  }

  private existingRowMatchesDigest(existingRow: ExistingIdempotencyRow, digest: string | null): boolean {
    const existingMetadata = toEventMetadata(existingRow.metadata);
    const existingDigest = readMetadataStringField(existingMetadata, IDEMPOTENCY_DIGEST_METADATA_FIELD);
    return digest !== null && existingDigest === digest;
  }

  private async insertPreparedEventsIndividually(
    conversationId: ConversationId,
    rows: readonly PendingLedgerInsertRow[],
  ): Promise<void> {
    for (const row of rows) {
      try {
        await this.executor.query(INSERT_SINGLE_LEDGER_EVENT_SQL, [
          row.id,
          row.conversationId,
          row.sequence,
          row.role,
          row.content,
          row.tokenCount,
          row.occurredAt,
          row.metadataJson,
          row.idempotencyKey,
        ]);
      } catch (error) {
        if (row.idempotencyKey !== null && isUniqueIdempotencyConflict(error)) {
          const existingRow = await this.findExistingByIdempotency(conversationId, row.idempotencyKey);
          if (existingRow !== null && this.existingRowMatchesDigest(existingRow, row.idempotencyDigest)) {
            continue;
          }

          throw createIdempotencyConflictError(conversationId, row.idempotencyKey);
        }

        throw error;
      }
    }
  }

  private async insertPreparedEvents(
    conversationId: ConversationId,
    rows: readonly PendingLedgerInsertRow[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const payload = rows.map((row) => {
      return {
        id: row.id,
        conversation_id: row.conversationId,
        seq: row.sequence,
        role: row.role,
        content: row.content,
        token_count: row.tokenCount,
        occurred_at: row.occurredAt,
        metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
        idempotency_key: row.idempotencyKey,
      };
    });

    try {
      await this.executor.query(INSERT_BATCH_LEDGER_EVENTS_SQL, [JSON.stringify(payload)]);
    } catch (error) {
      if (rows.some((row) => row.idempotencyKey !== null) && isUniqueIdempotencyConflict(error)) {
        await this.insertPreparedEventsIndividually(conversationId, rows);
        return;
      }

      throw error;
    }
  }

  async appendEvents(conversationId: ConversationId, events: readonly LedgerEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    try {
      await this.executor.query<ConversationLockRow>(
        `SELECT id
         FROM conversations
         WHERE id = $1
         FOR UPDATE`,
        [conversationId],
      );

      const sequenceResult = await this.executor.query<SequenceRow>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence
         FROM ledger_events
         WHERE conversation_id = $1`,
        [conversationId],
      );

      let expectedSequence = parsePgBigInt(sequenceResult.rows[0]?.next_sequence ?? 1, 'next_sequence');
      const persistedIdempotencyKeys = new Set<string>();
      const rowsToInsert: PendingLedgerInsertRow[] = [];

      for (const event of events) {
        if (event.conversationId !== conversationId) {
          throw new InvariantViolationError('LedgerEvent conversation mismatch during append.');
        }

        const idempotency = extractIdempotencyMetadata(event);

        if (idempotency.key !== null && !persistedIdempotencyKeys.has(idempotency.key)) {
          const existingRow = await this.findExistingByIdempotency(conversationId, idempotency.key);
          if (existingRow !== null) {
            if (this.existingRowMatchesDigest(existingRow, idempotency.digest)) {
              persistedIdempotencyKeys.add(idempotency.key);
              continue;
            }

            throw createIdempotencyConflictError(conversationId, idempotency.key);
          }
        }

        if (event.sequence !== expectedSequence) {
          const duplicateById = await this.executor.query<ExistingEventIdRow>(
            `SELECT id
             FROM ledger_events
             WHERE id = $1`,
            [event.id],
          );

          if (toRowCount(duplicateById.rowCount) > 0) {
            continue;
          }

          throw new NonMonotonicSequenceError(
            `LedgerEvent sequence must be gap-free. Expected ${expectedSequence}, received ${event.sequence}.`,
          );
        }

        rowsToInsert.push(
          toPendingInsertRow(
            event,
            conversationId,
            idempotency.key !== null && !persistedIdempotencyKeys.has(idempotency.key) ? idempotency.key : null,
            idempotency.digest,
          ),
        );

        if (idempotency.key !== null) {
          persistedIdempotencyKeys.add(idempotency.key);
        }

        expectedSequence += 1;
      }

      await this.insertPreparedEvents(conversationId, rowsToInsert);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getNextSequence(conversationId: ConversationId): Promise<SequenceNumber> {
    try {
      await this.executor.query<ConversationLockRow>(
        `SELECT id
         FROM conversations
         WHERE id = $1
         FOR UPDATE`,
        [conversationId],
      );

      const result = await this.executor.query<SequenceRow>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence
         FROM ledger_events
         WHERE conversation_id = $1`,
        [conversationId],
      );

      return createSequenceNumber(parsePgBigInt(result.rows[0]?.next_sequence ?? 1, 'next_sequence'));
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getEvents(
    conversationId: ConversationId,
    range?: SequenceRange,
  ): Promise<readonly LedgerEvent[]> {
    try {
      const start = normalizeRangeBound(range?.start);
      const end = normalizeRangeBound(range?.end);

      const result = await this.executor.query<LedgerEventRow>(
        `SELECT id, conversation_id, seq, role, content, token_count, occurred_at, metadata
         FROM ledger_events
         WHERE conversation_id = $1
           AND ($2::bigint IS NULL OR seq >= $2::bigint)
           AND ($3::bigint IS NULL OR seq <= $3::bigint)
         ORDER BY seq ASC`,
        [conversationId, start, end],
      );

      return result.rows.map(toDomainEvent);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async searchEvents(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly LedgerEvent[]> {
    const normalized = query.trim();
    if (normalized.length === 0) {
      return [];
    }

    try {
      const scopedSummaryId = toScopedSummary(scope);

      const result = await this.executor.query<LedgerEventRow>(
        `WITH RECURSIVE scoped_summaries AS (
          SELECT $3::text AS summary_id
          WHERE $3::text IS NOT NULL

          UNION ALL

          SELECT spe.parent_summary_id AS summary_id
          FROM summary_parent_edges spe
          JOIN scoped_summaries ss ON spe.summary_id = ss.summary_id
        ),
        scoped_messages AS (
          SELECT sme.message_id
          FROM summary_message_edges sme
          JOIN scoped_summaries ss ON ss.summary_id = sme.summary_id
        )
        SELECT id, conversation_id, seq, role, content, token_count, occurred_at, metadata
        FROM ledger_events
        WHERE conversation_id = $1
          AND ($3::text IS NULL OR id IN (SELECT message_id FROM scoped_messages))
          AND content_tsv @@ plainto_tsquery('english', $2)
        ORDER BY seq ASC`,
        [conversationId, normalized, scopedSummaryId],
      );

      return result.rows.map(toDomainEvent);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    page: RegexSearchPageInput,
  ): Promise<RegexSearchPageOutput> {
    try {
      const scopedSummaryId = toScopedSummary(page.scope);

      const result = await this.executor.query<RegexMatchRow>(
        `WITH RECURSIVE active_summary_refs AS (
          SELECT ci.summary_id, ci.position
          FROM context_items ci
          WHERE ci.conversation_id = $1
            AND ci.summary_id IS NOT NULL
        ),
        active_summary_scope AS (
          SELECT
            asr.summary_id AS covering_summary_id,
            asr.summary_id AS source_summary_id,
            asr.position,
            ARRAY[asr.summary_id]::text[] AS path
          FROM active_summary_refs asr

          UNION ALL

          SELECT
            ass.covering_summary_id,
            spe.parent_summary_id AS source_summary_id,
            ass.position,
            ass.path || spe.parent_summary_id
          FROM active_summary_scope ass
          JOIN summary_parent_edges spe ON spe.summary_id = ass.source_summary_id
          WHERE NOT spe.parent_summary_id = ANY(ass.path)
        ),
        active_message_coverage AS (
          SELECT DISTINCT ON (sme.message_id)
            sme.message_id,
            ass.covering_summary_id
          FROM active_summary_scope ass
          JOIN summary_message_edges sme ON sme.summary_id = ass.source_summary_id
          ORDER BY sme.message_id, ass.position ASC, ass.covering_summary_id ASC
        ),
        scoped_summaries AS (
          SELECT $3::text AS summary_id
          WHERE $3::text IS NOT NULL

          UNION ALL

          SELECT spe.parent_summary_id AS summary_id
          FROM summary_parent_edges spe
          JOIN scoped_summaries ss ON spe.summary_id = ss.summary_id
        ),
        scoped_messages AS (
          SELECT sme.message_id
          FROM summary_message_edges sme
          JOIN scoped_summaries ss ON ss.summary_id = sme.summary_id
        ),
        matched AS (
          SELECT
            le.id,
            le.seq,
            le.content,
            regexp_instr(
              CASE
                WHEN le.role = 'system' AND le.content LIKE '__SYSTEM_PROMPT__%' THEN substring(le.content FROM 16)
                ELSE le.content
              END,
              $2,
              1,
              1,
              0,
              'n'
            ) AS match_start,
            COALESCE(length(substring(le.content FROM $2)), 0) AS match_length,
            CASE
              WHEN $3::text IS NOT NULL THEN $3::text
              ELSE amc.covering_summary_id
            END AS covering_summary_id
          FROM ledger_events le
          LEFT JOIN active_message_coverage amc ON amc.message_id = le.id
          WHERE le.conversation_id = $1
            AND (
              $3::text IS NULL
              OR le.id IN (SELECT message_id FROM scoped_messages)
            )
            AND regexp_instr(
              CASE
                WHEN le.role = 'system' AND le.content LIKE '__SYSTEM_PROMPT__%' THEN substring(le.content FROM 16)
                ELSE le.content
              END,
              $2,
              1,
              1,
              0,
              'n'
            ) > 0
        ),
        paged AS (
          SELECT
            matched.*,
            COUNT(*) OVER() AS total_match_count
          FROM matched
          ORDER BY seq ASC
          OFFSET $4
          LIMIT $5
        )
        SELECT
          id,
          seq,
          content,
          match_start,
          match_length,
          covering_summary_id,
          total_match_count
        FROM paged`,
        [conversationId, pattern, scopedSummaryId, page.offset, page.limit],
      );

      const matches = result.rows.map((row) => {
        const startIndex = Math.max(0, row.match_start - 1);
        const excerpt = createExcerpt(row.content, startIndex, row.match_length);

        const match: LedgerReadGrepMatch = {
          eventId: createEventId(row.id),
          sequence: toEventSequenceNumber(row.seq),
          excerpt,
          ...(row.covering_summary_id === null
            ? {}
            : { coveringSummaryId: createSummaryNodeId(row.covering_summary_id) }),
        };

        return match;
      });

      return {
        matches,
        totalMatchCount:
          result.rows.length === 0
            ? 0
            : parsePgBigInt(result.rows[0]!.total_match_count, 'regex_match.total_match_count'),
      };
    } catch (error) {
      return mapPgError(error);
    }
  }
}
