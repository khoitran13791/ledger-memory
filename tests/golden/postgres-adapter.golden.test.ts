import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createArtifactId,
  createContextItem,
  createConversationConfig,
  createConversationId,
  createEventId,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';
import type { IntegrityReport } from '@ledgermind/application';
import type {
  ArtifactId,
  ConversationId,
  ContextItem,
  EventId,
  LedgerEvent,
  SummaryNode,
} from '@ledgermind/domain';
import {
  createPgPool,
  createPgUnitOfWorkFromPool,
  type PgPoolLike,
  type PgQueryResultLike,
} from '@ledgermind/infrastructure';

interface PostgresGoldenFixture {
  readonly name: string;
  readonly events: readonly {
    readonly role: 'system' | 'user' | 'assistant' | 'tool';
    readonly content: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }[];
  readonly expected: {
    readonly dagNodeCount: number;
    readonly contextItemCount: number;
    readonly summaryIdPrefix: string;
    readonly integrityPassed: boolean;
    readonly checkNames: readonly string[];
    readonly expandedMessageCount: number;
  };
}

const INTEGRITY_CHECK_NAMES = Object.freeze([
  'no_orphan_edges',
  'no_orphan_context_refs',
  'acyclic_dag',
  'leaf_coverage',
  'condensed_coverage',
  'contiguous_positions',
  'monotonic_sequence',
  'artifact_propagation',
]);

const fixture = {
  name: 'postgres-integrity-recovery',
  events: [
    {
      role: 'system',
      content: 'You are a memory-preserving coding assistant.',
    },
    {
      role: 'user',
      content: 'Record architecture decisions and artifact handles.',
      metadata: {
        artifactIds: ['file_spec_001'],
      },
    },
    {
      role: 'assistant',
      content: 'Decision logged with explicit constraints and rationale.',
      metadata: {
        artifactIds: ['file_spec_001'],
      },
    },
    {
      role: 'tool',
      content: 'Tool output: migration plan and SQL checklist generated.',
      metadata: {
        artifactIds: ['file_sql_001'],
      },
    },
  ],
  expected: {
    dagNodeCount: 2,
    contextItemCount: 3,
    summaryIdPrefix: 'sum_',
    integrityPassed: true,
    checkNames: INTEGRITY_CHECK_NAMES,
    expandedMessageCount: 4,
  },
} as const satisfies PostgresGoldenFixture;

interface PooledExecutor {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResultLike<Row>>;
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const createExecutorWithSchema = (
  pool: PgPoolLike,
  schemaName: string,
): PooledExecutor => {
  return {
    query: async <Row extends object = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
        return await client.query<Row>(text, params);
      } finally {
        client.release();
      }
    },
  };
};

const applyMigrations = async (executor: PooledExecutor): Promise<void> => {
  await executor.query(`
DO $$
BEGIN
  CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE summary_kind AS ENUM ('leaf', 'condensed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE storage_kind AS ENUM ('path', 'inline_text', 'inline_binary');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES conversations(id),
  model_name TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  soft_threshold REAL NOT NULL,
  hard_threshold REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (soft_threshold < hard_threshold)
);

CREATE TABLE IF NOT EXISTS ledger_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  role message_role NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS summary_nodes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind summary_kind NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS summary_message_edges (
  summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (summary_id, message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_message_edges_summary_ord
  ON summary_message_edges(summary_id, ord);

CREATE TABLE IF NOT EXISTS summary_parent_edges (
  summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (summary_id, parent_summary_id),
  CHECK (summary_id <> parent_summary_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_parent_edges_summary_ord
  ON summary_parent_edges(summary_id, ord);

CREATE TABLE IF NOT EXISTS context_items (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  message_id TEXT REFERENCES ledger_events(id) ON DELETE RESTRICT,
  summary_id TEXT REFERENCES summary_nodes(id) ON DELETE RESTRICT,
  PRIMARY KEY (conversation_id, position),
  CONSTRAINT context_items_exactly_one_ref CHECK (
    (message_id IS NOT NULL) <> (summary_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS context_versions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  storage_kind storage_kind NOT NULL,
  original_path TEXT,
  mime_type TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  exploration_summary TEXT,
  explorer_used TEXT,
  content_text TEXT,
  content_binary BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      storage_kind = 'path'
      AND original_path IS NOT NULL
      AND content_text IS NULL
      AND content_binary IS NULL
    )
    OR (
      storage_kind = 'inline_text'
      AND original_path IS NULL
      AND content_text IS NOT NULL
      AND content_binary IS NULL
    )
    OR (
      storage_kind = 'inline_binary'
      AND original_path IS NULL
      AND content_text IS NULL
      AND content_binary IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_events_conv_seq
  ON ledger_events(conversation_id, seq);

CREATE INDEX IF NOT EXISTS idx_ledger_events_tsv
  ON ledger_events USING GIN(content_tsv);

CREATE INDEX IF NOT EXISTS idx_summary_nodes_conv
  ON summary_nodes(conversation_id);

CREATE INDEX IF NOT EXISTS idx_summary_nodes_tsv
  ON summary_nodes USING GIN (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_context_items_conv
  ON context_items(conversation_id, position);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv
  ON artifacts(conversation_id);
`);
};

