import type { ConversationPort } from '@ledgermind/application';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createTokenCount,
  InvariantViolationError,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type Timestamp,
} from '@ledgermind/domain';

import { mapPgError } from './errors';
import { toTimestamp } from './sql';
import { toRowCount, type PgExecutor } from './types';

interface ConversationRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly model_name: string;
  readonly context_window: number;
  readonly soft_threshold: number;
  readonly hard_threshold: number;
  readonly created_at: string | Date;
}

interface NextConversationRow {
  readonly next_ordinal: number;
}

const toConversationConfig = (row: ConversationRow): ConversationConfig => {
  return createConversationConfig({
    modelName: row.model_name,
    contextWindow: createTokenCount(row.context_window),
    thresholds: createCompactionThresholds(row.soft_threshold, row.hard_threshold),
  });
};

const toConversation = (row: ConversationRow): Conversation => {
  return createConversation({
    id: createConversationId(row.id),
    parentId: row.parent_id === null ? null : createConversationId(row.parent_id),
    config: toConversationConfig(row),
    createdAt: toTimestamp(row.created_at) as Timestamp,
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
    readonly constraint?: unknown;
  };

  return candidate.code === '23505' && candidate.constraint === 'conversations_pkey';
};

export class PgConversationStore implements ConversationPort {
  constructor(private readonly executor: PgExecutor) {}

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
    const parentConversationId = parentId ?? null;

    try {
      if (parentConversationId !== null) {
        const parentResult = await this.executor.query<{ readonly id: string }>(
          `SELECT id
           FROM conversations
           WHERE id = $1`,
          [parentConversationId],
        );

        if (toRowCount(parentResult.rowCount) === 0) {
          throw new InvariantViolationError('Parent conversation does not exist.');
        }
      }

      for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt += 1) {
        try {
          const nextOrdinalResult = await this.executor.query<NextConversationRow>(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 6) AS INTEGER)), 0) + 1 AS next_ordinal
             FROM conversations
             WHERE id ~ '^conv_[0-9]{6}$'`,
          );

          const nextOrdinal = nextOrdinalResult.rows[0]?.next_ordinal ?? 1;
          const id = createNextConversationId(nextOrdinal);

          const insertResult = await this.executor.query<ConversationRow>(
            `INSERT INTO conversations (
              id,
              parent_id,
              model_name,
              context_window,
              soft_threshold,
              hard_threshold
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, parent_id, model_name, context_window, soft_threshold, hard_threshold, created_at`,
            [
              id,
              parentConversationId,
              config.modelName,
              config.contextWindow.value,
              config.thresholds.soft,
              config.thresholds.hard,
            ],
          );

          const row = insertResult.rows[0];
          if (!row) {
            throw new Error('Failed to insert conversation row.');
          }

          return toConversation(row);
        } catch (error) {
          const shouldRetry = attempt < MAX_CREATE_RETRIES - 1 && isUniqueConversationIdConflict(error);
          if (shouldRetry) {
            continue;
          }

          return mapPgError(error);
        }
      }

      throw new Error('Failed to create conversation after retry attempts.');
    } catch (error) {
      return mapPgError(error);
    }
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    try {
      const result = await this.executor.query<ConversationRow>(
        `SELECT id, parent_id, model_name, context_window, soft_threshold, hard_threshold, created_at
         FROM conversations
         WHERE id = $1`,
        [id],
      );

      const row = result.rows[0];
      return row ? toConversation(row) : null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]> {
    try {
      const result = await this.executor.query<{ readonly id: string }>(
        `WITH RECURSIVE chain AS (
          SELECT id, parent_id, 0 AS depth
          FROM conversations
          WHERE id = $1

          UNION ALL

          SELECT parent.id, parent.parent_id, chain.depth + 1
          FROM conversations parent
          JOIN chain ON parent.id = chain.parent_id
        )
        SELECT id
        FROM chain
        WHERE depth > 0
        ORDER BY depth DESC`,
        [id],
      );

      if (toRowCount(result.rowCount) === 0) {
        return [];
      }

      return result.rows.map((row) => createConversationId(row.id));
    } catch (error) {
      return mapPgError(error);
    }
  }
}
