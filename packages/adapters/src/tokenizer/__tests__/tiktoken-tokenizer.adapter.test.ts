import { InvariantViolationError } from '@ledgermind/domain';
import { describe, expect, it } from 'vitest';

import { TiktokenTokenizerAdapter } from '@ledgermind/adapters';

describe('TiktokenTokenizerAdapter', () => {
  const tokenizer = new TiktokenTokenizerAdapter();

  it('counts tokens using exact-match fixtures for default model family', () => {
    const fixtures = [
      { text: '', expected: 0 },
      { text: 'hello', expected: 1 },
      { text: 'The quick brown fox jumps over the lazy dog.', expected: 10 },
      { text: 'こんにちは世界', expected: 2 },
      { text: 'const x = 42;\nconsole.log(x);', expected: 10 },
      { text: '😀 emoji test', expected: 3 },
    ] as const;

    for (const fixture of fixtures) {
      expect(tokenizer.countTokens(fixture.text)).toEqual({ value: fixture.expected });
    }
  });

  it('returns a positive token count for common text', () => {
    expect(tokenizer.countTokens('hello world').value).toBeGreaterThan(0);
  });

  it('returns zero tokens for empty text', () => {
    expect(tokenizer.countTokens('')).toEqual({ value: 0 });
  });

  it('returns zero for zero-byte estimate', () => {
    expect(tokenizer.estimateFromBytes(0)).toEqual({ value: 0 });
  });

  it('throws invariant error for invalid byteLength inputs', () => {
    expect(() => tokenizer.estimateFromBytes(-1)).toThrow(InvariantViolationError);
    expect(() => tokenizer.estimateFromBytes(Number.NaN)).toThrow(InvariantViolationError);
    expect(() => tokenizer.estimateFromBytes(1.5)).toThrow(InvariantViolationError);
  });

  it('is monotonic for larger text samples', () => {
    expect(tokenizer.countTokens('hello').value).toBeLessThanOrEqual(
      tokenizer.countTokens('hello world foo bar').value,
    );
  });

  it('provides deterministic non-negative estimates from bytes', () => {
    expect(tokenizer.estimateFromBytes(1).value).toBeGreaterThanOrEqual(0);
    expect(tokenizer.estimateFromBytes(5).value).toBeGreaterThanOrEqual(0);

    const first = tokenizer.estimateFromBytes(1234);
    const second = tokenizer.estimateFromBytes(1234);
    expect(first).toEqual(second);
  });

  it('estimates bytes consistently for larger inputs', () => {
    const small = tokenizer.estimateFromBytes(8192);
    const large = tokenizer.estimateFromBytes(16384);

    expect(small.value).toBeGreaterThan(0);
    expect(large.value).toBeGreaterThanOrEqual(small.value);
  });

  it('returns a positive estimate for very large byte sizes', () => {
    expect(tokenizer.estimateFromBytes(100000).value).toBeGreaterThan(0);
  });
});
