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
  createTimestamp,
  createTokenCount,
  InvariantViolationError,
  NonMonotonicSequenceError,
  type ConversationId,
  type EventMetadata,
  type LedgerEvent,
  type SequenceNumber,
  type SummaryNodeId,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger, parseSqliteJsonObject, stringifySqliteJson } from './sqlite-json';

interface LedgerEventRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly seq: unknown;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly token_count: unknown;
  readonly occurred_at: string;
  readonly metadata_json: unknown;
}

interface SequenceRow {
  readonly next_sequence: unknown;
}

interface ExistingEventIdRow {
  readonly id: string;
}

interface ExistingIdempotencyRow {
  readonly id: string;
  readonly metadata_json: unknown;
}

interface ScopedMessageRow {
  readonly message_id: string;
}

interface RegexCandidateRow {
  readonly id: string;
  readonly seq: unknown;
  readonly content: string;
}

interface ActiveSummaryRow {
  readonly summary_id: string;
  readonly position: unknown;
}

interface ParentSummaryEdgeRow {
  readonly parent_summary_id: string;
}

const IDEMPOTENCY_KEY_METADATA_FIELD = '__ledgermind_idempotencyKey';
const IDEMPOTENCY_DIGEST_METADATA_FIELD = '__ledgermind_idempotencyDigest';
const SQLITE_LEDGER_APPEND_SAVEPOINT = 'sqlite_ledger_append';
const SEARCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'please',
  'the',
  'to',
  'was',
  'we',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
]);

const createExcerpt = (content: string, start: number, length: number): string => {
  const excerptStart = Math.max(0, start - 24);
  const excerptEnd = Math.min(content.length, start + Math.max(1, length) + 24);
  return content.slice(excerptStart, excerptEnd);
};

const toEventMetadata = (value: unknown): EventMetadata => {
  return Object.freeze(parseSqliteJsonObject(value));
};

const toEventSequenceNumber = (value: unknown): SequenceNumber => {
  return createSequenceNumber(parseSqliteInteger(value, 'ledger_events.seq'));
};

const toDomainEvent = (row: LedgerEventRow): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(row.id),
    conversationId: row.conversation_id as ConversationId,
    sequence: toEventSequenceNumber(row.seq),
    role: row.role,
    content: row.content,
    tokenCount: createTokenCount(parseSqliteInteger(row.token_count, 'ledger_events.token_count')),
    occurredAt: createTimestamp(new Date(row.occurred_at)),
    metadata: toEventMetadata(row.metadata_json),
  });
};

const normalizeRangeBound = (value: SequenceNumber | undefined): number | null => {
  return value === undefined ? null : value;
};

const readMetadataStringField = (metadata: EventMetadata, field: string): string | null => {
  const value = metadata[field];
  return typeof value === 'string' ? value : null;
};

const extractIdempotencyMetadata = (
  event: LedgerEvent,
): {
  readonly key: string | null;
  readonly digest: string | null;
} => {
  return {
    key: readMetadataStringField(event.metadata, IDEMPOTENCY_KEY_METADATA_FIELD),
    digest: readMetadataStringField(event.metadata, IDEMPOTENCY_DIGEST_METADATA_FIELD),
  };
};

const escapeLikePattern = (value: string): string => {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
};

const tokenizeSearchQuery = (query: string): readonly string[] => {
  const seen = new Set<string>();
  const tokens = query
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));

  if (tokens === undefined) {
    return [];
  }

  return tokens.filter((token) => {
    if (seen.has(token)) {
      return false;
    }

    seen.add(token);
    return true;
  });
};

const toScopedSummary = (scope?: SummaryNodeId): SummaryNodeId | null => {
  return scope ?? null;
};

export class SqliteLedgerStore implements LedgerAppendPort, LedgerReadPort {
  constructor(private readonly db: DatabaseSync) {}

  private findExistingByIdempotency(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): ExistingIdempotencyRow | null {
    const row = this.db
      .prepare(
        `SELECT id, metadata_json
         FROM ledger_events
         WHERE conversation_id = ?
           AND idempotency_key = ?
         LIMIT 1`,
      )
      .get(conversationId, idempotencyKey) as ExistingIdempotencyRow | undefined;

    return row ?? null;
  }

  private existingRowMatchesDigest(
    existingRow: ExistingIdempotencyRow,
    digest: string | null,
  ): boolean {
    const existingMetadata = toEventMetadata(existingRow.metadata_json);
    const existingDigest = readMetadataStringField(
      existingMetadata,
      IDEMPOTENCY_DIGEST_METADATA_FIELD,
    );
    return digest !== null && existingDigest === digest;
  }

