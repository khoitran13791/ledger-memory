import { InvariantViolationError } from '../errors/domain-errors';
import type { ArtifactId, ConversationId, SummaryNodeId } from '../value-objects/ids';
import { createTimestamp, type Timestamp } from '../value-objects/timestamp';
import type { TokenCount } from '../value-objects/token-count';

export type SummaryKind = 'leaf' | 'condensed';

const SUMMARY_KINDS: readonly SummaryKind[] = ['leaf', 'condensed'];

export const isSummaryKind = (value: string): value is SummaryKind => {
  return SUMMARY_KINDS.includes(value as SummaryKind);
};

export interface SummaryNode {
  readonly id: SummaryNodeId;
  readonly conversationId: ConversationId;
  readonly kind: SummaryKind;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly artifactIds: readonly ArtifactId[];
  readonly createdAt: Timestamp;
}

export interface CreateSummaryNodeInput {
  readonly id: SummaryNodeId;
  readonly conversationId: ConversationId;
  readonly kind: SummaryKind;
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly artifactIds?: readonly ArtifactId[];
  readonly createdAt?: Timestamp;
}

const assertValidSummaryNodeInput = (input: CreateSummaryNodeInput): void => {
  if (!isSummaryKind(input.kind)) {
    throw new InvariantViolationError('SummaryNode.kind must be leaf or condensed.');
  }

  if (!Number.isSafeInteger(input.tokenCount.value) || input.tokenCount.value < 0) {
    throw new InvariantViolationError('SummaryNode.tokenCount must be a non-negative safe integer.');
  }
};

export const createSummaryNode = (input: CreateSummaryNodeInput): SummaryNode => {
  assertValidSummaryNodeInput(input);

  const artifactIds = Object.freeze([...(input.artifactIds ?? [])]) as readonly ArtifactId[];

  return Object.freeze({
    id: input.id,
    conversationId: input.conversationId,
    kind: input.kind,
    content: input.content,
    tokenCount: input.tokenCount,
    artifactIds,
    createdAt: input.createdAt ?? createTimestamp(new Date()),
  });
};
