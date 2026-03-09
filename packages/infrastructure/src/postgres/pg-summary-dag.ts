import type { IntegrityCheckResult, IntegrityReport, SummaryDagPort } from '@ledgermind/application';
import {
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNode,
  createSummaryNodeId,
  createTokenCount,
  createTimestamp,
  InvalidDagEdgeError,
  InvariantViolationError,
  type ConversationId,
  type EventId,
  type EventMetadata,
  type LedgerEvent,
  type SummaryNode,
  type SummaryNodeId,
} from '@ledgermind/domain';

import { mapPgError } from './errors';
import {
  arrayEquals,
  fromSystemPromptStorageValue,
  isStoredSystemPrompt,
  toJsonObject,
  toJsonStringArray,
} from './sql';
import { toRowCount, type PgExecutor } from './types';

interface SummaryNodeRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly kind: 'leaf' | 'condensed';
  readonly content: string;
  readonly token_count: number;
  readonly artifact_ids: unknown;
  readonly created_at: string | Date;
}

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

interface ArtifactLineageRow {
  readonly summary_id: string;
  readonly expected_artifact_ids: unknown;
}

interface SummaryNodeIdentityRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly kind: 'leaf' | 'condensed';
}

interface EntityConversationRow {
  readonly id: string;
  readonly conversation_id: string;
}

interface EdgeOrdRow {
  readonly max_ord: number | string | null;
}

interface CycleCheckRow {
  readonly reaches_summary: boolean;
}

const parsePgSequence = (value: number | string, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidDagEdgeError(`Invalid ${fieldName} value from PostgreSQL row.`);
  }

  return parsed;
};

const asEventMetadata = (value: unknown): EventMetadata => {
  return Object.freeze(toJsonObject(value));
};

const toLedgerEvent = (row: LedgerEventRow): LedgerEvent => {
  const content =
    row.role === 'system' && isStoredSystemPrompt(row.content)
      ? fromSystemPromptStorageValue(row.content)
      : row.content;

  return createLedgerEvent({
    id: createEventId(row.id),
    conversationId: row.conversation_id as ConversationId,
    sequence: createSequenceNumber(parsePgSequence(row.seq, 'ledger_events.seq')),
    role: row.role,
    content,
    tokenCount: createTokenCount(row.token_count),
    occurredAt: createTimestamp(row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at)),
    metadata: asEventMetadata(row.metadata),
  });
};

const toSummaryNode = (row: SummaryNodeRow): SummaryNode => {
  return createSummaryNode({
    id: createSummaryNodeId(row.id),
    conversationId: row.conversation_id as ConversationId,
    kind: row.kind,
    content: row.content,
    tokenCount: createTokenCount(row.token_count),
    artifactIds: toJsonStringArray(row.artifact_ids).map((artifactId) => artifactId as never),
    createdAt: createTimestamp(row.created_at instanceof Date ? row.created_at : new Date(row.created_at)),
  });
};

const createCheck = (
  name: string,
  passed: boolean,
  details?: string,
  affectedIds?: readonly string[],
): IntegrityCheckResult => {
  return {
    name,
    passed,
    ...(details === undefined ? {} : { details }),
    ...(affectedIds === undefined ? {} : { affectedIds }),
  };
};

const uniqueSorted = (values: readonly string[]): string[] => {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
};

const dedupeStable = <T extends string>(values: readonly T[]): T[] => {
  const seen = new Set<T>();
  const deduped: T[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
};

const parsePgNonNegativeInt = (value: number | string, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvariantViolationError(`Invalid ${fieldName} value from PostgreSQL row.`);
  }

  return parsed;
};

export class PgSummaryDag implements SummaryDagPort {
  constructor(private readonly executor: PgExecutor) {}

  private async getSummaryNodeIdentity(summaryId: SummaryNodeId): Promise<SummaryNodeIdentityRow | null> {
    const result = await this.executor.query<SummaryNodeIdentityRow>(
      `SELECT id, conversation_id, kind
       FROM summary_nodes
       WHERE id = $1`,
      [summaryId],
    );

    return result.rows[0] ?? null;
  }