  private eventExists(eventId: LedgerEvent['id']): boolean {
    const row = this.db
      .prepare(
        `SELECT id
         FROM ledger_events
         WHERE id = ?`,
      )
      .get(eventId) as ExistingEventIdRow | undefined;

    return row !== undefined;
  }

  private insertEvent(
    event: LedgerEvent,
    conversationId: ConversationId,
    idempotencyKey: string | null,
    idempotencyDigest: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ledger_events (
          id,
          conversation_id,
          seq,
          role,
          content,
          token_count,
          occurred_at,
          metadata_json,
          idempotency_key,
          idempotency_digest
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        event.id,
        conversationId,
        event.sequence,
        event.role,
        event.content,
        event.tokenCount.value,
        event.occurredAt.toISOString(),
        stringifySqliteJson(event.metadata),
        idempotencyKey,
        idempotencyDigest,
      );
  }

  private getScopedMessageIds(scope: SummaryNodeId | null): Set<string> | null {
    if (scope === null) {
      return null;
    }

    const rows = this.db
      .prepare(
        `WITH RECURSIVE scoped_summaries(summary_id) AS (
          SELECT ?

          UNION

          SELECT spe.parent_summary_id
          FROM summary_parent_edges spe
          JOIN scoped_summaries ss ON spe.summary_id = ss.summary_id
        )
        SELECT sme.message_id
        FROM summary_message_edges sme
        JOIN scoped_summaries ss ON ss.summary_id = sme.summary_id`,
      )
      .all(scope) as unknown as ScopedMessageRow[];

    return new Set(rows.map((row) => row.message_id));
  }

  private getSummaryMessageIds(summaryId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT message_id
         FROM summary_message_edges
         WHERE summary_id = ?
         ORDER BY ord ASC, message_id ASC`,
      )
      .all(summaryId) as unknown as ScopedMessageRow[];

    return rows.map((row) => row.message_id);
  }

  private getParentSummaryIds(summaryId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT parent_summary_id
         FROM summary_parent_edges
         WHERE summary_id = ?
         ORDER BY ord ASC, parent_summary_id ASC`,
      )
      .all(summaryId) as unknown as ParentSummaryEdgeRow[];

