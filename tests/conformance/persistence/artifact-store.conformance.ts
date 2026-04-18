import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createArtifactId,
  createMimeType,
  createTokenCount,
  type Artifact,
  type ConversationId,
  type StorageKind,
} from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from '../run-conformance';

const createArtifactFixture = (input: {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly storageKind: StorageKind;
  readonly tokenCount?: number;
  readonly originalPath?: string;
}): Artifact => {
  return createArtifact({
    id: createArtifactId(input.id),
    conversationId: input.conversationId,
    storageKind: input.storageKind,
    ...(input.storageKind === 'path'
      ? {
          originalPath: input.originalPath ?? '/tmp/conformance-artifact.txt',
        }
      : {}),
    mimeType: createMimeType('text/plain'),
    tokenCount: createTokenCount(input.tokenCount ?? 8),
  });
};

export const registerArtifactStoreConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('artifact store contract', () => {
    it('round-trips inline_text, inline_binary, and path payloads', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const conversationId = runtime.defaultConversationId;

        const inlineText = createArtifactFixture({
          id: 'file_conf_inline_text',
          conversationId,
          storageKind: 'inline_text',
        });
        const inlineBinary = createArtifactFixture({
          id: 'file_conf_inline_binary',
          conversationId,
          storageKind: 'inline_binary',
        });
        const pathArtifact = createArtifactFixture({
          id: 'file_conf_path',
          conversationId,
          storageKind: 'path',
          originalPath: '/tmp/conf/path.txt',
        });

        const binaryPayload = new Uint8Array([4, 5, 6, 7]);
        const pathPayload = new Uint8Array([8, 9, 10]);

        const textInserted = await runtime.artifacts.store(inlineText, 'conformance inline text');
        const binaryInserted = await runtime.artifacts.store(inlineBinary, binaryPayload);
        const pathInserted = await runtime.artifacts.store(pathArtifact, pathPayload);

        expect(textInserted).toBe(true);
        expect(binaryInserted).toBe(true);
        expect(pathInserted).toBe(true);

        const loadedText = await runtime.artifacts.getContent(inlineText.id);
        const loadedBinary = await runtime.artifacts.getContent(inlineBinary.id);
        const loadedPath = await runtime.artifacts.getContent(pathArtifact.id);

        expect(loadedText).toBe('conformance inline text');
        expect(loadedBinary).toEqual(binaryPayload);
        expect(loadedPath).toEqual(pathPayload);

        if (loadedBinary instanceof Uint8Array) {
          loadedBinary[0] = 99;
        }
        const loadedBinaryAgain = await runtime.artifacts.getContent(inlineBinary.id);
        expect(loadedBinaryAgain).toEqual(binaryPayload);

        const metadata = await runtime.artifacts.getMetadata(pathArtifact.id);
        expect(metadata?.storageKind).toBe('path');
        expect(metadata?.originalPath).toBe('/tmp/conf/path.txt');
      } finally {
        await runtime.destroy();
      }
    });

    it('updates exploration metadata while preserving original content payload', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const artifact = createArtifactFixture({
          id: 'file_conf_explore_update',
          conversationId: runtime.defaultConversationId,
          storageKind: 'inline_text',
        });

        const inserted = await runtime.artifacts.store(artifact, 'content before update');
        expect(inserted).toBe(true);
        await runtime.artifacts.updateExploration(artifact.id, 'summary update', 'conformance-explorer');

        const updated = await runtime.artifacts.getMetadata(artifact.id);
        const content = await runtime.artifacts.getContent(artifact.id);

        expect(updated?.explorationSummary).toBe('summary update');
        expect(updated?.explorerUsed).toBe('conformance-explorer');
        expect(content).toBe('content before update');
      } finally {
        await runtime.destroy();
      }
    });

    it('returns false when duplicate artifact store becomes a no-op', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const artifact = createArtifactFixture({
          id: 'file_conf_duplicate',
          conversationId: runtime.defaultConversationId,
          storageKind: 'inline_text',
        });

        const firstInsert = await runtime.artifacts.store(artifact, 'first payload');
        const duplicateInsert = await runtime.artifacts.store(artifact, 'second payload');
        const content = await runtime.artifacts.getContent(artifact.id);

        expect(firstInsert).toBe(true);
        expect(duplicateInsert).toBe(false);
        expect(content).toBe('first payload');
      } finally {
        await runtime.destroy();
      }
    });
  });
};
