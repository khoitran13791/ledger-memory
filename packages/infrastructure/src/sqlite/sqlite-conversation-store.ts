import type { ConversationPort } from '@ledgermind/application';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createTimestamp,
  createTokenCount,
  InvariantViolationError,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
} from '@ledgermind/domain';
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';

interface ConversationRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly model_name: string;
  readonly context_window: unknown;
  readonly soft_threshold: number;
  readonly hard_threshold: number;
  readonly created_at: string;
}

interface NextConversationRow {
  readonly next_ordinal: unknown;
}

const toConversationConfig = (row: ConversationRow): ConversationConfig => {
  return createConversationConfig({
    modelName: row.model_name,
    contextWindow: createTokenCount(
      parseSqliteInteger(row.context_window, 'conversations.context_window'),
    ),
    thresholds: createCompactionThresholds(row.soft_threshold, row.hard_threshold),
  });
};

const toConversation = (row: ConversationRow): Conversation => {
  return createConversation({
    id: createConversationId(row.id),
    parentId: row.parent_id === null ? null : createConversationId(row.parent_id),
    config: toConversationConfig(row),
    createdAt: createTimestamp(new Date(row.created_at)),
  });
};

const createNextConversationId = (nextOrdinal: number): ConversationId => {
  return createConversationId(`conv_${String(nextOrdinal).padStart(6, '0')}`);
};

const MAX_CREATE_RETRIES = 3;

const isUniqueConversationIdConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    readonly code?: unknown;
    readonly errcode?: unknown;
    readonly message?: unknown;
  };

  return (
    candidate.code === 'ERR_SQLITE_ERROR' &&
    candidate.errcode === 1555 &&
    typeof candidate.message === 'string' &&
    candidate.message.includes('UNIQUE constraint failed: conversations.id')
  );
};

export class SqliteConversationStore implements ConversationPort {
  constructor(private readonly db: DatabaseSync) {}

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
    const parentConversationId = parentId ?? null;

    if (parentConversationId !== null) {
      const parent = this.db
        .prepare('SELECT id FROM conversations WHERE id = ?')
        .get(parentConversationId);

      if (parent === undefined) {
        throw new InvariantViolationError('Parent conversation does not exist.');
      }
    }

    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt += 1) {
      const ordinalRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(CAST(SUBSTR(id, 6) AS INTEGER)), 0) + 1 AS next_ordinal
           FROM conversations
           WHERE id GLOB 'conv_[0-9][0-9][0-9][0-9][0-9][0-9]'`,
        )
        .get() as NextConversationRow | undefined;

      const nextOrdinal = parseSqliteInteger(
        ordinalRow?.next_ordinal ?? 1,
        'conversations.next_ordinal',
      );
      const id = createNextConversationId(nextOrdinal);

      try {
        this.db
          .prepare(
            `INSERT INTO conversations (
              id,
              parent_id,
              model_name,
              context_window,
              soft_threshold,
              hard_threshold
            )
            VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            parentConversationId,
            config.modelName,
            config.contextWindow.value,
            config.thresholds.soft,
            config.thresholds.hard,
          );
      } catch (error) {
        const shouldRetry =
          attempt < MAX_CREATE_RETRIES - 1 && isUniqueConversationIdConflict(error);
        if (shouldRetry) {
          continue;
        }

        if (isUniqueConversationIdConflict(error)) {
          throw new Error('Failed to create conversation after retry attempts.');
        }

        throw error;
      }

      const created = await this.get(id);
      if (created === null) {
        throw new Error('Failed to insert conversation row.');
      }

      return created;
    }

    throw new Error('Failed to create conversation after retry attempts.');
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    const row = this.db
      .prepare(
        `SELECT id, parent_id, model_name, context_window, soft_threshold, hard_threshold, created_at
         FROM conversations
         WHERE id = ?`,
      )
      .get(id) as ConversationRow | undefined;

    return row === undefined ? null : toConversation(row);
  }

  async getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 AS depth
          FROM conversations
          WHERE id = ?

          UNION ALL

          SELECT parent.id, parent.parent_id, chain.depth + 1
          FROM conversations parent
          JOIN chain ON parent.id = chain.parent_id
        )
        SELECT id
        FROM chain
        WHERE depth > 0
        ORDER BY depth DESC`,
      )
      .all(id) as Array<{ readonly id: string }>;

    return rows.map((row) => createConversationId(row.id));
  }
}
