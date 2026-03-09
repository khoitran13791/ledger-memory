import type { ArtifactId, SummaryNodeId } from '@ledgermind/domain';

import { InvalidReferenceError } from '../errors/application-errors';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import type { DescribeInput, DescribeOutput, Metadata } from '../ports/driving/memory-engine.port';

const createSummaryMetadata = (content: string): Metadata => {
  return Object.freeze({ content });
};

const createArtifactMetadata = (originalPath: string | null, explorerUsed: string | null): Metadata => {
  return Object.freeze({
    ...(originalPath === null ? {} : { originalPath }),
    ...(explorerUsed === null ? {} : { explorerUsed }),
  });
};

export interface DescribeUseCaseDeps {
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
}

export class DescribeUseCase {
  constructor(private readonly deps: DescribeUseCaseDeps) {}

  async execute(input: DescribeInput): Promise<DescribeOutput> {
    const summaryNode = await this.deps.summaryDag.getNode(input.id as SummaryNodeId);
    if (summaryNode) {
      const parentIds = await this.deps.summaryDag.getParentSummaryIds(input.id as SummaryNodeId);
      return {
        kind: 'summary',
        metadata: createSummaryMetadata(summaryNode.content),
        tokenCount: summaryNode.tokenCount,
        ...(parentIds.length > 0 ? { parentIds } : {}),
      };
    }

    const artifact = await this.deps.artifactStore.getMetadata(input.id as ArtifactId);
    if (artifact) {
      return {
        kind: 'artifact',
        metadata: createArtifactMetadata(artifact.originalPath, artifact.explorerUsed),
        tokenCount: artifact.tokenCount,
        ...(artifact.explorationSummary === null
          ? {}
          : {
              explorationSummary: artifact.explorationSummary,
            }),
      };
    }

    throw new InvalidReferenceError('summary_or_artifact', input.id);
  }
}
