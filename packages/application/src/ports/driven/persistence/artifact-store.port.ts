import type { Artifact, ArtifactId } from '@ledgermind/domain';

export interface ArtifactStorePort {
  /**
   * Stores artifact metadata with optional inline content.
   * Payloads are platform-neutral: text (`string`) or binary (`Uint8Array`).
   */
  store(artifact: Artifact, content?: string | Uint8Array): Promise<void>;

  /**
   * Phase 1 keeps artifact metadata access open to normal callers.
   */
  getMetadata(id: ArtifactId): Promise<Artifact | null>;

  /**
   * Phase 1 keeps artifact content access open to normal callers.
   */
  getContent(id: ArtifactId): Promise<string | Uint8Array | null>;

  updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void>;
}
