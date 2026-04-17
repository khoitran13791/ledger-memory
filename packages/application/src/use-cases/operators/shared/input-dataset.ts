import type { ArtifactId } from '@ledgermind/domain';

import {
  ArtifactContentUnavailableError,
  ArtifactNotFoundError,
  OperatorInputValidationError,
} from '../../../errors/application-errors';
import type { ArtifactStorePort } from '../../../ports/driven/persistence/artifact-store.port';
import type { ConversationPort } from '../../../ports/driven/persistence/conversation.port';

const textEncoder = new TextEncoder();

export interface OperatorDatasetSource {
  readonly conversationId: string;
  readonly items?: readonly unknown[];
  readonly inputArtifactId?: ArtifactId;
}

export interface LoadedOperatorDataset {
  readonly items: readonly unknown[];
  readonly canonicalDatasetJson: string;
}

const canonicalizeOperatorItems = (items: readonly unknown[]): LoadedOperatorDataset => {
  const canonicalDatasetJson = JSON.stringify(items);
  const parsed = JSON.parse(canonicalDatasetJson) as unknown;

  if (!Array.isArray(parsed)) {
    throw new OperatorInputValidationError('Operator dataset items must be a JSON array.');
  }

  return {
    items: parsed,
    canonicalDatasetJson,
  };
};

export const getOperatorDatasetByteLength = (canonicalDatasetJson: string): number => {
  return textEncoder.encode(canonicalDatasetJson).byteLength;
};

export const validateOperatorDatasetSource = (input: OperatorDatasetSource): void => {
  const hasInlineItems = input.items !== undefined;
  const hasArtifactInput = input.inputArtifactId !== undefined;

  if (hasInlineItems === hasArtifactInput) {
    throw new OperatorInputValidationError('Exactly one of items or inputArtifactId is required.');
  }

  if (input.items !== undefined && !Array.isArray(input.items)) {
    throw new OperatorInputValidationError('Operator dataset items must be a JSON array.');
  }
};

export const loadOperatorDataset = async (
  input: OperatorDatasetSource,
  deps: {
    readonly artifactStore: ArtifactStorePort;
    readonly conversations?: ConversationPort;
  },
  options?: {
    readonly maxInlineOperatorInputBytes?: number;
  },
): Promise<LoadedOperatorDataset> => {
  validateOperatorDatasetSource(input);
  void deps.conversations;

  if (input.items !== undefined) {
    const dataset = canonicalizeOperatorItems(input.items);

    if (
      options?.maxInlineOperatorInputBytes !== undefined &&
      getOperatorDatasetByteLength(dataset.canonicalDatasetJson) > options.maxInlineOperatorInputBytes
    ) {
      throw new OperatorInputValidationError('Inline operator dataset exceeds maxInlineOperatorInputBytes.');
    }

    return dataset;
  }

  const artifactId = input.inputArtifactId;
  if (artifactId === undefined) {
    throw new OperatorInputValidationError('Missing inputArtifactId for artifact-backed dataset load.');
  }

  const artifact = await deps.artifactStore.getMetadata(artifactId);
  if (artifact === null) {
    throw new ArtifactNotFoundError(artifactId);
  }

  if (artifact.conversationId !== input.conversationId) {
    throw new OperatorInputValidationError('Operator input artifact must belong to the same conversation.');
  }

  const content = await deps.artifactStore.getContent(artifactId);
  if (typeof content !== 'string') {
    throw new ArtifactContentUnavailableError(artifactId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new OperatorInputValidationError('Operator input artifact payload must be one JSON array.');
  }

  if (!Array.isArray(parsed)) {
    throw new OperatorInputValidationError('Operator input artifact payload must be one JSON array.');
  }

  return canonicalizeOperatorItems(parsed);
};
