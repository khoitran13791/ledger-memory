import { describe, expect, it } from 'vitest';

import {
  createContextItem,
  createMessageContextItemRef,
  createSummaryContextItemRef,
} from '../../entities/context-item';
import { InvariantViolationError } from '../../errors/domain-errors';
import {
  createConversationId,
  createEventId,
  createSummaryNodeId,
  type EventId,
  type SummaryNodeId,
} from '../../value-objects/ids';
import { createTokenCount } from '../../value-objects/token-count';
import {
  createCompactionPolicyService,
  type ContextItemWithTokens,
  type PinRule,
} from '../compaction-policy.service';

const conversationId = createConversationId('conv_candidates');

const buildMessageItem = (
  position: number,
  tokenCount: number,
  role?: 'system' | 'user' | 'assistant' | 'tool',
): ContextItemWithTokens => {
  const eventId = createEventId(`evt_${position}`) as EventId;

  const baseItem = {
    item: createContextItem({
      conversationId,
      position,
      ref: createMessageContextItemRef(eventId),
    }),
    tokenCount: createTokenCount(tokenCount),
  };

  if (role === undefined) {
    return baseItem;
  }

  return {
    ...baseItem,
    role,
  };
};

const buildSummaryItem = (position: number, tokenCount: number): ContextItemWithTokens => {
  const summaryId = createSummaryNodeId(`sum_${position}`) as SummaryNodeId;

  return {
    item: createContextItem({
      conversationId,
      position,
      ref: createSummaryContextItemRef(summaryId),
    }),
    tokenCount: createTokenCount(tokenCount),
  };
};

describe('compaction policy service', () => {
  it('selects oldest contiguous non-pinned candidate block up to target tokens', () => {
    const service = createCompactionPolicyService({
      blockTokenTargetFraction: 0.25,
      minBlockSize: 2,
      tailWindowSize: 2,
    });

    const items: readonly ContextItemWithTokens[] = [
      buildMessageItem(0, 10, 'system'),
      buildMessageItem(1, 12, 'user'),
      buildMessageItem(2, 14, 'assistant'),
      buildSummaryItem(3, 20),
      buildMessageItem(4, 16, 'tool'),
      buildMessageItem(5, 18, 'assistant'),
    ];

    const candidates = service.selectCandidates(items, [], createTokenCount(100));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.items.map((entry) => entry.item.position)).toEqual([1, 2]);
    expect(candidates[0]?.tokenCount.value).toBe(26);
  });

  it('respects explicit pin rules and tail window pinning', () => {
    const service = createCompactionPolicyService({
      blockTokenTargetFraction: 0.2,
      minBlockSize: 2,
      tailWindowSize: 3,
    });

    const items: readonly ContextItemWithTokens[] = [
      buildMessageItem(0, 5, 'system'),
      buildMessageItem(1, 8, 'user'),
      buildSummaryItem(2, 9),
      buildMessageItem(3, 10, 'assistant'),
      buildMessageItem(4, 11, 'assistant'),
      buildMessageItem(5, 12, 'assistant'),
    ];

    const pinRules: readonly PinRule[] = [
      { kind: 'position', position: 1 },
      { kind: 'summary', summaryId: createSummaryNodeId('sum_2') },
    ];

    const candidates = service.selectCandidates(items, pinRules, createTokenCount(80));
    expect(candidates).toHaveLength(0);
  });

  it('pins the last three items in ten-item context and selects oldest remaining block', () => {
    const service = createCompactionPolicyService({
      blockTokenTargetFraction: 1,
      minBlockSize: 2,
      tailWindowSize: 3,
    });

    const items: readonly ContextItemWithTokens[] = [
      buildMessageItem(0, 10),
      buildMessageItem(1, 10),
      buildMessageItem(2, 10),
      buildMessageItem(3, 10),
      buildMessageItem(4, 10),
      buildMessageItem(5, 10),
      buildMessageItem(6, 10),
      buildMessageItem(7, 10),
      buildMessageItem(8, 10),
      buildMessageItem(9, 10),
    ];

    const candidates = service.selectCandidates(items, [], createTokenCount(1_000));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.items.map((entry) => entry.item.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(candidates[0]?.tokenCount.value).toBe(70);
  });

  it('respects message pin rules when selecting candidate block', () => {
    const service = createCompactionPolicyService({
      blockTokenTargetFraction: 0.5,
      minBlockSize: 2,
      tailWindowSize: 1,
    });

    const items: readonly ContextItemWithTokens[] = [
      buildMessageItem(0, 5),
      buildMessageItem(1, 5),
      buildMessageItem(2, 5),
      buildMessageItem(3, 5),
      buildMessageItem(4, 5),
      buildMessageItem(5, 5),
    ];

    const pinRules: readonly PinRule[] = [{ kind: 'message', messageId: createEventId('evt_0') }];
    const candidates = service.selectCandidates(items, pinRules, createTokenCount(30));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.items.map((entry) => entry.item.position)).toEqual([1, 2, 3]);
    expect(candidates[0]?.tokenCount.value).toBe(15);
  });

  it('returns no candidates when contiguous block is smaller than minBlockSize', () => {
    const service = createCompactionPolicyService({
      blockTokenTargetFraction: 0.5,
      minBlockSize: 2,
      tailWindowSize: 1,
    });

    const items: readonly ContextItemWithTokens[] = [
      buildMessageItem(0, 10, 'system'),
      buildMessageItem(1, 10, 'user'),
      buildMessageItem(3, 10, 'assistant'),
      buildMessageItem(4, 10, 'assistant'),
    ];

    const pinRules: readonly PinRule[] = [{ kind: 'position', position: 3 }];
    const candidates = service.selectCandidates(items, pinRules, createTokenCount(100));

    expect(candidates).toHaveLength(0);
  });

  it('escalates when output token count does not shrink', () => {
    const service = createCompactionPolicyService();

    expect(service.shouldEscalate(createTokenCount(100), createTokenCount(100))).toBe(true);
    expect(service.shouldEscalate(createTokenCount(100), createTokenCount(120))).toBe(true);
    expect(service.shouldEscalate(createTokenCount(100), createTokenCount(80))).toBe(false);
  });

  it('rejects invalid configuration', () => {
    expect(() => createCompactionPolicyService({ blockTokenTargetFraction: 0 })).toThrow(
      InvariantViolationError,
    );
    expect(() => createCompactionPolicyService({ minBlockSize: 0 })).toThrow(
      InvariantViolationError,
    );
    expect(() => createCompactionPolicyService({ tailWindowSize: -1 })).toThrow(
      InvariantViolationError,
    );
  });
});
