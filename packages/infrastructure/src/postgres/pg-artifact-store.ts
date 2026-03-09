import type { ArtifactStorePort } from '@ledgermind/application';
import {
  createArtifact,
  createArtifactId,
  createMimeType,
  createTokenCount,
  InvariantViolationError,
  type Artifact,
  type ArtifactId,
  type ConversationId,
  type StorageKind,
} from '@ledgermind/domain';

import { mapPgError } from './errors';
import { toTimestamp } from './sql';
import { toRowCount, type PgExecutor } from './types';

interface ArtifactRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly storage_kind: StorageKind;
  readonly original_path: string | null;
  readonly mime_type: string;
  readonly token_count: number;
  readonly exploration_summary: string | null;
  readonly explorer_used: string | null;
  readonly content_text: string | null;
  readonly content_binary: Uint8Array | null;
  readonly created_at: string | Date;
}

const toArtifact = (row: ArtifactRow): Artifact => {
  const artifact = createArtifact({
    id: createArtifactId(row.id),
    conversationId: row.conversation_id as ConversationId,
    storageKind: row.storage_kind,
    originalPath: row.original_path,
    mimeType: createMimeType(row.mime_type),
    tokenCount: createTokenCount(row.token_count),
    explorationSummary: row.exploration_summary,
    explorerUsed: row.explorer_used,
  });

  // Touch created_at to ensure valid timestamp parsing for row-shape integrity.
  toTimestamp(row.created_at);

  return artifact;
};

const cloneContent = (content: Uint8Array): Uint8Array => {
  return new Uint8Array(content);
};

const toContentColumns = (
  artifact: Artifact,
  content: string | Uint8Array | undefined,
): { readonly text: string | null; readonly binary: Uint8Array | null } => {
  if (artifact.storageKind === 'inline_text') {
    if (typeof content === 'string') {
      return {
        text: content,
        binary: null,
      };
    }

    if (content instanceof Uint8Array) {
      return {
        text: new TextDecoder().decode(content),
        binary: null,
      };
    }

    throw new InvariantViolationError('inline_text artifacts require textual content.');
  }

  if (artifact.storageKind === 'inline_binary') {
    if (content instanceof Uint8Array) {
      return {
        text: null,
        binary: cloneContent(content),
      };
    }

    if (typeof content === 'string') {
      return {
        text: null,
        binary: cloneContent(new TextEncoder().encode(content)),
      };
    }

    throw new InvariantViolationError('inline_binary artifacts require binary content.');
  }

  if (content === undefined) {
    return {
      text: null,
      binary: null,
    };
  }

  if (content instanceof Uint8Array) {
    return {
      text: null,
      binary: cloneContent(content),
    };
  }

  return {
    text: null,
    binary: cloneContent(new TextEncoder().encode(content)),
  };
};

export class PgArtifactStore implements ArtifactStorePort {
  constructor(private readonly executor: PgExecutor) {}

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<void> {
    try {
      const columns = toContentColumns(artifact, content);

      await this.executor.query(
        `INSERT INTO artifacts (
          id,
          conversation_id,
          storage_kind,
          original_path,
          mime_type,
          token_count,
          exploration_summary,
          explorer_used,
          content_text,
          content_binary
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING`,
        [
          artifact.id,
          artifact.conversationId,
          artifact.storageKind,
          artifact.originalPath,
          artifact.mimeType,
          artifact.tokenCount.value,
          artifact.explorationSummary,
          artifact.explorerUsed,
          columns.text,
          columns.binary,
        ],
      );
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    try {
      const result = await this.executor.query<ArtifactRow>(
        `SELECT id,
                conversation_id,
                storage_kind,
                original_path,
                mime_type,
                token_count,
                exploration_summary,
                explorer_used,
                content_text,
                content_binary,
                created_at
         FROM artifacts
         WHERE id = $1`,
        [id],
      );

      const row = result.rows[0];
      return row ? toArtifact(row) : null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    try {
      const result = await this.executor.query<Pick<ArtifactRow, 'content_text' | 'content_binary'>>(
        `SELECT content_text, content_binary
         FROM artifacts
         WHERE id = $1`,
        [id],
      );

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      if (row.content_text !== null) {
        return row.content_text;
      }

      if (row.content_binary !== null) {
        return cloneContent(row.content_binary);
      }

      return null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void> {
    try {
      const result = await this.executor.query(
        `UPDATE artifacts
         SET exploration_summary = $2,
             explorer_used = $3
         WHERE id = $1`,
        [id, summary, explorerUsed],
      );

      if (toRowCount(result.rowCount) === 0) {
        throw new InvariantViolationError('Cannot update exploration for unknown artifact.');
      }
    } catch (error) {
      if (error instanceof InvariantViolationError) {
        throw error;
      }

      mapPgError(error);
    }
  }
}
