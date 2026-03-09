import { describe, expect, it } from 'vitest';

import { InMemoryArtifactStore, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { createArtifact, createArtifactId, createConversationId, createMimeType } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

const createArtifactFixture = (id: string) => {
  return createArtifact({
    id: createArtifactId(id),
    conversationId: createConversationId('conv_artifacts'),
    storageKind: 'inline_text',
    mimeType: createMimeType('text/plain'),
    tokenCount: createTokenCount(3),
  });
};

describe('InMemoryArtifactStore', () => {
  it('stores metadata and content and returns cloned binary content', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryArtifactStore(state);
    const artifact = createArtifactFixture('file_1');
    const content = new Uint8Array([1, 2, 3]);

    await store.store(artifact, content);

    const metadata = await store.getMetadata(artifact.id);
    expect(metadata?.id).toBe(artifact.id);

    const firstRead = await store.getContent(artifact.id);
    expect(firstRead).toEqual(content);
    expect(firstRead).not.toBe(content);

    if (firstRead instanceof Uint8Array) {
      firstRead[0] = 99;
    }

    const secondRead = await store.getContent(artifact.id);
    expect(secondRead).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('applies idempotent on-conflict-do-nothing semantics on duplicate store', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryArtifactStore(state);
    const artifact = createArtifactFixture('file_2');

    await store.store(artifact, 'first-content');
    await store.store(artifact, 'second-content');

    const content = await store.getContent(artifact.id);
    expect(content).toBe('first-content');
  });

  it('updates exploration metadata', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryArtifactStore(state);
    const artifact = createArtifactFixture('file_3');

    await store.store(artifact, 'artifact-text');
    await store.updateExploration(artifact.id, 'exploration summary', 'typescript-explorer');

    const updated = await store.getMetadata(artifact.id);
    expect(updated?.explorationSummary).toBe('exploration summary');
    expect(updated?.explorerUsed).toBe('typescript-explorer');
  });

  it('throws when updating exploration for unknown artifact', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryArtifactStore(state);

    await expect(
      store.updateExploration(createArtifactId('file_missing'), 'summary', 'explorer'),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });
});
