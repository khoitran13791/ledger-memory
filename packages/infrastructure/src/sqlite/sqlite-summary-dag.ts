import type {
  IntegrityCheckResult,
  IntegrityReport,
  SummaryDagPort,
} from '@ledgermind/application';
import {
  createArtifactId,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  InvalidDagEdgeError,
  InvariantViolationError,
  type ArtifactId,
  type ConversationId,
  type EventId,
  type EventMetadata,
  type LedgerEvent,
  type SummaryNode,
  type SummaryNodeId,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import {
  parseSqliteInteger,
  parseSqliteJsonArray,
  parseSqliteJsonObject,
  stringifySqliteJson,
} from './sqlite-json';

interface SummaryNodeRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly kind: 'leaf' | 'condensed';
  readonly content: string;
  readonly retrieval_text: string;
  readonly token_count: unknown;
  readonly artifact_ids_json: unknown;
  readonly created_at: string;
}

interface SummaryNodeIdentityRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly kind: 'leaf' | 'condensed';
}

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

interface EntityConversationRow {
  readonly id: string;
  readonly conversation_id: string;
}

interface EdgeOrdRow {
  readonly ord: unknown;
}

interface MaxOrdRow {
  readonly max_ord: unknown;
}

interface IssueRow {
  readonly issue: string;
}

interface SummaryIdRow {
  readonly summary_id: string;
}

interface ParentSummaryRow {
  readonly parent_summary_id: string;
}

interface MessageIdRow {
  readonly message_id: string;
}

interface PositionRow {
  readonly position: unknown;
}

interface SequenceRow {
  readonly id: string;
  readonly seq: unknown;
}

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

const uniqueSorted = (values: readonly string[]): string[] => {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
};

const arrayEquals = (left: readonly string[], right: readonly string[]): boolean => {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

const scoreTokenOverlap = (content: string, tokens: readonly string[]): number => {
  const contentTokens = new Set(tokenizeSearchQuery(content));
  let score = 0;

  for (const token of tokens) {
    if (contentTokens.has(token)) {
      score += 1;
      continue;
    }

    if (content.toLocaleLowerCase().includes(token)) {
      score += 1;
    }
  }

  return score;
};

const toArtifactIds = (value: unknown): readonly ArtifactId[] => {
  return parseSqliteJsonArray(value)
    .filter((artifactId): artifactId is string => typeof artifactId === 'string')
    .map((artifactId) => createArtifactId(artifactId));
};

const toSummaryNode = (row: SummaryNodeRow): SummaryNode => {
  return createSummaryNode({
    id: createSummaryNodeId(row.id),
    conversationId: row.conversation_id as ConversationId,
    kind: row.kind,
    content: row.content,
    retrievalText: row.retrieval_text,
    tokenCount: createTokenCount(parseSqliteInteger(row.token_count, 'summary_nodes.token_count')),
    artifactIds: toArtifactIds(row.artifact_ids_json),
    createdAt: createTimestamp(new Date(row.created_at)),
  });
};

const toEventMetadata = (value: unknown): EventMetadata => {
  return Object.freeze(parseSqliteJsonObject(value));
};

const toLedgerEvent = (row: LedgerEventRow): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(row.id),
    conversationId: row.conversation_id as ConversationId,
    sequence: createSequenceNumber(parseSqliteInteger(row.seq, 'ledger_events.seq')),
    role: row.role,
    content: row.content,
    tokenCount: createTokenCount(parseSqliteInteger(row.token_count, 'ledger_events.token_count')),
    occurredAt: createTimestamp(new Date(row.occurred_at)),
    metadata: toEventMetadata(row.metadata_json),
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

const addFromUnknown = (target: Set<string>, value: unknown): void => {
  if (typeof value === 'string' && value.trim().length > 0) {
    target.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addFromUnknown(target, item);
    }
    return;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    addFromUnknown(target, (value as { readonly id?: unknown }).id);
  }
};

const extractArtifactIdsFromMetadata = (metadata: EventMetadata): Set<string> => {
  const result = new Set<string>();

  addFromUnknown(result, metadata['artifactIds']);
  addFromUnknown(result, metadata['artifact_ids']);
  addFromUnknown(result, metadata['artifactId']);
  addFromUnknown(result, metadata['artifact_id']);
  addFromUnknown(result, metadata['artifacts']);

  return result;
};

