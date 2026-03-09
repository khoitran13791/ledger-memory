import type { Artifact } from '@ledgermind/domain';

import {
  ArtifactContentUnavailableError,
  ArtifactExplorationFailedError,
  ArtifactNotFoundError,
  ExplorerResolutionError,
} from '../errors/application-errors';
import type { ExplorerRegistryPort } from '../ports/driven/explorer/explorer-registry.port';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { ExploreArtifactInput, ExploreArtifactOutput } from '../ports/driving/memory-engine.port';

const getExplorerPath = (artifact: Artifact): string => {
  return artifact.originalPath ?? `artifact://${artifact.id}`;
};

export interface ExploreArtifactUseCaseDeps {
  readonly artifactStore: ArtifactStorePort;
  readonly explorerRegistry: ExplorerRegistryPort;
}

export class ExploreArtifactUseCase {
  constructor(private readonly deps: ExploreArtifactUseCaseDeps) {}

  async execute(input: ExploreArtifactInput): Promise<ExploreArtifactOutput> {
    const artifact = await this.deps.artifactStore.getMetadata(input.artifactId);
    if (artifact === null) {
      throw new ArtifactNotFoundError(input.artifactId);
    }

    const artifactContent = await this.deps.artifactStore.getContent(input.artifactId);
    if (artifactContent === null) {
      throw new ArtifactContentUnavailableError(input.artifactId);
    }

    const path = getExplorerPath(artifact);

    let explorer: ReturnType<ExplorerRegistryPort['resolve']>;
    try {
      explorer = this.deps.explorerRegistry.resolve(artifact.mimeType, path, input.explorerHints);
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      throw new ExplorerResolutionError(input.artifactId, artifact.mimeType, path, message);
    }

    let result: Awaited<ReturnType<typeof explorer.explore>>;
    try {
      result = await explorer.explore({
        content: artifactContent,
        path,
        mimeType: artifact.mimeType,
      });
    } catch (error) {
      throw new ArtifactExplorationFailedError(input.artifactId, error);
    }

    const { summary, metadata, tokenCount } = result;
    await this.deps.artifactStore.updateExploration(input.artifactId, summary, explorer.name);

    return {
      explorerUsed: explorer.name,
      summary,
      metadata,
      tokenCount,
    };
  }
}
