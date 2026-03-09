import type { ContextItem } from '../entities/context-item';
import { InvariantViolationError } from '../errors/domain-errors';
import type { EventId, SummaryNodeId } from '../value-objects/ids';
import { createTokenCount, type TokenCount } from '../value-objects/token-count';

export interface ContextItemWithTokens {
  readonly item: ContextItem;
  readonly tokenCount: TokenCount;
  readonly role?: 'system' | 'user' | 'assistant' | 'tool';
}

export type PinRule =
  | { readonly kind: 'position'; readonly position: number }
  | { readonly kind: 'summary'; readonly summaryId: SummaryNodeId }
  | { readonly kind: 'message'; readonly messageId: EventId };

export interface CompactionCandidate {
  readonly items: readonly ContextItemWithTokens[];
  readonly tokenCount: TokenCount;
}

export interface CompactionPolicyConfig {
  readonly blockTokenTargetFraction: number;
  readonly minBlockSize: number;
  readonly tailWindowSize: number;
}

export interface CompactionPolicyService {
  selectCandidates(
    contextItems: readonly ContextItemWithTokens[],
    pinRules: readonly PinRule[],
    availableBudget: TokenCount,
  ): readonly CompactionCandidate[];
  shouldEscalate(inputTokens: TokenCount, outputTokens: TokenCount): boolean;
}

const DEFAULT_CONFIG: CompactionPolicyConfig = {
  blockTokenTargetFraction: 0.25,
  minBlockSize: 2,
  tailWindowSize: 3,
};

const assertConfig = (config: CompactionPolicyConfig): void => {
  if (
    !Number.isFinite(config.blockTokenTargetFraction) ||
    config.blockTokenTargetFraction <= 0 ||
    config.blockTokenTargetFraction > 1
  ) {
    throw new InvariantViolationError('blockTokenTargetFraction must be in (0, 1].');
  }

  if (!Number.isSafeInteger(config.minBlockSize) || config.minBlockSize < 1) {
    throw new InvariantViolationError('minBlockSize must be a positive safe integer.');
  }

  if (!Number.isSafeInteger(config.tailWindowSize) || config.tailWindowSize < 0) {
    throw new InvariantViolationError('tailWindowSize must be a non-negative safe integer.');
  }
};

const assertNonNegativeTokenCount = (tokenCount: TokenCount, label: string): void => {
  if (!Number.isSafeInteger(tokenCount.value) || tokenCount.value < 0) {
    throw new InvariantViolationError(`${label} must be a non-negative safe integer.`);
  }
};

const sortByPosition = (
  contextItems: readonly ContextItemWithTokens[],
): readonly ContextItemWithTokens[] => {
  return [...contextItems].sort((left, right) => left.item.position - right.item.position);
};

const isPinnedByRule = (itemWithTokens: ContextItemWithTokens, pinRules: readonly PinRule[]): boolean => {
  return pinRules.some((rule) => {
    if (rule.kind === 'position') {
      return itemWithTokens.item.position === rule.position;
    }

    if (rule.kind === 'summary') {
      return (
        itemWithTokens.item.ref.type === 'summary' && itemWithTokens.item.ref.summaryId === rule.summaryId
      );
    }

    return itemWithTokens.item.ref.type === 'message' && itemWithTokens.item.ref.messageId === rule.messageId;
  });
};

const isPinned = (
  itemWithTokens: ContextItemWithTokens,
  pinRules: readonly PinRule[],
  tailStartPosition: number,
): boolean => {
  if (itemWithTokens.role === 'system' && itemWithTokens.item.position === 0) {
    return true;
  }

  if (itemWithTokens.item.position >= tailStartPosition) {
    return true;
  }

  return isPinnedByRule(itemWithTokens, pinRules);
};

export const createCompactionPolicyService = (
  partialConfig?: Partial<CompactionPolicyConfig>,
): CompactionPolicyService => {
  const config: CompactionPolicyConfig = {
    ...DEFAULT_CONFIG,
    ...partialConfig,
  };

  assertConfig(config);

  const service: CompactionPolicyService = {
    selectCandidates: (contextItems, pinRules, availableBudget) => {
      assertNonNegativeTokenCount(availableBudget, 'availableBudget');

      const orderedItems = sortByPosition(contextItems);
      const tailStartPosition = Math.max(0, orderedItems.length - config.tailWindowSize);

      const unpinned = orderedItems.filter((item) => !isPinned(item, pinRules, tailStartPosition));

      if (unpinned.length === 0) {
        return Object.freeze([]);
      }

      const blockTarget = Math.max(
        1,
        Math.floor(availableBudget.value * config.blockTokenTargetFraction),
      );

      const block: ContextItemWithTokens[] = [];
      let blockTokens = 0;

      for (const candidate of unpinned) {
        const previous = block.at(-1);

        if (previous !== undefined && candidate.item.position !== previous.item.position + 1) {
          break;
        }

        block.push(candidate);
        blockTokens += candidate.tokenCount.value;

        if (blockTokens >= blockTarget && block.length >= config.minBlockSize) {
          break;
        }
      }

      if (block.length < config.minBlockSize) {
        return Object.freeze([]);
      }

      return Object.freeze([
        Object.freeze({
          items: Object.freeze([...block]),
          tokenCount: createTokenCount(blockTokens),
        }),
      ]);
    },

    shouldEscalate: (inputTokens, outputTokens) => {
      assertNonNegativeTokenCount(inputTokens, 'inputTokens');
      assertNonNegativeTokenCount(outputTokens, 'outputTokens');
      return outputTokens.value >= inputTokens.value;
    },
  };

  return Object.freeze(service);
};
