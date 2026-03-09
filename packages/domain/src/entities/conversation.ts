import { InvariantViolationError } from '../errors/domain-errors';
import type { CompactionThresholds } from '../value-objects/compaction-thresholds';
import type { ConversationId } from '../value-objects/ids';
import { createTimestamp, type Timestamp } from '../value-objects/timestamp';
import type { TokenCount } from '../value-objects/token-count';

export interface ConversationConfig {
  readonly modelName: string;
  readonly contextWindow: TokenCount;
  readonly thresholds: CompactionThresholds;
}

export interface Conversation {
  readonly id: ConversationId;
  readonly parentId: ConversationId | null;
  readonly config: ConversationConfig;
  readonly createdAt: Timestamp;
}

export interface CreateConversationConfigInput {
  readonly modelName: string;
  readonly contextWindow: TokenCount;
  readonly thresholds: CompactionThresholds;
}

export interface CreateConversationInput {
  readonly id: ConversationId;
  readonly parentId?: ConversationId | null;
  readonly config: ConversationConfig;
  readonly createdAt?: Timestamp;
}

const assertValidConversationConfig = (config: ConversationConfig): void => {
  if (config.modelName.trim().length === 0) {
    throw new InvariantViolationError('ConversationConfig.modelName must be a non-empty string.');
  }

  if (!Number.isSafeInteger(config.contextWindow.value) || config.contextWindow.value <= 0) {
    throw new InvariantViolationError(
      'ConversationConfig.contextWindow must be a positive safe integer token count.',
    );
  }

  if (!Number.isFinite(config.thresholds.soft) || !Number.isFinite(config.thresholds.hard)) {
    throw new InvariantViolationError('ConversationConfig thresholds must be finite numbers.');
  }

  if (
    config.thresholds.soft <= 0 ||
    config.thresholds.hard <= 0 ||
    config.thresholds.soft >= config.thresholds.hard
  ) {
    throw new InvariantViolationError(
      'ConversationConfig thresholds must satisfy 0 < soft < hard.',
    );
  }
};

export const createConversationConfig = (
  input: CreateConversationConfigInput,
): ConversationConfig => {
  const config: ConversationConfig = {
    modelName: input.modelName,
    contextWindow: input.contextWindow,
    thresholds: input.thresholds,
  };

  assertValidConversationConfig(config);

  return Object.freeze(config);
};

export const createConversation = (input: CreateConversationInput): Conversation => {
  assertValidConversationConfig(input.config);

  const config = Object.freeze({
    modelName: input.config.modelName,
    contextWindow: input.config.contextWindow,
    thresholds: input.config.thresholds,
  });

  return Object.freeze({
    id: input.id,
    parentId: input.parentId ?? null,
    config,
    createdAt: input.createdAt ?? createTimestamp(new Date()),
  });
};