    return rows.map((row) => row.parent_summary_id);
  }

  private getActiveMessageCoverage(conversationId: ConversationId): Map<string, SummaryNodeId> {
    const activeSummaries = this.db
      .prepare(
        `SELECT summary_id, position
         FROM context_items
         WHERE conversation_id = ?
           AND summary_id IS NOT NULL
         ORDER BY position ASC, summary_id ASC`,
      )
      .all(conversationId) as unknown as ActiveSummaryRow[];
    const coverage = new Map<string, SummaryNodeId>();

    for (const activeSummary of activeSummaries) {
      const coveringSummaryId = createSummaryNodeId(activeSummary.summary_id);
      const pending = [activeSummary.summary_id];
      const visited = new Set<string>();

      while (pending.length > 0) {
        const sourceSummaryId = pending.shift()!;
        if (visited.has(sourceSummaryId)) {
          continue;
        }

        visited.add(sourceSummaryId);

        for (const messageId of this.getSummaryMessageIds(sourceSummaryId)) {
          if (!coverage.has(messageId)) {
            coverage.set(messageId, coveringSummaryId);
          }
        }

        pending.push(...this.getParentSummaryIds(sourceSummaryId));
      }
    }

    return coverage;
  }

  async appendEvents(
    conversationId: ConversationId,
    events: readonly LedgerEvent[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    this.db.exec(`SAVEPOINT ${SQLITE_LEDGER_APPEND_SAVEPOINT}`);

    try {
      const sequenceRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence
           FROM ledger_events
           WHERE conversation_id = ?`,
        )
        .get(conversationId) as SequenceRow | undefined;

      let expectedSequence = parseSqliteInteger(
        sequenceRow?.next_sequence ?? 1,
        'ledger_events.next_sequence',
      );
      const persistedIdempotencyKeys = new Set<string>();

      for (const event of events) {
        if (event.conversationId !== conversationId) {
          throw new InvariantViolationError('LedgerEvent conversation mismatch during append.');
        }

        const idempotency = extractIdempotencyMetadata(event);

        if (idempotency.key !== null && !persistedIdempotencyKeys.has(idempotency.key)) {
          const existingRow = this.findExistingByIdempotency(conversationId, idempotency.key);
          if (existingRow !== null) {
            if (this.existingRowMatchesDigest(existingRow, idempotency.digest)) {
              persistedIdempotencyKeys.add(idempotency.key);
              continue;
            }

            throw new IdempotencyConflictError(conversationId, idempotency.key);
          }
        }

        if (event.sequence !== expectedSequence) {
          if (this.eventExists(event.id)) {
            continue;
          }

          throw new NonMonotonicSequenceError(
            `LedgerEvent sequence must be gap-free. Expected ${expectedSequence}, received ${event.sequence}.`,
          );
        }

        this.insertEvent(
          event,
          conversationId,
          idempotency.key !== null && !persistedIdempotencyKeys.has(idempotency.key)
            ? idempotency.key
            : null,
          idempotency.digest,
        );

        if (idempotency.key !== null) {
          persistedIdempotencyKeys.add(idempotency.key);
        }

        expectedSequence += 1;
      }

      this.db.exec(`RELEASE SAVEPOINT ${SQLITE_LEDGER_APPEND_SAVEPOINT}`);
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${SQLITE_LEDGER_APPEND_SAVEPOINT}`);
      this.db.exec(`RELEASE SAVEPOINT ${SQLITE_LEDGER_APPEND_SAVEPOINT}`);
      throw error;
    }
  }

  async getNextSequence(conversationId: ConversationId): Promise<SequenceNumber> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence
         FROM ledger_events
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as SequenceRow | undefined;

    return createSequenceNumber(parseSqliteInteger(row?.next_sequence ?? 1, 'next_sequence'));
  }

  async getEvents(
    conversationId: ConversationId,
    range?: SequenceRange,
  ): Promise<readonly LedgerEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, seq, role, content, token_count, occurred_at, metadata_json
         FROM ledger_events
         WHERE conversation_id = ?
           AND (? IS NULL OR seq >= ?)
           AND (? IS NULL OR seq <= ?)
         ORDER BY seq ASC`,
      )
      .all(
        conversationId,
        normalizeRangeBound(range?.start),
        normalizeRangeBound(range?.start),
        normalizeRangeBound(range?.end),
        normalizeRangeBound(range?.end),
      ) as unknown as LedgerEventRow[];

    return rows.map(toDomainEvent);
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

    const tokens = tokenizeSearchQuery(normalized);
    if (tokens.length === 0) {
      return [];
    }

    const scopedSummaryId = toScopedSummary(scope);
    const scopedMessageIds = this.getScopedMessageIds(scopedSummaryId);
    const tokenClauses = tokens
      .map(() => "LOWER(fts.content) LIKE LOWER(?) ESCAPE '\\'")
      .join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT le.id, le.conversation_id, le.seq, le.role, le.content, le.token_count, le.occurred_at, le.metadata_json
         FROM ledger_events le
         JOIN ledger_events_fts fts ON fts.rowid = le.rowid
         WHERE le.conversation_id = ?
           AND (${tokenClauses})
         ORDER BY le.seq ASC`,
      )
      .all(
        conversationId,
        ...tokens.map((token) => `%${escapeLikePattern(token)}%`),
      ) as unknown as LedgerEventRow[];

    return rows
      .filter((row) => scopedMessageIds === null || scopedMessageIds.has(row.id))
      .map(toDomainEvent);
  }

  async regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    page: RegexSearchPageInput,
  ): Promise<RegexSearchPageOutput> {
    const scopedSummaryId = toScopedSummary(page.scope);
    const scopedMessageIds = this.getScopedMessageIds(scopedSummaryId);
    const activeCoverage =
      scopedSummaryId === null ? this.getActiveMessageCoverage(conversationId) : null;
    const regex = new RegExp(pattern);
    const rows = this.db
      .prepare(
        `SELECT
          le.id,
          le.seq,
          le.content
         FROM ledger_events le
         WHERE le.conversation_id = ?
         ORDER BY le.seq ASC`,
      )
      .all(conversationId) as unknown as RegexCandidateRow[];

    const matches: LedgerReadGrepMatch[] = [];

    for (const row of rows) {
      if (scopedMessageIds !== null && !scopedMessageIds.has(row.id)) {
        continue;
      }

      const match = regex.exec(row.content);
      if (match === null || match.index === undefined) {
        continue;
      }

      matches.push({
        eventId: createEventId(row.id),
        sequence: toEventSequenceNumber(row.seq),
        excerpt: createExcerpt(row.content, match.index, match[0]?.length ?? 1),
        ...(scopedSummaryId !== null
          ? { coveringSummaryId: scopedSummaryId }
          : activeCoverage?.get(row.id) === undefined
            ? {}
            : { coveringSummaryId: activeCoverage.get(row.id)! }),
      });
    }

    return {
      matches: matches.slice(page.offset, page.offset + page.limit),
      totalMatchCount: matches.length,
    };
  }
}