export class SqliteSummaryDag implements SummaryDagPort {
  constructor(private readonly db: DatabaseSync) {}

  private getSummaryNodeIdentity(summaryId: SummaryNodeId): SummaryNodeIdentityRow | null {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, kind
         FROM summary_nodes
         WHERE id = ?`,
      )
      .get(summaryId) as SummaryNodeIdentityRow | undefined;

    return row ?? null;
  }

  private getLedgerEventConversation(eventId: EventId): EntityConversationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id
         FROM ledger_events
         WHERE id = ?`,
      )
      .get(eventId) as EntityConversationRow | undefined;

    return row ?? null;
  }

  private hasLeafEdge(summaryId: SummaryNodeId, messageId: EventId): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS id
         FROM summary_message_edges
         WHERE summary_id = ?
           AND message_id = ?
         LIMIT 1`,
      )
      .get(summaryId, messageId) as { readonly id: number } | undefined;

    return row !== undefined;
  }

  private hasCondensedEdge(summaryId: SummaryNodeId, parentSummaryId: SummaryNodeId): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS id
         FROM summary_parent_edges
         WHERE summary_id = ?
           AND parent_summary_id = ?
         LIMIT 1`,
      )
      .get(summaryId, parentSummaryId) as { readonly id: number } | undefined;

    return row !== undefined;
  }

  private getNextLeafOrd(summaryId: SummaryNodeId): number {
    const row = this.db
      .prepare(
        `SELECT MAX(ord) AS max_ord
         FROM summary_message_edges
         WHERE summary_id = ?`,
      )
      .get(summaryId) as MaxOrdRow | undefined;

    if (row?.max_ord === null || row?.max_ord === undefined) {
      return 0;
    }

    return parseSqliteInteger(row.max_ord, 'summary_message_edges.ord') + 1;
  }

  private getNextCondensedOrd(summaryId: SummaryNodeId): number {
    const row = this.db
      .prepare(
        `SELECT MAX(ord) AS max_ord
         FROM summary_parent_edges
         WHERE summary_id = ?`,
      )
      .get(summaryId) as MaxOrdRow | undefined;

    if (row?.max_ord === null || row?.max_ord === undefined) {
      return 0;
    }

    return parseSqliteInteger(row.max_ord, 'summary_parent_edges.ord') + 1;
  }

  private assertOrdersContiguous(
    tableName: 'summary_message_edges' | 'summary_parent_edges',
    summaryId: SummaryNodeId,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT ord
         FROM ${tableName}
         WHERE summary_id = ?
         ORDER BY ord ASC`,
      )
      .all(summaryId) as unknown as EdgeOrdRow[];

    for (const [index, row] of rows.entries()) {
      const actual = parseSqliteInteger(row.ord, `${tableName}.ord`);
      if (actual !== index) {
        throw new InvalidDagEdgeError('DagEdge orders must be contiguous and start at zero.');
      }
    }
  }

  private getParentSummaryIdStrings(summaryId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT parent_summary_id
         FROM summary_parent_edges
         WHERE summary_id = ?
         ORDER BY ord ASC, parent_summary_id ASC`,
      )
      .all(summaryId) as unknown as ParentSummaryRow[];

    return rows.map((row) => row.parent_summary_id);
  }

  private getLeafMessageIdStrings(summaryId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT message_id
         FROM summary_message_edges
         WHERE summary_id = ?
         ORDER BY ord ASC, message_id ASC`,
      )
      .all(summaryId) as unknown as MessageIdRow[];

    return rows.map((row) => row.message_id);
  }

  private assertCondensedEdgeNoCycle(
    summaryId: SummaryNodeId,
    parentSummaryId: SummaryNodeId,
  ): void {
    if (summaryId === parentSummaryId) {
      throw new InvalidDagEdgeError('Summary DAG edge cannot reference itself.');
    }

    const visited = new Set<string>();
    const reachesTarget = (from: string): boolean => {
      if (from === summaryId) {
        return true;
      }

      if (visited.has(from)) {
        return false;
      }

      visited.add(from);

      for (const parent of this.getParentSummaryIdStrings(from)) {
        if (reachesTarget(parent)) {
          return true;
        }
      }

      return false;
    };

    if (reachesTarget(parentSummaryId)) {
      throw new InvalidDagEdgeError('Adding condensed edge would create a cycle.');
    }
  }

  private collectScopedSummaryIds(scope: SummaryNodeId): Set<string> {
    const scoped = new Set<string>();
    const pending: string[] = [scope];

    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined || scoped.has(current)) {
        continue;
      }

      scoped.add(current);
      pending.push(...this.getParentSummaryIdStrings(current));
    }

    return scoped;
  }

  private computeExpectedArtifactIds(
    summaryId: string,
    memo: Map<string, Set<string>>,
    inPath: Set<string>,
  ): Set<string> {
    const cached = memo.get(summaryId);
    if (cached) {
      return new Set(cached);
    }

    if (inPath.has(summaryId)) {
      return new Set();
    }

    inPath.add(summaryId);

    const node = this.getSummaryNodeIdentity(createSummaryNodeId(summaryId));
    const expected = new Set<string>();

    if (node?.kind === 'leaf') {
      const messageIds = this.getLeafMessageIdStrings(summaryId);
      for (const messageId of messageIds) {
        const row = this.db
          .prepare(
            `SELECT metadata_json
             FROM ledger_events
             WHERE id = ?`,
          )
          .get(messageId) as Pick<LedgerEventRow, 'metadata_json'> | undefined;

        if (row === undefined) {
          continue;
        }

        for (const artifactId of extractArtifactIdsFromMetadata(
          toEventMetadata(row.metadata_json),
        )) {
          expected.add(artifactId);
        }
      }
    } else if (node?.kind === 'condensed') {
      for (const parentSummaryId of this.getParentSummaryIdStrings(summaryId)) {
        const parentExpected = this.computeExpectedArtifactIds(parentSummaryId, memo, inPath);
        for (const artifactId of parentExpected) {
          expected.add(artifactId);
        }
      }
    }

    inPath.delete(summaryId);
    memo.set(summaryId, new Set(expected));
    return expected;
  }

  async createNode(node: SummaryNode): Promise<void> {
    this.db
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        node.id,
        node.conversationId,
        node.kind,
        node.content,
        node.retrievalText,
        node.tokenCount.value,
        stringifySqliteJson([...node.artifactIds]),
        node.createdAt.toISOString(),
      );
  }

  async getNode(id: SummaryNodeId): Promise<SummaryNode | null> {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, kind, content, retrieval_text, token_count, artifact_ids_json, created_at
         FROM summary_nodes
         WHERE id = ?`,
      )
      .get(id) as SummaryNodeRow | undefined;

    return row === undefined ? null : toSummaryNode(row);
  }

  async addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void> {
    const dedupedMessageIds = dedupeStable(messageIds);
    if (dedupedMessageIds.length === 0) {
      return;
    }

    const summary = this.getSummaryNodeIdentity(summaryId);
    if (!summary) {
      throw new InvariantViolationError('Cannot add leaf edges for unknown summary node.');
    }

    if (summary.kind !== 'leaf') {
      throw new InvariantViolationError('Leaf edges can only be added to leaf summary nodes.');
    }

    this.assertOrdersContiguous('summary_message_edges', summaryId);
    let nextOrd = this.getNextLeafOrd(summaryId);

    for (const messageId of dedupedMessageIds) {
      const message = this.getLedgerEventConversation(messageId);
      if (!message) {
        throw new InvariantViolationError('Cannot add leaf edge for unknown ledger event.');
      }

      if (message.conversation_id !== summary.conversation_id) {
        throw new InvariantViolationError(
          'Leaf edge message conversation must match summary conversation.',
        );
      }

      if (this.hasLeafEdge(summaryId, messageId)) {
        continue;
      }

      this.db
        .prepare(
          `INSERT INTO summary_message_edges (summary_id, message_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(summaryId, messageId, nextOrd);

      nextOrd += 1;
    }
  }

  async addCondensedEdges(
    summaryId: SummaryNodeId,
    parentSummaryIds: readonly SummaryNodeId[],
  ): Promise<void> {
    const dedupedParentSummaryIds = dedupeStable(parentSummaryIds);
    if (dedupedParentSummaryIds.length === 0) {
      return;
    }

    const summary = this.getSummaryNodeIdentity(summaryId);
    if (!summary) {
      throw new InvariantViolationError('Cannot add condensed edges for unknown summary node.');
    }

    if (summary.kind !== 'condensed') {
      throw new InvariantViolationError(
        'Condensed edges can only be added to condensed summary nodes.',
      );
    }

    this.assertOrdersContiguous('summary_parent_edges', summaryId);
    let nextOrd = this.getNextCondensedOrd(summaryId);

    for (const parentSummaryId of dedupedParentSummaryIds) {
      const parentSummary = this.getSummaryNodeIdentity(parentSummaryId);
      if (!parentSummary) {
        throw new InvariantViolationError(
          'Cannot add condensed edge for unknown parent summary node.',
        );
      }

      if (parentSummary.conversation_id !== summary.conversation_id) {
        throw new InvariantViolationError(
          'Condensed edge parent summary conversation must match summary conversation.',
        );
      }

      this.assertCondensedEdgeNoCycle(summaryId, parentSummaryId);

      if (this.hasCondensedEdge(summaryId, parentSummaryId)) {
        continue;
      }

      this.db
        .prepare(
          `INSERT INTO summary_parent_edges (summary_id, parent_summary_id, ord)
           VALUES (?, ?, ?)`,
        )
        .run(summaryId, parentSummaryId, nextOrd);

      nextOrd += 1;
    }
  }

  async getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]> {
    return this.getParentSummaryIdStrings(summaryId).map((parentSummaryId) =>
      createSummaryNodeId(parentSummaryId),
    );
  }

  async expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]> {
    if (this.getSummaryNodeIdentity(summaryId) === null) {
      return [];
    }

    const visited = new Set<string>();
    const inPath = new Set<string>();
    const messageIds = new Set<string>();

    const visit = (currentSummaryId: string): void => {
      if (inPath.has(currentSummaryId)) {
        throw new InvalidDagEdgeError('Cycle detected while expanding summary DAG.');
      }

      if (visited.has(currentSummaryId)) {
        return;
      }

      inPath.add(currentSummaryId);

      for (const messageId of this.getLeafMessageIdStrings(currentSummaryId)) {
        messageIds.add(messageId);
      }

      for (const parentSummaryId of this.getParentSummaryIdStrings(currentSummaryId)) {
        visit(parentSummaryId);
      }

      inPath.delete(currentSummaryId);
      visited.add(currentSummaryId);
    };

    visit(summaryId);

    if (messageIds.size === 0) {
      return [];
    }

    const placeholders = [...messageIds].map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, seq, role, content, token_count, occurred_at, metadata_json
         FROM ledger_events
         WHERE id IN (${placeholders})
         ORDER BY seq ASC`,
      )
      .all(...messageIds) as unknown as LedgerEventRow[];

    return rows.map(toLedgerEvent);
  }

  async searchSummaries(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly SummaryNode[]> {
    const normalized = query.trim();
    if (normalized.length === 0) {
      return [];
    }

    const tokens = tokenizeSearchQuery(normalized);
    if (tokens.length === 0) {
      return [];
    }

    const scopedIds = scope === undefined ? null : this.collectScopedSummaryIds(scope);
    if (scopedIds !== null && scopedIds.size === 0) {
      return [];
    }

    const tokenClauses = tokens
      .map(() => "LOWER(fts.retrieval_text) LIKE LOWER(?) ESCAPE '\\'")
      .join(' OR ');
    const mirrorRows = this.db
      .prepare(
        `SELECT sn.id, sn.conversation_id, sn.kind, sn.content, sn.retrieval_text, sn.token_count, sn.artifact_ids_json, sn.created_at
         FROM summary_nodes sn
         JOIN summary_nodes_fts fts ON fts.rowid = sn.rowid
         WHERE sn.conversation_id = ?
           AND (${tokenClauses})
         ORDER BY sn.created_at ASC, sn.id ASC`,
      )
      .all(
        conversationId,
        ...tokens.map((token) => `%${escapeLikePattern(token)}%`),
      ) as unknown as SummaryNodeRow[];

    const candidateRows = [...mirrorRows];
    const candidateIds = new Set(candidateRows.map((row) => row.id));
    const fallbackRows = (
      this.db
        .prepare(
          `SELECT id, conversation_id, kind, content, retrieval_text, token_count, artifact_ids_json, created_at
           FROM summary_nodes
           WHERE conversation_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(conversationId) as unknown as SummaryNodeRow[]
    ).filter(
      (row) => !candidateIds.has(row.id) && scoreTokenOverlap(row.retrieval_text, tokens) > 0,
    );

    candidateRows.push(...fallbackRows);

    return candidateRows
      .filter((row) => scopedIds === null || scopedIds.has(row.id))
      .map(toSummaryNode);
  }

  async checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport> {
    const checks: IntegrityCheckResult[] = [];

    const orphanEdges = this.db
      .prepare(
        `SELECT 'leaf:' || sme.summary_id || '->message:' || sme.message_id AS issue
         FROM summary_message_edges sme
         JOIN summary_nodes sn ON sn.id = sme.summary_id
         LEFT JOIN ledger_events le ON le.id = sme.message_id
         WHERE sn.conversation_id = ?
           AND le.id IS NULL

         UNION ALL

         SELECT 'condensed:' || spe.summary_id || '->parent:' || spe.parent_summary_id AS issue
         FROM summary_parent_edges spe
         JOIN summary_nodes sn ON sn.id = spe.summary_id
         LEFT JOIN summary_nodes parent ON parent.id = spe.parent_summary_id
         WHERE sn.conversation_id = ?
           AND parent.id IS NULL`,
      )
      .all(conversationId, conversationId) as unknown as IssueRow[];

    checks.push(
      createCheck(
        'no_orphan_edges',
        orphanEdges.length === 0,
        orphanEdges.length === 0
          ? undefined
          : 'Found edges pointing to missing message/summary nodes.',
        orphanEdges.length === 0 ? undefined : orphanEdges.map((row) => row.issue),
      ),
    );

    const orphanContextRefs = this.db
      .prepare(
        `SELECT 'position:' || ci.position || ':message:' || ci.message_id AS issue
         FROM context_items ci
         LEFT JOIN ledger_events le ON le.id = ci.message_id
         WHERE ci.conversation_id = ?
           AND ci.message_id IS NOT NULL
           AND le.id IS NULL

         UNION ALL

         SELECT 'position:' || ci.position || ':summary:' || ci.summary_id AS issue
         FROM context_items ci
         LEFT JOIN summary_nodes sn ON sn.id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.summary_id IS NOT NULL
           AND sn.id IS NULL`,
      )
      .all(conversationId, conversationId) as unknown as IssueRow[];

    checks.push(
      createCheck(
        'no_orphan_context_refs',
        orphanContextRefs.length === 0,
        orphanContextRefs.length === 0
          ? undefined
          : 'Found context items pointing to missing messages or summaries.',
        orphanContextRefs.length === 0 ? undefined : orphanContextRefs.map((row) => row.issue),
      ),
    );

    const summaryIds = (
      this.db
        .prepare(
          `SELECT id AS summary_id
           FROM summary_nodes
           WHERE conversation_id = ?
           ORDER BY id ASC`,
        )
        .all(conversationId) as unknown as SummaryIdRow[]
    ).map((row) => row.summary_id);

    const visited = new Set<string>();
    const inPath = new Set<string>();
    const cycleStarts = new Set<string>();

    const walkForCycle = (summaryId: string): void => {
      if (inPath.has(summaryId)) {
        cycleStarts.add(summaryId);
        return;
      }

      if (visited.has(summaryId)) {
        return;
      }

      inPath.add(summaryId);

      for (const parentSummaryId of this.getParentSummaryIdStrings(summaryId)) {
        walkForCycle(parentSummaryId);
      }

      inPath.delete(summaryId);
      visited.add(summaryId);
    };

    for (const summaryId of summaryIds) {
      walkForCycle(summaryId);
    }

    const cycleIssues = [...cycleStarts];
    checks.push(
      createCheck(
        'acyclic_dag',
        cycleIssues.length === 0,
        cycleIssues.length === 0 ? undefined : 'Cycle detected in condensed summary parent edges.',
        cycleIssues.length === 0 ? undefined : cycleIssues,
      ),
    );

    const leafCoverage = this.db
      .prepare(
        `SELECT sn.id AS summary_id
         FROM summary_nodes sn
         LEFT JOIN summary_message_edges sme ON sme.summary_id = sn.id
         WHERE sn.conversation_id = ?
           AND sn.kind = 'leaf'
         GROUP BY sn.id
         HAVING COUNT(sme.message_id) = 0
         ORDER BY sn.id ASC`,
      )
      .all(conversationId) as unknown as SummaryIdRow[];

    checks.push(
      createCheck(
        'leaf_coverage',
        leafCoverage.length === 0,
        leafCoverage.length === 0
          ? undefined
          : 'Leaf summaries without message coverage were found.',
        leafCoverage.length === 0 ? undefined : leafCoverage.map((row) => row.summary_id),
      ),
    );

    const condensedCoverage = this.db
      .prepare(
        `SELECT sn.id AS summary_id
         FROM summary_nodes sn
         LEFT JOIN summary_parent_edges spe ON spe.summary_id = sn.id
         WHERE sn.conversation_id = ?
           AND sn.kind = 'condensed'
         GROUP BY sn.id
         HAVING COUNT(spe.parent_summary_id) = 0
         ORDER BY sn.id ASC`,
      )
      .all(conversationId) as unknown as SummaryIdRow[];

    checks.push(
      createCheck(
        'condensed_coverage',
        condensedCoverage.length === 0,
        condensedCoverage.length === 0
          ? undefined
          : 'Condensed summaries without parent coverage were found.',
        condensedCoverage.length === 0 ? undefined : condensedCoverage.map((row) => row.summary_id),
      ),
    );

    const positionRows = this.db
      .prepare(
        `SELECT position
         FROM context_items
         WHERE conversation_id = ?
         ORDER BY position ASC`,
      )
      .all(conversationId) as unknown as PositionRow[];
    const positionIssues: string[] = [];

    for (const [index, row] of positionRows.entries()) {
      const actual = parseSqliteInteger(row.position, 'context_items.position');
      if (actual !== index) {
        positionIssues.push(`expected:${index},actual:${actual}`);
      }
    }

    checks.push(
      createCheck(
        'contiguous_positions',
        positionIssues.length === 0,
        positionIssues.length === 0
          ? undefined
          : 'Context positions are not contiguous from 0..N-1.',
        positionIssues.length === 0 ? undefined : positionIssues,
      ),
    );

    const sequenceRows = this.db
      .prepare(
        `SELECT id, seq
         FROM ledger_events
         WHERE conversation_id = ?
         ORDER BY seq ASC`,
      )
      .all(conversationId) as unknown as SequenceRow[];
    const sequenceIssues: string[] = [];

    for (const [index, row] of sequenceRows.entries()) {
      const expected = index + 1;
      const actual = parseSqliteInteger(row.seq, 'ledger_events.seq');
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

    const artifactIssues: string[] = [];
    const artifactMemo = new Map<string, Set<string>>();

    for (const summaryId of summaryIds) {
      const node = await this.getNode(createSummaryNodeId(summaryId));
      if (node === null) {
        continue;
      }

      const expectedArtifactIds = uniqueSorted([
        ...this.computeExpectedArtifactIds(summaryId, artifactMemo, new Set()),
      ]);
      const actualArtifactIds = uniqueSorted([...node.artifactIds]);

      if (!arrayEquals(expectedArtifactIds, actualArtifactIds)) {
        const missing = expectedArtifactIds.filter(
          (artifactId) => !actualArtifactIds.includes(artifactId),
        );
        if (missing.length > 0) {
          artifactIssues.push(`${summaryId}:missing:${missing.join(',')}`);
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
  }
}
