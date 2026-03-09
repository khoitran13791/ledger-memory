import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createArtifact, createArtifactId, createMimeType } from '@ledgermind/domain';
import type { ConversationId } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

import { createPostgresTestHarness } from './postgres-test-harness';

const createArtifactFixture = (
  conversationId: ConversationId,
  id: string,
  storageKind: 'inline_text' | 'inline_binary' | 'path' = 'inline_text',
  originalPath = '/tmp/input.txt',
) => {
  return createArtifact({
    id: createArtifactId(id),
    conversationId,
    storageKind,
    ...(storageKind === 'path'
      ? {
          originalPath,
        }
      : {}),
    mimeType: createMimeType('text/plain'),
    tokenCount: createTokenCount(3),
  });
};

describe('PgArtifactStore', () => {
  it('stores metadata and content and returns cloned binary content', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { artifacts, conversationId, withClient } = harness;
      const artifact = createArtifactFixture(conversationId, 'file_1', 'inline_binary');
      const content = new Uint8Array([1, 2, 3]);

      await artifacts.store(artifact, content);

      const metadata = await artifacts.getMetadata(artifact.id);
      expect(metadata?.id).toBe(artifact.id);

      const firstRead = await artifacts.getContent(artifact.id);
      expect(firstRead).toEqual(content);
      expect(firstRead).not.toBe(content);

      if (firstRead instanceof Uint8Array) {
        firstRead[0] = 99;
      }

      const secondRead = await artifacts.getContent(artifact.id);
      expect(secondRead).toEqual(new Uint8Array([1, 2, 3]));

      await withClient(async (client) => {
        const persisted = await client.query<{ readonly content_binary: Buffer }>(
          `
            SELECT content_binary
            FROM artifacts
            WHERE id = $1
          `,
          [artifact.id],
        );

        expect(persisted.rows).toHaveLength(1);
        expect(persisted.rows[0]?.content_binary).toEqual(Buffer.from([1, 2, 3]));
      });
    } finally {
      await harness.destroy();
    }
  });

  it('applies idempotent on-conflict-do-nothing semantics on duplicate store', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { artifacts, conversationId } = harness;
      const artifact = createArtifactFixture(conversationId, 'file_2');

      await artifacts.store(artifact, 'first-content');
      await artifacts.store(artifact, 'second-content');

      const content = await artifacts.getContent(artifact.id);
      expect(content).toBe('first-content');
    } finally {
      await harness.destroy();
    }
  });

  it('updates exploration metadata', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { artifacts, conversationId } = harness;
      const artifact = createArtifactFixture(conversationId, 'file_3');

      await artifacts.store(artifact, 'artifact-text');
      await artifacts.updateExploration(artifact.id, 'exploration summary', 'typescript-explorer');

      const updated = await artifacts.getMetadata(artifact.id);
      expect(updated?.explorationSummary).toBe('exploration summary');
      expect(updated?.explorerUsed).toBe('typescript-explorer');
    } finally {
      await harness.destroy();
    }
  });

  it('throws when updating exploration for unknown artifact', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { artifacts } = harness;

      await expect(
        artifacts.updateExploration(createArtifactId('file_missing'), 'summary', 'explorer'),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    } finally {
      await harness.destroy();
    }
  });

  it('stores path metadata and persists binary payload for exploration', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { artifacts, conversationId, withClient } = harness;
      const artifact = createArtifactFixture(conversationId, 'file_path_1', 'path', '/tmp/input.txt');
      const fileBytes = new Uint8Array([7, 8, 9]);

      await artifacts.store(artifact, fileBytes);

      const content = await artifacts.getContent(artifact.id);
      expect(content).toEqual(fileBytes);
      expect(content).not.toBe(fileBytes);

      await withClient(async (client) => {
        const persisted = await client.query<{
          readonly original_path: string | null;
          readonly content_text: string | null;
          readonly content_binary: Buffer | null;
        }>(
          `
            SELECT original_path, content_text, content_binary
            FROM artifacts
            WHERE id = $1
          `,
          [artifact.id],
        );

        expect(persisted.rows).toEqual([
          {
            original_path: '/tmp/input.txt',
            content_text: null,
            content_binary: Buffer.from([7, 8, 9]),
          },
        ]);
      });
    } finally {
      await harness.destroy();
    }
  });

  it('rejects invalid mixed payload shape for path storage at schema level', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, withClient } = harness;
      const artifactId = `file_${randomUUID().replaceAll('-', '')}`;

      await expect(
        withClient(async (client) => {
          await client.query(
            `
              INSERT INTO artifacts (
                id,
                conversation_id,
                storage_kind,
                original_path,
                mime_type,
                token_count,
                content_text,
                content_binary
              ) VALUES ($1, $2, 'path', $3, $4, $5, $6, $7)
            `,
            [
              artifactId,
              conversationId,
              '/tmp/input.txt',
              'text/plain',
              1,
              'unexpected-inline-text',
              Buffer.from([1, 2, 3]),
            ],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await harness.destroy();
    }
  });
});
