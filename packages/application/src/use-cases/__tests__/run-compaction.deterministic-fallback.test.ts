import { describe, expect, it } from 'vitest';

import { createTokenCount } from '@ledgermind/domain';

import {
  applyDeterministicFallback,
  DETERMINISTIC_FALLBACK_MARKER,
} from '../run-compaction';

const countTokensByWords = (text: string) => {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return createTokenCount(0);
  }

  return createTokenCount(trimmed.split(/\s+/u).length);
};

describe('applyDeterministicFallback', () => {
  it('returns content unchanged when it is already within max token budget', () => {
    const content = 'short input that fits the budget';

    const output = applyDeterministicFallback({
      content,
      maxTokens: 20,
      countTokens: countTokensByWords,
    });

    expect(output).toBe(content);
  });

  it('counts truncation marker tokens inside max token budget', () => {
    const content = Array.from({ length: 300 }, () => 'segment').join(' ');

    const output = applyDeterministicFallback({
      content,
      maxTokens: 12,
      countTokens: countTokensByWords,
    });

    expect(output.includes(DETERMINISTIC_FALLBACK_MARKER)).toBe(true);
    expect(countTokensByWords(output).value).toBeLessThanOrEqual(12);
  });

  it.each([
    ['empty', ''],
    ['short', 'hello world'],
    ['long repeated', Array.from({ length: 300 }, () => 'segment').join(' ')],
    ['unicode', Array.from({ length: 300 }, () => 'xin chào').join(' ')],
    ['no whitespace', `prefix-${'x'.repeat(4000)}`],
    [
      'near marker boundary',
      `${Array.from({ length: 20 }, () => 'context').join(' ')} ${'y'.repeat(120)}`,
    ],
  ])('is deterministic and bounded for %s inputs', (_, content) => {
    const maxTokens = 16;

    const first = applyDeterministicFallback({
      content,
      maxTokens,
      countTokens: countTokensByWords,
    });
    const second = applyDeterministicFallback({
      content,
      maxTokens,
      countTokens: countTokensByWords,
    });

    expect(first).toBe(second);
    expect(countTokensByWords(first).value).toBeLessThanOrEqual(maxTokens);
  });

  it('falls back to marker-only output when content and marker both exceed tiny budget', () => {
    const content = Array.from({ length: 300 }, () => 'segment').join(' ');

    const output = applyDeterministicFallback({
      content,
      maxTokens: 1,
      countTokens: countTokensByWords,
    });

    expect(output.length).toBeGreaterThan(0);
    expect(countTokensByWords(output).value).toBeLessThanOrEqual(1);
  });
});
