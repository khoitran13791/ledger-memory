import {
  IdempotencyConflictError,
  type LedgerAppendPort,
  type LedgerReadGrepMatch,
  type LedgerReadPort,
  type SequenceRange,
} from '@ledgermind/application';
import {
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
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

interface RegexMatchRow {
  readonly id: string;
  readonly seq: number;
  readonly content: string;
  readonly match_start: number;
  readonly match_length: number;
}

interface PgErrorConstraintCandidate {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const IDEMPOTENCY_KEY_METADATA_FIELD = '__ledgermind_idempotencyKey';
const IDEMPOTENCY_DIGEST_METADATA_FIELD = '__ledgermind_idempotencyDigest';
const LEDGER_IDEMPOTENCY_CONSTRAINT = 'ledger_events_conversation_id_idempotency_key_key';

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

export class PgLedgerStore implements LedgerAppendPort, LedgerReadPort {
  constructor(private readonly executor: PgExecutor) {}

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

      for (const event of events) {
        if (event.conversationId !== conversationId) {
          throw new InvariantViolationError('LedgerEvent conversation mismatch during append.');
        }

        const idempotency = extractIdempotencyMetadata(event);

        if (idempotency.key !== null && !persistedIdempotencyKeys.has(idempotency.key)) {
          const existingByIdempotency = await this.executor.query<ExistingIdempotencyRow>(
            `SELECT id, metadata
             FROM ledger_events
             WHERE conversation_id = $1
               AND idempotency_key = $2
             LIMIT 1`,
            [conversationId, idempotency.key],
          );

          const existingRow = existingByIdempotency.rows[0];
          if (existingRow) {
            const existingMetadata = toEventMetadata(existingRow.metadata);
            const existingDigest = readMetadataStringField(existingMetadata, IDEMPOTENCY_DIGEST_METADATA_FIELD);

            if (idempotency.digest !== null && existingDigest === idempotency.digest) {
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

        try {
          const insertResult = await this.executor.query(
            `INSERT INTO ledger_events (
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
            ON CONFLICT (id) DO NOTHING`,
            [
              event.id,
              conversationId,
              event.sequence,
              event.role,
              event.content,
              event.tokenCount.value,
              event.occurredAt,
              JSON.stringify(event.metadata),
              idempotency.key !== null && !persistedIdempotencyKeys.has(idempotency.key)
                ? idempotency.key
                : null,
            ],
          );

          if (toRowCount(insertResult.rowCount) === 0) {
            continue;
          }
        } catch (error) {
          if (idempotency.key !== null && isUniqueIdempotencyConflict(error)) {
            const existingByIdempotency = await this.executor.query<ExistingIdempotencyRow>(
              `SELECT id, metadata
               FROM ledger_events
               WHERE conversation_id = $1
                 AND idempotency_key = $2
               LIMIT 1`,
              [conversationId, idempotency.key],
            );

            const existingRow = existingByIdempotency.rows[0];
            if (existingRow) {
              const existingMetadata = toEventMetadata(existingRow.metadata);
              const existingDigest = readMetadataStringField(existingMetadata, IDEMPOTENCY_DIGEST_METADATA_FIELD);

              if (idempotency.digest !== null && existingDigest === idempotency.digest) {
                persistedIdempotencyKeys.add(idempotency.key);
                continue;
              }

              throw createIdempotencyConflictError(conversationId, idempotency.key);
            }
          }

          throw error;
        }

        if (idempotency.key !== null) {
          persistedIdempotencyKeys.add(idempotency.key);
        }

        expectedSequence += 1;
      }
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
    scope?: SummaryNodeId,
  ): Promise<readonly LedgerReadGrepMatch[]> {
    try {
      const scopedSummaryId = toScopedSummary(scope);

      const result = await this.executor.query<RegexMatchRow>(
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
        SELECT
          le.id,
          le.seq,
          le.content,
          regexp_instr(le.content, $2, 1, 1, 0, 'n') AS match_start,
          COALESCE(length(substring(le.content FROM $2)), 0) AS match_length
        FROM ledger_events le
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
        ORDER BY le.seq ASC`,
        [conversationId, pattern, scopedSummaryId],
      );

      return result.rows.map((row) => {
        const startIndex = Math.max(0, row.match_start - 1);
        const excerpt = createExcerpt(row.content, startIndex, row.match_length);

        const match: LedgerReadGrepMatch = {
          eventId: createEventId(row.id),
          sequence: toEventSequenceNumber(row.seq),
          excerpt,
          ...(scope === undefined ? {} : { coveringSummaryId: scope }),
        };

        return match;
      });
    } catch (error) {
      return mapPgError(error);
    }
  }
}