const createConversation = async (
  executor: PooledExecutor,
  conversationId: ConversationId,
): Promise<void> => {
  const config = createConversationConfig({
    modelName: 'test-model',
    contextWindow: createTokenCount(8_192),
    thresholds: {
      soft: 0.6,
      hard: 1,
    },
  });

  await executor.query(
    `INSERT INTO conversations (id, parent_id, model_name, context_window, soft_threshold, hard_threshold)
     VALUES ($1, NULL, $2, $3, $4, $5)`,
    [
      conversationId,
      config.modelName,
      config.contextWindow.value,
      config.thresholds.soft,
      config.thresholds.hard,
    ],
  );
};

const createEvents = (
  conversationId: ConversationId,
  fixtureEvents: readonly PostgresGoldenFixture['events'][number][],
): readonly LedgerEvent[] => {
  return fixtureEvents.map((event, index) => {
    const sequence = createSequenceNumber(index + 1);
    return createLedgerEvent({
      id: createEventId(`evt_postgres_golden_${index + 1}`),
      conversationId,
      sequence,
      role: event.role,
      content: event.content,
      tokenCount: createTokenCount(Math.max(1, event.content.length)),
      occurredAt: createTimestamp(new Date(`2026-02-03T00:00:${String(index + 1).padStart(2, '0')}.000Z`)),
      metadata: event.metadata ?? {},
    });
  });
};

const uniqueArtifactIdsFromEvents = (events: readonly LedgerEvent[]): readonly ArtifactId[] => {
  const ids = new Set<string>();

  for (const event of events) {
    const metadata = event.metadata as Readonly<Record<string, unknown>>;
    const artifactIds = metadata.artifactIds;
    if (Array.isArray(artifactIds)) {
      for (const value of artifactIds) {
        if (typeof value === 'string') {
          ids.add(value);
        }
      }
    }
  }

  return Object.freeze(
    [...ids]
      .sort((left, right) => left.localeCompare(right))
      .map((artifactId) => createArtifactId(artifactId)),
  );
};

const createSummaryNodes = (
  conversationId: ConversationId,
  leafArtifactIds: readonly ArtifactId[],
): { readonly leaf: SummaryNode; readonly condensed: SummaryNode } => {
  const leaf = createSummaryNode({
    id: createSummaryNodeId('sum_postgres_golden_leaf'),
    conversationId,
    kind: 'leaf',
    content: '[Summary] Consolidated architectural decisions and tool outputs.',
    tokenCount: createTokenCount(24),
    artifactIds: leafArtifactIds,
    createdAt: createTimestamp(new Date('2026-02-03T00:10:00.000Z')),
  });

  const condensed = createSummaryNode({
    id: createSummaryNodeId('sum_postgres_golden_condensed'),
    conversationId,
    kind: 'condensed',
    content: '[Aggressive Summary] High-signal memory checkpoint for recovery.',
    tokenCount: createTokenCount(16),
    artifactIds: leafArtifactIds,
    createdAt: createTimestamp(new Date('2026-02-03T00:20:00.000Z')),
  });

  return {
    leaf,
    condensed,
  };
};

const buildContextItems = (
  conversationId: ConversationId,
  condensedSummaryId: SummaryNode['id'],
  tailEventIds: readonly EventId[],
): readonly ContextItem[] => {
  return Object.freeze([
    createContextItem({
      conversationId,
      position: 0,
      ref: createSummaryContextItemRef(condensedSummaryId),
    }),
    ...tailEventIds.map((eventId, index) =>
      createContextItem({
        conversationId,
        position: index + 1,
        ref: createMessageContextItemRef(eventId),
      }),
    ),
  ]);
};

