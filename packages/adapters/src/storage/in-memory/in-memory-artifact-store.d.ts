import type { ArtifactStorePort } from '@ledgermind/application';
import { type Artifact, type ArtifactId } from '@ledgermind/domain';
import type { InMemoryPersistenceState } from './state';
export declare class InMemoryArtifactStore implements ArtifactStorePort {
    private readonly state;
    constructor(state?: InMemoryPersistenceState);
    store(artifact: Artifact, content?: string | Uint8Array): Promise<void>;
    getMetadata(id: ArtifactId): Promise<Artifact | null>;
    getContent(id: ArtifactId): Promise<string | Uint8Array | null>;
    updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void>;
}
//# sourceMappingURL=in-memory-artifact-store.d.ts.map