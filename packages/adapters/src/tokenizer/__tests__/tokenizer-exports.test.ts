import { describe, expect, it } from 'vitest';

import {
  SimpleTokenizerAdapter,
  TiktokenTokenizerAdapter,
  ValidatingTokenizerAdapter,
} from '@ledgermind/adapters';

describe('tokenizer public exports', () => {
  it('exposes tokenizer adapters from @ledgermind/adapters root', () => {
    const simple = new SimpleTokenizerAdapter();
    const tiktoken = new TiktokenTokenizerAdapter();
    const validating = new ValidatingTokenizerAdapter(simple);

    expect(simple.countTokens('abcd')).toEqual({ value: 1 });
    expect(tiktoken.countTokens('hello').value).toBeGreaterThanOrEqual(0);
    expect(validating.countTokens('abcd')).toEqual({ value: 1 });
  });
});
