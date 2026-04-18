import type { Artifact } from '@ledgermind/domain';

import type { ExplorerPort } from '../ports/driven/explorer/explorer.port';
import type { ExplorerRegistryPort } from '../ports/driven/explorer/explorer-registry.port';
import type { ExplorerHints } from '../ports/driving/memory-engine.port';

export interface ResolvedArtifactExplorer {
  readonly path: string;
  readonly explorer: ExplorerPort;
}

export interface ArtifactExplorationResult {
  readonly explorerUsed: string;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tokenCount: Artifact['tokenCount'];
}

export const getArtifactExplorePath = (artifact: Artifact): string => {
  return artifact.originalPath ?? `artifact://${artifact.id}`;
};

export const resolveArtifactExplorer = (input: {
  readonly artifact: Artifact;
  readonly explorerRegistry: ExplorerRegistryPort;
  readonly explorerHints?: ExplorerHints;
}): ResolvedArtifactExplorer => {
  const path = getArtifactExplorePath(input.artifact);
  const explorer = input.explorerRegistry.resolve(
    input.artifact.mimeType,
    path,
    input.explorerHints,
  );

  return { path, explorer };
};

export const executeArtifactExploration = async (input: {
  readonly artifact: Artifact;
  readonly content: string | Uint8Array;
  readonly path: string;
  readonly explorer: ExplorerPort;
}): Promise<ArtifactExplorationResult> => {
  const output = await input.explorer.explore({
    content: input.content,
    path: input.path,
    mimeType: input.artifact.mimeType,
  });

  return {
    explorerUsed: input.explorer.name,
    summary: output.summary,
    metadata: output.metadata,
    tokenCount: output.tokenCount,
  };
};

export const runArtifactExploration = async (input: {
  readonly artifact: Artifact;
  readonly content: string | Uint8Array;
  readonly explorerRegistry: ExplorerRegistryPort;
  readonly explorerHints?: ExplorerHints;
}): Promise<ArtifactExplorationResult> => {
  const resolved = resolveArtifactExplorer({
    artifact: input.artifact,
    explorerRegistry: input.explorerRegistry,
    ...(input.explorerHints === undefined ? {} : { explorerHints: input.explorerHints }),
  });

  return executeArtifactExploration({
    artifact: input.artifact,
    content: input.content,
    path: resolved.path,
    explorer: resolved.explorer,
  });
};
