import { describe, expect, it } from 'vitest';

import { InvariantViolationError } from '../../errors/domain-errors';
import { createCompactionThresholds } from '../../value-objects/compaction-thresholds';
import { createConversationId } from '../../value-objects/ids';
import { createTokenCount } from '../../value-objects/token-count';
import { createConversation, createConversationConfig } from '../conversation';

describe('conversation entity', () => {
  it('creates conversation config and conversation with valid values', () => {
    const config = createConversationConfig({
      modelName: 'claude-opus-4-6',
      contextWindow: createTokenCount(128_000),
      thresholds: createCompactionThresholds(0.6, 1),
    });

    const conversation = createConversation({
      id: createConversationId('conv_1'),
      parentId: null,
      config,
    });

    expect(conversation.id).toBe('conv_1');
    expect(conversation.parentId).toBeNull();
    expect(conversation.config.contextWindow.value).toBe(128_000);
    expect(conversation.config.thresholds.soft).toBe(0.6);
    expect(Object.isFrozen(conversation)).toBe(true);
  });

  it('rejects blank model name', () => {
    expect(() =>
      createConversationConfig({
        modelName: '   ',
        contextWindow: createTokenCount(100),
        thresholds: createCompactionThresholds(0.6, 1),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects non-positive context window', () => {
    expect(() =>
      createConversationConfig({
        modelName: 'claude-opus-4-6',
        contextWindow: createTokenCount(0),
        thresholds: createCompactionThresholds(0.6, 1),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects invalid threshold ordering', () => {
    expect(() =>
      createConversationConfig({
        modelName: 'claude-opus-4-6',
        contextWindow: createTokenCount(100),
        thresholds: { soft: 0.8, hard: 0.7 },
      }),
    ).toThrow(InvariantViolationError);
  });
});