interface GoldenRunResult {
  readonly summaryIds: readonly string[];
  readonly contextRefs: readonly string[];
  readonly integrityReport: IntegrityReport;
  readonly expandedMessageIds: readonly string[];
}

const runFixture = async (): Promise<GoldenRunResult> => {
  const connectionString =
    process.env.LEDGERMIND_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const pool = createPgPool({ connectionString }) as unknown as PgPoolLike;
  const schemaName = `lm_golden_${randomUUID().replaceAll('-', '_')}`;
  const quotedSchemaName = quoteIdentifier(schemaName);

  const admin = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quotedSchemaName}`);
  } finally {
    admin.release();
  }

  const executor = createExecutorWithSchema(pool, schemaName);

  try {
    await applyMigrations(executor);

    const conversationId = createConversationId(`conv_pg_golden_${randomUUID().slice(0, 8)}`);
    await createConversation(executor, conversationId);

    const unitOfWork = createPgUnitOfWorkFromPool(pool as never);

    const events = createEvents(conversationId, fixture.events);

    await unitOfWork.execute(async (uow) => {
      await uow.ledger.appendEvents(conversationId, events);

      const leafArtifactIds = uniqueArtifactIdsFromEvents(events);
      const summaries = createSummaryNodes(conversationId, leafArtifactIds);
      await uow.dag.createNode(summaries.leaf);
      await uow.dag.createNode(summaries.condensed);

      await uow.dag.addLeafEdges(
        summaries.leaf.id,
        events.map((event) => event.id),
      );
      await uow.dag.addCondensedEdges(summaries.condensed.id, [summaries.leaf.id]);

      const tailWindowSize = Math.min(2, events.length);
      const tailEventIds = events.slice(-tailWindowSize).map((event) => event.id);
      const contextItems = buildContextItems(conversationId, summaries.condensed.id, tailEventIds);
      await uow.context.appendContextItems(conversationId, contextItems);
    });

    const rehydratedUnitOfWork = createPgUnitOfWorkFromPool(pool as never);
    const recovered = await rehydratedUnitOfWork.execute(async (uow) => {
      const summaries = await uow.dag.searchSummaries(conversationId, 'summary');
      const snapshot = await uow.context.getCurrentContext(conversationId);
      const integrity = await uow.dag.checkIntegrity(conversationId);
      const expanded = await uow.dag.expandToMessages(createSummaryNodeId('sum_postgres_golden_condensed'));

      return {
        summaryIds: Object.freeze(summaries.map((summary) => summary.id)),
        contextRefs: Object.freeze(
          snapshot.items.map((item) =>
            item.ref.type === 'summary' ? `summary:${item.ref.summaryId}` : `message:${item.ref.messageId}`,
          ),
        ),
        integrityReport: integrity,
        expandedMessageIds: Object.freeze(expanded.map((message) => message.id)),
      } satisfies GoldenRunResult;
    });

    return recovered;
  } finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
    } finally {
      cleanup.release();
    }

    const maybeClosablePool = pool as unknown as { end?: () => Promise<void> };
    if (typeof maybeClosablePool.end === 'function') {
      await maybeClosablePool.end();
    }
  }
};

describe('postgres adapter golden', () => {
  it('produces stable integrity + recovery signatures across repeated runs', async () => {
    const first = await runFixture();
    const second = await runFixture();

    expect(first.summaryIds.length).toBe(fixture.expected.dagNodeCount);
    expect(first.contextRefs.length).toBe(fixture.expected.contextItemCount);
    expect(first.expandedMessageIds.length).toBe(fixture.expected.expandedMessageCount);

    expect(first.integrityReport.passed).toBe(fixture.expected.integrityPassed);
    expect(first.integrityReport.checks.map((check: IntegrityReport['checks'][number]) => check.name)).toEqual(
      fixture.expected.checkNames,
    );
    expect(first.integrityReport.checks.every((check: IntegrityReport['checks'][number]) => check.passed)).toBe(
      true,
    );

    expect(first.summaryIds.every((summaryId) => summaryId.startsWith(fixture.expected.summaryIdPrefix))).toBe(true);
    expect(first.contextRefs[0]?.startsWith('summary:sum_')).toBe(true);

    expect(second).toEqual(first);
  });
});
