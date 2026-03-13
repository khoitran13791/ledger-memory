import type { ArtifactId, SummaryNodeId } from '@ledgermind/domain';

import { InvalidReferenceError } from '../errors/application-errors';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import type {
  DescribeArtifactPlanningSignals,
  DescribeInput,
  DescribeOutput,
  DescribeSummaryPlanningSignals,
  Metadata,
} from '../ports/driving/memory-engine.port';

const EVIDENCE_ID_PATTERN = /D\d+:\d+/gi;

const toNormalizedList = (values: readonly string[]): readonly string[] => {
  return Object.freeze(
    [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))],
  );
};

const extractEvidenceIds = (text: string): readonly string[] => {
  return toNormalizedList(
    [...text.matchAll(EVIDENCE_ID_PATTERN)]
      .map((match) => match[0]?.trim().toUpperCase())
      .filter((value): value is string => value !== undefined && value.length > 0),
  );
};

const parseStructuredSummaryList = (content: string, label: string): readonly string[] => {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, 'im'));
  const rawValue = match?.[1]?.trim();
  if (rawValue === undefined || rawValue.length === 0 || rawValue === '-') {
    return [];
  }

  return toNormalizedList(rawValue.split(/\s*;\s*/));
};

const parseFactAnchors = (content: string): readonly string[] => {
  return toNormalizedList(
    [...content.matchAll(/\|\s*anchor:([^|\n]+)/gi)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => value !== undefined && value.length > 0 && value !== '-'),
  );
};

const extractArtifactAnchors = (summary: string): readonly string[] => {
  const normalizedSummary = summary.toLowerCase();
  if (normalizedSummary.length === 0) {
    return [];
  }

  const candidateFields = [
    'path=',
    'title=',
    'schema=',
    'table=',
    'host=',
    'query=',
    'anchor=',
    'endpoint=',
    'key=',
    'id=',
  ] as const;

  const extracted: string[] = [];
  for (const field of candidateFields) {
    const pattern = new RegExp(`${field}([^|;\\n]+)`, 'gi');
    for (const match of summary.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value === undefined || value.length === 0) {
        continue;
      }

      if (/^file_[a-z0-9]+$/i.test(value)) {
        continue;
      }

      if (/^D\d+:\d+$/i.test(value)) {
        continue;
      }

      extracted.push(value);
    }
  }

  return toNormalizedList(extracted);
};

const createSummaryMetadata = (content: string): Metadata => {
  return Object.freeze({ content });
};

const createSummaryPlanningSignals = (content: string): DescribeSummaryPlanningSignals => {
  const lexicalAnchors = toNormalizedList([
    ...parseStructuredSummaryList(content, 'lexical_anchors'),
    ...parseFactAnchors(content),
  ]);

  return Object.freeze({
    entities: parseStructuredSummaryList(content, 'entities'),
    dates: parseStructuredSummaryList(content, 'dates'),
    commitments: parseStructuredSummaryList(content, 'commitments'),
    outcomes: parseStructuredSummaryList(content, 'outcomes'),
    lexicalAnchors,
    evidenceIds: extractEvidenceIds(content),
  });
};

const createArtifactMetadata = (originalPath: string | null, explorerUsed: string | null): Metadata => {
  return Object.freeze({
    ...(originalPath === null ? {} : { originalPath }),
    ...(explorerUsed === null ? {} : { explorerUsed }),
  });
};

const createArtifactPlanningSignals = (input: {
  readonly originalPath: string | null;
  readonly explorerUsed: string | null;
  readonly explorationSummary: string | null;
}): DescribeArtifactPlanningSignals => {
  const explorationSummary = input.explorationSummary ?? '';

  return Object.freeze({
    ...(input.originalPath === null ? {} : { originalPath: input.originalPath }),
    ...(input.explorerUsed === null ? {} : { explorerUsed: input.explorerUsed }),
    hasExplorationSummary: explorationSummary.trim().length > 0,
    lexicalAnchors: extractArtifactAnchors(explorationSummary),
    evidenceIds: extractEvidenceIds(explorationSummary),
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
        planningSignals: createSummaryPlanningSignals(summaryNode.content),
        ...(parentIds.length > 0 ? { parentIds } : {}),
      };
    }

    const artifact = await this.deps.artifactStore.getMetadata(input.id as ArtifactId);
    if (artifact) {
      return {
        kind: 'artifact',
        metadata: createArtifactMetadata(artifact.originalPath, artifact.explorerUsed),
        tokenCount: artifact.tokenCount,
        planningSignals: createArtifactPlanningSignals({
          originalPath: artifact.originalPath,
          explorerUsed: artifact.explorerUsed,
          explorationSummary: artifact.explorationSummary,
        }),
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
