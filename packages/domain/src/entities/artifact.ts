import { InvariantViolationError } from '../errors/domain-errors';
import type { ArtifactId, ConversationId } from '../value-objects/ids';
import type { MimeType } from '../value-objects/mime-type';
import type { TokenCount } from '../value-objects/token-count';

export type StorageKind = 'path' | 'inline_text' | 'inline_binary';

const STORAGE_KINDS: readonly StorageKind[] = ['path', 'inline_text', 'inline_binary'];

export const isStorageKind = (value: string): value is StorageKind => {
  return STORAGE_KINDS.includes(value as StorageKind);
};

export interface Artifact {
  readonly id: ArtifactId;
  readonly conversationId: ConversationId;
  readonly storageKind: StorageKind;
  readonly originalPath: string | null;
  readonly mimeType: MimeType;
  readonly tokenCount: TokenCount;
  readonly explorationSummary: string | null;
  readonly explorerUsed: string | null;
}

export interface CreateArtifactInput {
  readonly id: ArtifactId;
  readonly conversationId: ConversationId;
  readonly storageKind: StorageKind;
  readonly originalPath?: string | null;
  readonly mimeType: MimeType;
  readonly tokenCount: TokenCount;
  readonly explorationSummary?: string | null;
  readonly explorerUsed?: string | null;
}

const assertValidTokenCount = (tokenCount: TokenCount): void => {
  if (!Number.isSafeInteger(tokenCount.value) || tokenCount.value < 0) {
    throw new InvariantViolationError('Artifact.tokenCount must be a non-negative safe integer.');
  }
};

const assertValidStorage = (storageKind: StorageKind, originalPath: string | null): void => {
  if (!isStorageKind(storageKind)) {
    throw new InvariantViolationError('Artifact.storageKind must be path, inline_text, or inline_binary.');
  }

  if (storageKind === 'path' && (originalPath === null || originalPath.trim().length === 0)) {
    throw new InvariantViolationError(
      'Artifact.originalPath must be non-empty when storageKind is path.',
    );
  }
};

export const createArtifact = (input: CreateArtifactInput): Artifact => {
  const originalPath = input.originalPath ?? null;

  assertValidTokenCount(input.tokenCount);
  assertValidStorage(input.storageKind, originalPath);

  return Object.freeze({
    id: input.id,
    conversationId: input.conversationId,
    storageKind: input.storageKind,
    originalPath,
    mimeType: input.mimeType,
    tokenCount: input.tokenCount,
    explorationSummary: input.explorationSummary ?? null,
    explorerUsed: input.explorerUsed ?? null,
  });
};
