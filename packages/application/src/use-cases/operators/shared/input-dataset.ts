import type { ArtifactId } from '@ledgermind/domain';

import { ArtifactContentUnavailableError, ArtifactNotFoundError, OperatorInputValidationError } from '../../../errors/application-errors';
import type { ArtifactStorePort } from '../../../ports/driven/persistence/artifact-store.port';
import type { ConversationPort } from '../../../ports/driven/persistence/conversation.port';

export interface OperatorDatasetSource {
  readonly conversationId: string;
  readonly items?: readonly unknown[];
  readonly inputArtifactId?: ArtifactId;
}

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
    readonly conversations: ConversationPort;
  },
): Promise<readonly unknown[]> => {
  validateOperatorDatasetSource(input);

  if (input.items !== undefined) {
    return input.items;
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

  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new OperatorInputValidationError('Operator input artifact payload must be one JSON array.');
  }

  return parsed;
};
