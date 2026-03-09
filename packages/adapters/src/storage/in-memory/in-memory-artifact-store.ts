import type { ArtifactStorePort } from '@ledgermind/application';
import {
  createArtifact,
  InvariantViolationError,
  type Artifact,
  type ArtifactId,
} from '@ledgermind/domain';

import type { InMemoryPersistenceState } from './state';
import { cloneArtifactContent, createInMemoryPersistenceState } from './state';

export class InMemoryArtifactStore implements ArtifactStorePort {
  constructor(private readonly state: InMemoryPersistenceState = createInMemoryPersistenceState()) {}

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<void> {
    if (this.state.artifactsById.has(artifact.id)) {
      return;
    }

    this.state.artifactsById.set(artifact.id, {
      artifact,
      content: cloneArtifactContent(content ?? null),
    });
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    return this.state.artifactsById.get(id)?.artifact ?? null;
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    const record = this.state.artifactsById.get(id);
    if (!record) {
      return null;
    }

    return cloneArtifactContent(record.content);
  }

  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void> {
    const record = this.state.artifactsById.get(id);
    if (!record) {
      throw new InvariantViolationError('Cannot update exploration for unknown artifact.');
    }

    const updatedArtifact = createArtifact({
      id: record.artifact.id,
      conversationId: record.artifact.conversationId,
      storageKind: record.artifact.storageKind,
      originalPath: record.artifact.originalPath,
      mimeType: record.artifact.mimeType,
      tokenCount: record.artifact.tokenCount,
      explorationSummary: summary,
      explorerUsed,
    });

    this.state.artifactsById.set(id, {
      artifact: updatedArtifact,
      content: cloneArtifactContent(record.content),
    });
  }
}
