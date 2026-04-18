import {
  ArtifactContentUnavailableError,
  ArtifactExplorationFailedError,
  ArtifactNotFoundError,
  ExplorerResolutionError,
} from '../errors/application-errors';
import type { ExplorerRegistryPort } from '../ports/driven/explorer/explorer-registry.port';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { ExploreArtifactInput, ExploreArtifactOutput } from '../ports/driving/memory-engine.port';
import { executeArtifactExploration, getArtifactExplorePath, resolveArtifactExplorer } from './artifact-exploration';

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

    const path = getArtifactExplorePath(artifact);
    let resolved: ReturnType<typeof resolveArtifactExplorer>;
    try {
      resolved = resolveArtifactExplorer({
        artifact,
        explorerRegistry: this.deps.explorerRegistry,
        ...(input.explorerHints === undefined ? {} : { explorerHints: input.explorerHints }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      throw new ExplorerResolutionError(input.artifactId, artifact.mimeType, path, message);
    }

    let result: Awaited<ReturnType<typeof executeArtifactExploration>>;
    try {
      result = await executeArtifactExploration({
        artifact,
        content: artifactContent,
        path: resolved.path,
        explorer: resolved.explorer,
      });
    } catch (error) {
      throw new ArtifactExplorationFailedError(input.artifactId, error);
    }

    const { summary, metadata, tokenCount } = result;
    await this.deps.artifactStore.updateExploration(input.artifactId, summary, result.explorerUsed);

    return {
      explorerUsed: result.explorerUsed,
      summary,
      metadata,
      tokenCount,
    };
  }
}