  private async getLedgerEventConversation(eventId: EventId): Promise<EntityConversationRow | null> {
    const result = await this.executor.query<EntityConversationRow>(
      `SELECT id, conversation_id
       FROM ledger_events
       WHERE id = $1`,
      [eventId],
    );

    return result.rows[0] ?? null;
  }

  private async hasLeafEdge(summaryId: SummaryNodeId, messageId: EventId): Promise<boolean> {
    const result = await this.executor.query<{ readonly exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM summary_message_edges
         WHERE summary_id = $1
           AND message_id = $2
       ) AS exists`,
      [summaryId, messageId],
    );

    return result.rows[0]?.exists === true;
  }

  private async hasCondensedEdge(summaryId: SummaryNodeId, parentSummaryId: SummaryNodeId): Promise<boolean> {
    const result = await this.executor.query<{ readonly exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM summary_parent_edges
         WHERE summary_id = $1
           AND parent_summary_id = $2
       ) AS exists`,
      [summaryId, parentSummaryId],
    );

    return result.rows[0]?.exists === true;
  }

  private async getNextLeafOrd(summaryId: SummaryNodeId): Promise<number> {
    const result = await this.executor.query<EdgeOrdRow>(
      `SELECT MAX(ord) AS max_ord
       FROM summary_message_edges
       WHERE summary_id = $1`,
      [summaryId],
    );

    const maxOrdRaw = result.rows[0]?.max_ord;
    if (maxOrdRaw === null || maxOrdRaw === undefined) {
      return 0;
    }

    return parsePgNonNegativeInt(maxOrdRaw, 'summary_message_edges.ord') + 1;
  }

  private async getNextCondensedOrd(summaryId: SummaryNodeId): Promise<number> {
    const result = await this.executor.query<EdgeOrdRow>(
      `SELECT MAX(ord) AS max_ord
       FROM summary_parent_edges
       WHERE summary_id = $1`,
      [summaryId],
    );

    const maxOrdRaw = result.rows[0]?.max_ord;
    if (maxOrdRaw === null || maxOrdRaw === undefined) {
      return 0;
    }

    return parsePgNonNegativeInt(maxOrdRaw, 'summary_parent_edges.ord') + 1;
  }

  private async assertCondensedEdgeNoCycle(summaryId: SummaryNodeId, parentSummaryId: SummaryNodeId): Promise<void> {
    if (summaryId === parentSummaryId) {
      throw new InvalidDagEdgeError('Summary DAG edge cannot reference itself.');
    }

    const result = await this.executor.query<CycleCheckRow>(
      `WITH RECURSIVE walk(id, path) AS (
         SELECT $1::text AS id, ARRAY[$1::text] AS path

         UNION ALL

         SELECT spe.parent_summary_id, walk.path || spe.parent_summary_id
         FROM summary_parent_edges spe
         JOIN walk ON spe.summary_id = walk.id
         WHERE NOT spe.parent_summary_id = ANY(walk.path)
       )
       SELECT EXISTS (
         SELECT 1
         FROM walk
         WHERE id = $2::text
       ) AS reaches_summary`,
      [parentSummaryId, summaryId],
    );

    if (result.rows[0]?.reaches_summary === true) {
      throw new InvalidDagEdgeError('Adding condensed edge would create a cycle.');
    }
  }

  async createNode(node: SummaryNode): Promise<void> {
    try {
      await this.executor.query(
        `INSERT INTO summary_nodes (
          id,
          conversation_id,
          kind,
          content,
          token_count,
          artifact_ids,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (id) DO NOTHING`,
        [
          node.id,
          node.conversationId,
          node.kind,
          node.content,
          node.tokenCount.value,
          JSON.stringify([...node.artifactIds]),
          node.createdAt,
        ],
      );
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getNode(id: SummaryNodeId): Promise<SummaryNode | null> {
    try {
      const result = await this.executor.query<SummaryNodeRow>(
        `SELECT id, conversation_id, kind, content, token_count, artifact_ids, created_at
         FROM summary_nodes
         WHERE id = $1`,
        [id],
      );

      const row = result.rows[0];
      return row ? toSummaryNode(row) : null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  async addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void> {
    const dedupedMessageIds = dedupeStable(messageIds);
    if (dedupedMessageIds.length === 0) {
      return;
    }

    try {
      const summary = await this.getSummaryNodeIdentity(summaryId);
      if (!summary) {
        throw new InvariantViolationError('Cannot add leaf edges for unknown summary node.');
      }

      if (summary.kind !== 'leaf') {
        throw new InvariantViolationError('Leaf edges can only be added to leaf summary nodes.');
      }

      let nextOrd = await this.getNextLeafOrd(summaryId);

      for (const messageId of dedupedMessageIds) {
        const message = await this.getLedgerEventConversation(messageId);
        if (!message) {
          throw new InvariantViolationError('Cannot add leaf edge for unknown ledger event.');
        }

        if (message.conversation_id !== summary.conversation_id) {
          throw new InvariantViolationError('Leaf edge message conversation must match summary conversation.');
        }

        const alreadyExists = await this.hasLeafEdge(summaryId, messageId);
        if (alreadyExists) {
          continue;
        }

        await this.executor.query(
          `INSERT INTO summary_message_edges (summary_id, message_id, ord)
           VALUES ($1, $2, $3)`,
          [summaryId, messageId, nextOrd],
        );

        nextOrd += 1;
      }
    } catch (error) {
      if (error instanceof InvariantViolationError || error instanceof InvalidDagEdgeError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async addCondensedEdges(summaryId: SummaryNodeId, parentSummaryIds: readonly SummaryNodeId[]): Promise<void> {
    const dedupedParentSummaryIds = dedupeStable(parentSummaryIds);
    if (dedupedParentSummaryIds.length === 0) {
      return;
    }

    try {
      const summary = await this.getSummaryNodeIdentity(summaryId);
      if (!summary) {
        throw new InvariantViolationError('Cannot add condensed edges for unknown summary node.');
      }

      if (summary.kind !== 'condensed') {
        throw new InvariantViolationError('Condensed edges can only be added to condensed summary nodes.');
      }

      let nextOrd = await this.getNextCondensedOrd(summaryId);

      for (const parentSummaryId of dedupedParentSummaryIds) {
        const parentSummary = await this.getSummaryNodeIdentity(parentSummaryId);
        if (!parentSummary) {
          throw new InvariantViolationError('Cannot add condensed edge for unknown parent summary node.');
        }

        if (parentSummary.conversation_id !== summary.conversation_id) {
          throw new InvariantViolationError(
            'Condensed edge parent summary conversation must match summary conversation.',
          );
        }

        await this.assertCondensedEdgeNoCycle(summaryId, parentSummaryId);

        const alreadyExists = await this.hasCondensedEdge(summaryId, parentSummaryId);
        if (alreadyExists) {
          continue;
        }

        await this.executor.query(
          `INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
           VALUES ($1, $2, $3)`,
          [summaryId, parentSummaryId, nextOrd],
        );

        nextOrd += 1;
      }
    } catch (error) {
      if (error instanceof InvariantViolationError || error instanceof InvalidDagEdgeError) {
        throw error;
      }

      return mapPgError(error);
    }
  }

  async getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]> {
    const result = await this.executor.query<{ readonly parent_summary_id: SummaryNodeId }>(
      `SELECT parent_summary_id
       FROM summary_parent_edges
       WHERE summary_id = $1
       ORDER BY ord`,
      [summaryId],
    );

    return result.rows.map((row) => row.parent_summary_id);
  }

  async expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]> {
    try {
      const result = await this.executor.query<LedgerEventRow>(
        `WITH RECURSIVE summary_scope(id, path) AS (
          SELECT sn.id, ARRAY[sn.id] AS path
          FROM summary_nodes sn
          WHERE sn.id = $1

          UNION ALL

          SELECT spe.parent_summary_id, summary_scope.path || spe.parent_summary_id
          FROM summary_parent_edges spe
          JOIN summary_scope ON spe.summary_id = summary_scope.id
          WHERE NOT spe.parent_summary_id = ANY(summary_scope.path)
        )
        SELECT DISTINCT
          le.id,
          le.conversation_id,
          le.seq,
          le.role,
          le.content,
          le.token_count,
          le.occurred_at,
          le.metadata
        FROM summary_scope
        JOIN summary_message_edges sme ON sme.summary_id = summary_scope.id
        JOIN ledger_events le ON le.id = sme.message_id
        ORDER BY le.seq ASC`,
        [summaryId],
      );

      return result.rows.map(toLedgerEvent);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async searchSummaries(
    conversationId: ConversationId,
    query: string,
  ): Promise<readonly SummaryNode[]> {
    const normalized = query.trim();
    if (normalized.length === 0) {
      return [];
    }

    try {
      const result = await this.executor.query<SummaryNodeRow>(
        `SELECT id, conversation_id, kind, content, token_count, artifact_ids, created_at
         FROM summary_nodes
         WHERE conversation_id = $1
           AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)
         ORDER BY created_at ASC`,
        [conversationId, normalized],
      );

      return result.rows.map(toSummaryNode);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport> {
    try {
      const checks: IntegrityCheckResult[] = [];

      // 1) no_orphan_edges
      const orphanEdgesResult = await this.executor.query<{ readonly issue: string }>(
        `SELECT CONCAT('leaf:', sme.summary_id, '->message:', sme.message_id) AS issue
         FROM summary_message_edges sme
         JOIN summary_nodes sn ON sn.id = sme.summary_id
         LEFT JOIN ledger_events le ON le.id = sme.message_id
         WHERE sn.conversation_id = $1
           AND le.id IS NULL

         UNION ALL

         SELECT CONCAT('condensed:', spe.summary_id, '->parent:', spe.parent_summary_id) AS issue
         FROM summary_parent_edges spe
         JOIN summary_nodes sn ON sn.id = spe.summary_id
         LEFT JOIN summary_nodes parent ON parent.id = spe.parent_summary_id
         WHERE sn.conversation_id = $1
           AND parent.id IS NULL`,
        [conversationId],
      );

      checks.push(
        createCheck(
          'no_orphan_edges',
          toRowCount(orphanEdgesResult.rowCount) === 0,
          toRowCount(orphanEdgesResult.rowCount) === 0
            ? undefined
            : 'Found edges pointing to missing message/summary nodes.',
          orphanEdgesResult.rows.map((row) => row.issue),
        ),
      );

      // 2) no_orphan_context_refs
      const orphanContextResult = await this.executor.query<{ readonly issue: string }>(
        `SELECT CONCAT('position:', ci.position, ':message:', ci.message_id) AS issue
         FROM context_items ci
         LEFT JOIN ledger_events le ON le.id = ci.message_id
         WHERE ci.conversation_id = $1
           AND ci.message_id IS NOT NULL
           AND le.id IS NULL

         UNION ALL

         SELECT CONCAT('position:', ci.position, ':summary:', ci.summary_id) AS issue
         FROM context_items ci
         LEFT JOIN summary_nodes sn ON sn.id = ci.summary_id
         WHERE ci.conversation_id = $1
           AND ci.summary_id IS NOT NULL
           AND sn.id IS NULL`,
        [conversationId],
      );

      checks.push(
        createCheck(
          'no_orphan_context_refs',
          toRowCount(orphanContextResult.rowCount) === 0,
          toRowCount(orphanContextResult.rowCount) === 0
            ? undefined
            : 'Found context items pointing to missing messages or summaries.',
          orphanContextResult.rows.map((row) => row.issue),
        ),
      );

      // 3) acyclic_dag
      const cyclesResult = await this.executor.query<{ readonly summary_id: string }>(
        `WITH RECURSIVE walk(start_id, current_id, path, cycle) AS (
          SELECT sp.summary_id, sp.parent_summary_id, ARRAY[sp.summary_id], FALSE
          FROM summary_parent_edges sp
          JOIN summary_nodes sn ON sn.id = sp.summary_id
          WHERE sn.conversation_id = $1

          UNION ALL

          SELECT walk.start_id,
                 sp.parent_summary_id,
                 path || sp.summary_id,
                 sp.parent_summary_id = ANY(path)
          FROM walk
          JOIN summary_parent_edges sp ON sp.summary_id = walk.current_id
          WHERE walk.cycle = FALSE
        )
        SELECT DISTINCT start_id AS summary_id
        FROM walk
        WHERE cycle = TRUE`,
        [conversationId],
      );

      checks.push(
        createCheck(
          'acyclic_dag',
          toRowCount(cyclesResult.rowCount) === 0,
          toRowCount(cyclesResult.rowCount) === 0
            ? undefined
            : 'Cycle detected in condensed summary parent edges.',
          cyclesResult.rows.map((row) => row.summary_id),
        ),
      );

      // 4) leaf_coverage
      const leafCoverageResult = await this.executor.query<{ readonly summary_id: string }>(
        `SELECT sn.id AS summary_id
         FROM summary_nodes sn
         LEFT JOIN summary_message_edges sme ON sme.summary_id = sn.id
         WHERE sn.conversation_id = $1
           AND sn.kind = 'leaf'
         GROUP BY sn.id
         HAVING COUNT(sme.message_id) = 0`,
        [conversationId],
      );

      checks.push(
        createCheck(
          'leaf_coverage',
          toRowCount(leafCoverageResult.rowCount) === 0,
          toRowCount(leafCoverageResult.rowCount) === 0
            ? undefined
            : 'Leaf summaries without message coverage were found.',
          leafCoverageResult.rows.map((row) => row.summary_id),
        ),
      );

      // 5) condensed_coverage
      const condensedCoverageResult = await this.executor.query<{ readonly summary_id: string }>(
        `SELECT sn.id AS summary_id
         FROM summary_nodes sn
         LEFT JOIN summary_parent_edges spe ON spe.summary_id = sn.id
         WHERE sn.conversation_id = $1
           AND sn.kind = 'condensed'
         GROUP BY sn.id
         HAVING COUNT(spe.parent_summary_id) = 0`,
        [conversationId],
      );

      checks.push(
        createCheck(
          'condensed_coverage',
          toRowCount(condensedCoverageResult.rowCount) === 0,
          toRowCount(condensedCoverageResult.rowCount) === 0
            ? undefined
            : 'Condensed summaries without parent coverage were found.',
          condensedCoverageResult.rows.map((row) => row.summary_id),
        ),
      );

      // 6) contiguous_positions
      const positionsResult = await this.executor.query<{ readonly position: number }>(
        `SELECT position
         FROM context_items
         WHERE conversation_id = $1
         ORDER BY position ASC`,
        [conversationId],
      );

      const contiguousIssues: string[] = [];
      for (const [index, row] of positionsResult.rows.entries()) {
        if (row.position !== index) {
          contiguousIssues.push(`expected:${index},actual:${row.position}`);
        }
      }

      checks.push(
        createCheck(
          'contiguous_positions',
          contiguousIssues.length === 0,
          contiguousIssues.length === 0 ? undefined : 'Context positions are not contiguous from 0..N-1.',
          contiguousIssues.length === 0 ? undefined : contiguousIssues,
        ),
      );

      // 7) monotonic_sequence
      const sequenceResult = await this.executor.query<{ readonly id: string; readonly seq: number | string }>(
        `SELECT id, seq
         FROM ledger_events
         WHERE conversation_id = $1
         ORDER BY seq ASC`,
        [conversationId],
      );

      const sequenceIssues: string[] = [];
      for (const [index, row] of sequenceResult.rows.entries()) {
        const expected = index + 1;
        const actual = parsePgSequence(row.seq, 'ledger_events.seq');
        if (actual !== expected) {
          sequenceIssues.push(`${row.id}:expected:${expected},actual:${actual}`);
        }
      }

      checks.push(
        createCheck(
          'monotonic_sequence',
          sequenceIssues.length === 0,
          sequenceIssues.length === 0
            ? undefined
            : 'Ledger sequences are not strictly monotonic and gap-free.',
          sequenceIssues.length === 0 ? undefined : sequenceIssues,
        ),
      );

      // 8) artifact_propagation
      const lineageResult = await this.executor.query<ArtifactLineageRow>(
        `WITH RECURSIVE lineage(summary_id, source_summary_id, path) AS (
          SELECT sn.id, sn.id, ARRAY[sn.id]::text[]
          FROM summary_nodes sn
          WHERE sn.conversation_id = $1

          UNION ALL

          SELECT
            lineage.summary_id,
            spe.parent_summary_id,
            lineage.path || spe.parent_summary_id
          FROM lineage
          JOIN summary_parent_edges spe ON spe.summary_id = lineage.source_summary_id
          JOIN summary_nodes parent ON parent.id = spe.parent_summary_id
          WHERE parent.conversation_id = $1
            AND NOT spe.parent_summary_id = ANY(lineage.path)
        ),
        expected AS (
          SELECT
            lineage.summary_id,
            COALESCE(
              jsonb_agg(DISTINCT artifact_id) FILTER (WHERE artifact_id IS NOT NULL),
              '[]'::jsonb
            ) AS expected_artifact_ids
          FROM lineage
          LEFT JOIN summary_nodes source ON source.id = lineage.source_summary_id
          LEFT JOIN summary_message_edges sme ON sme.summary_id = source.id
          LEFT JOIN ledger_events le ON le.id = sme.message_id
          LEFT JOIN LATERAL (
            SELECT value::text AS artifact_id
            FROM jsonb_array_elements_text(COALESCE(le.metadata->'artifactIds', '[]'::jsonb))
            UNION
            SELECT value::text AS artifact_id
            FROM jsonb_array_elements_text(COALESCE(le.metadata->'artifact_ids', '[]'::jsonb))
            UNION
            SELECT (le.metadata->>'artifactId') AS artifact_id
            UNION
            SELECT (le.metadata->>'artifact_id') AS artifact_id
          ) artifact_ids ON TRUE
          GROUP BY lineage.summary_id
        )
        SELECT e.summary_id, e.expected_artifact_ids
        FROM expected e`,
        [conversationId],
      );

      const artifactIssues: string[] = [];
      for (const row of lineageResult.rows) {
        const nodeResult = await this.executor.query<SummaryNodeRow>(
          `SELECT id, conversation_id, kind, content, token_count, artifact_ids, created_at
           FROM summary_nodes
           WHERE id = $1`,
          [row.summary_id],
        );

        const node = nodeResult.rows[0];
        if (!node) {
          continue;
        }

        const expectedArtifactIds = uniqueSorted(toJsonStringArray(row.expected_artifact_ids));
        const actualArtifactIds = uniqueSorted(toJsonStringArray(node.artifact_ids));

        if (!arrayEquals(expectedArtifactIds, actualArtifactIds)) {
          const missing = expectedArtifactIds.filter((artifactId) => !actualArtifactIds.includes(artifactId));
          if (missing.length > 0) {
            artifactIssues.push(`${node.id}:missing:${missing.join(',')}`);
          }
        }
      }

      checks.push(
        createCheck(
          'artifact_propagation',
          artifactIssues.length === 0,
          artifactIssues.length === 0
            ? undefined
            : 'Summary artifact_ids are missing IDs required by message/parent lineage.',
          artifactIssues.length === 0 ? undefined : artifactIssues,
        ),
      );

      return {
        passed: checks.every((check) => check.passed),
        checks,
      };
    } catch (error) {
      return mapPgError(error);
    }
  }
}
