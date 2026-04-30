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
import type { DatabaseSync } from 'node:sqlite';

import { parseSqliteInteger } from './sqlite-json';

interface ArtifactRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly storage_kind: StorageKind;
  readonly original_path: string | null;
  readonly mime_type: string;
  readonly token_count: unknown;
  readonly exploration_summary: string | null;
  readonly explorer_used: string | null;
  readonly content_text: string | null;
  readonly content_binary: Uint8Array | null;
}

const cloneContent = (content: Uint8Array): Uint8Array => {
  return new Uint8Array(content);
};

const toArtifact = (row: ArtifactRow): Artifact => {
  return createArtifact({
    id: createArtifactId(row.id),
    conversationId: row.conversation_id as ConversationId,
    storageKind: row.storage_kind,
    originalPath: row.original_path,
    mimeType: createMimeType(row.mime_type),
    tokenCount: createTokenCount(parseSqliteInteger(row.token_count, 'artifacts.token_count')),
    explorationSummary: row.exploration_summary,
    explorerUsed: row.explorer_used,
  });
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

  throw new InvariantViolationError('path artifacts require binary snapshot content.');
};

export class SqliteArtifactStore implements ArtifactStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<boolean> {
    const columns = toContentColumns(artifact, content);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO artifacts (
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );

    return Number(result.changes) > 0;
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    const row = this.db
      .prepare(
        `SELECT id,
                conversation_id,
                storage_kind,
                original_path,
                mime_type,
                token_count,
                exploration_summary,
                explorer_used,
                content_text,
                content_binary
         FROM artifacts
         WHERE id = ?`,
      )
      .get(id) as ArtifactRow | undefined;

    return row === undefined ? null : toArtifact(row);
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    const row = this.db
      .prepare(
        `SELECT content_text, content_binary
         FROM artifacts
         WHERE id = ?`,
      )
      .get(id) as Pick<ArtifactRow, 'content_text' | 'content_binary'> | undefined;

    if (row === undefined) {
      return null;
    }

    if (row.content_text !== null) {
      return row.content_text;
    }

    if (row.content_binary !== null) {
      return cloneContent(row.content_binary);
    }

    return null;
  }

  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE artifacts
         SET exploration_summary = ?,
             explorer_used = ?
         WHERE id = ?`,
      )
      .run(summary, explorerUsed, id);

    if (Number(result.changes) === 0) {
      throw new InvariantViolationError('Cannot update exploration for unknown artifact.');
    }
  }
}
