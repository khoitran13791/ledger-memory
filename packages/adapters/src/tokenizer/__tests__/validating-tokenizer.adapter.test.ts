import type { TokenizerPort } from '@ledgermind/application';
import { InvalidTokenizerOutputError } from '@ledgermind/application';
import { createTokenCount, type TokenCount } from '@ledgermind/domain';
import { describe, expect, it } from 'vitest';

import { ValidatingTokenizerAdapter } from '@ledgermind/adapters';

class ConstantTokenizer implements TokenizerPort {
  constructor(private readonly value: TokenCount) {}

  countTokens(): TokenCount {
    return this.value;
  }

  estimateFromBytes(): TokenCount {
    return this.value;
  }
}

class OutputTokenizer implements TokenizerPort {
  constructor(private readonly output: unknown) {}

  countTokens(): TokenCount {
    return this.output as TokenCount;
  }

  estimateFromBytes(): TokenCount {
    return this.output as TokenCount;
  }
}

class ThrowingTokenizer implements TokenizerPort {
  countTokens(): TokenCount {
    throw new Error('delegate failed while counting');
  }

  estimateFromBytes(): TokenCount {
    throw new Error('delegate failed while estimating bytes');
  }
}

class InvariantThrowingTokenizer implements TokenizerPort {
  countTokens(): TokenCount {
    throw createTokenCount(-1);
  }

  estimateFromBytes(): TokenCount {
    throw createTokenCount(-1);
  }
}

describe('ValidatingTokenizerAdapter', () => {
  it('passes through valid TokenCount outputs unchanged', () => {
    const expected = createTokenCount(7);
    const tokenizer = new ValidatingTokenizerAdapter(new ConstantTokenizer(expected));

    expect(tokenizer.countTokens('hello')).toBe(expected);
    expect(tokenizer.estimateFromBytes(28)).toBe(expected);
  });

  it('wraps null output as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new OutputTokenizer(null));

    expect(() => tokenizer.countTokens('null')).toThrow(InvalidTokenizerOutputError);
  });

  it('wraps undefined output as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new OutputTokenizer(undefined));

    expect(() => tokenizer.countTokens('undefined')).toThrow(InvalidTokenizerOutputError);
  });

  it('wraps negative TokenCount.value as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new OutputTokenizer({ value: -1 }));

    expect(() => tokenizer.countTokens('negative')).toThrow(InvalidTokenizerOutputError);
  });

  it('wraps NaN TokenCount.value as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new OutputTokenizer({ value: Number.NaN }));

    expect(() => tokenizer.countTokens('nan')).toThrow(InvalidTokenizerOutputError);
  });

  it('wraps non-integer TokenCount.value as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new OutputTokenizer({ value: 1.5 }));

    expect(() => tokenizer.countTokens('fractional')).toThrow(InvalidTokenizerOutputError);
  });

  it('wraps object without value field as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new OutputTokenizer({}));

    expect(() => tokenizer.countTokens('shape')).toThrow(InvalidTokenizerOutputError);
  });

  it('wraps unknown delegate throws as InvalidTokenizerOutputError', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new ThrowingTokenizer(), {
      tokenizerName: 'ThrowingTokenizer',
    });

    expect(() => tokenizer.countTokens('boom')).toThrow(InvalidTokenizerOutputError);
    expect(() => tokenizer.estimateFromBytes(100)).toThrow(InvalidTokenizerOutputError);
  });

  it('preserves InvariantViolationError thrown by the delegate', () => {
    const tokenizer = new ValidatingTokenizerAdapter(new InvariantThrowingTokenizer());

    expect(() => tokenizer.countTokens('boom')).toThrow(/TokenCount must be a non-negative safe integer\./);
    expect(() => tokenizer.estimateFromBytes(100)).toThrow(
      /TokenCount must be a non-negative safe integer\./,
    );
    expect(() => tokenizer.countTokens('boom')).not.toThrow(InvalidTokenizerOutputError);
    expect(() => tokenizer.estimateFromBytes(100)).not.toThrow(InvalidTokenizerOutputError);
  });
});
