import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createArtifact,
  createArtifactId,
  createConversationId,
  createMimeType,
  createTokenCount,
  type ConversationId,
  type StorageKind,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteArtifactStore } from '../sqlite-artifact-store';
import { openSqliteDatabase } from '../sqlite-connection';

const tempDirs: string[] = [];

const createArtifactFixture = (
  conversationId: ConversationId,
  id: string,
  storageKind: StorageKind = 'inline_text',
  originalPath = '/tmp/input.txt',
) => {
  return createArtifact({
    id: createArtifactId(id),
    conversationId,
    storageKind,
    ...(storageKind === 'path' ? { originalPath } : {}),
    mimeType: createMimeType('text/plain'),
    tokenCount: createTokenCount(3),
  });
};

const createTestDatabase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-artifacts-'));
  tempDirs.push(dir);
  const database = await openSqliteDatabase({ path: join(dir, 'memory.sqlite') });
  const conversationId = createConversationId('conv_artifacts_001');

  database.db
    .prepare(
      `INSERT INTO conversations (
        id,
        model_name,
        context_window,
        soft_threshold,
        hard_threshold
      )
      VALUES (?, ?, ?, ?, ?)`,
    )
    .run(conversationId, 'sqlite-local', 8192, 0.6, 0.9);

  return {
    database,
    conversationId,
    artifacts: new SqliteArtifactStore(database.db),
  };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteArtifactStore', () => {
  it('stores inline text, preserves metadata, returns original text, and rejects duplicate ids', async () => {
    const { artifacts, conversationId, database } = await createTestDatabase();
    const artifact = createArtifactFixture(conversationId, 'file_sqlite_text');

    try {
      await expect(artifacts.store(artifact, 'first-content')).resolves.toBe(true);
      await expect(artifacts.store(artifact, 'second-content')).resolves.toBe(false);

      await expect(artifacts.getMetadata(artifact.id)).resolves.toEqual(artifact);
      await expect(artifacts.getContent(artifact.id)).resolves.toBe('first-content');
    } finally {
      database.close();
    }
  });

  it('stores path snapshots as cloned Uint8Array content and restores them after reopening', async () => {
    const { artifacts, conversationId, database } = await createTestDatabase();
    const path = database.path;
    const artifact = createArtifactFixture(
      conversationId,
      'file_sqlite_path',
      'path',
      '/tmp/sqlite-input.txt',
    );
    const fileBytes = new Uint8Array([7, 8, 9]);

    try {
      await expect(artifacts.store(artifact, fileBytes)).resolves.toBe(true);
      fileBytes[0] = 99;
    } finally {
      database.close();
    }

    const reopened = await openSqliteDatabase({ path });

    try {
      const reopenedArtifacts = new SqliteArtifactStore(reopened.db);
      const content = await reopenedArtifacts.getContent(artifact.id);

      expect(content).toEqual(new Uint8Array([7, 8, 9]));
      expect(content).toBeInstanceOf(Uint8Array);
      expect(content).not.toBe(fileBytes);

      if (content instanceof Uint8Array) {
        content[1] = 100;
      }

      await expect(reopenedArtifacts.getContent(artifact.id)).resolves.toEqual(
        new Uint8Array([7, 8, 9]),
      );
    } finally {
      reopened.close();
    }
  });

  it('updates exploration summary and explorerUsed in metadata', async () => {
    const { artifacts, conversationId, database } = await createTestDatabase();
    const artifact = createArtifactFixture(conversationId, 'file_sqlite_exploration');

    try {
      await expect(artifacts.store(artifact, 'artifact-text')).resolves.toBe(true);
      await artifacts.updateExploration(artifact.id, 'exploration summary', 'typescript-explorer');

      const updated = await artifacts.getMetadata(artifact.id);
      expect(updated?.explorationSummary).toBe('exploration summary');
      expect(updated?.explorerUsed).toBe('typescript-explorer');
    } finally {
      database.close();
    }
  });
});
