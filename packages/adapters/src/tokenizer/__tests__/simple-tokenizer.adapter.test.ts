import { describe, expect, it } from 'vitest';

import { SimpleTokenizerAdapter } from '@ledgermind/adapters';

describe('SimpleTokenizerAdapter', () => {
  it('counts tokens using a deterministic 1:4 character ratio', () => {
    const tokenizer = new SimpleTokenizerAdapter();

    expect(tokenizer.countTokens('')).toEqual({ value: 0 });
    expect(tokenizer.countTokens('ab')).toEqual({ value: 1 });
    expect(tokenizer.countTokens('abcd')).toEqual({ value: 1 });
    expect(tokenizer.countTokens('abcde')).toEqual({ value: 2 });
  });

  it('estimates tokens from bytes using the same deterministic ratio', () => {
    const tokenizer = new SimpleTokenizerAdapter();

    expect(tokenizer.estimateFromBytes(0)).toEqual({ value: 0 });
    expect(tokenizer.estimateFromBytes(4)).toEqual({ value: 1 });
    expect(tokenizer.estimateFromBytes(5)).toEqual({ value: 2 });
  });

  it('keeps ASCII byte and text estimates consistent', () => {
    const tokenizer = new SimpleTokenizerAdapter();
    const text = 'The quick brown fox';

    expect(tokenizer.countTokens(text).value).toBe(tokenizer.estimateFromBytes(text.length).value);
  });
});
