import {
  InvalidTokenizerOutputError,
  type TokenizerOperation,
  type TokenizerPort,
} from '@ledgermind/application';
import {
  InvariantViolationError,
  type TokenCount,
} from '@ledgermind/domain';

export interface ValidatingTokenizerAdapterOptions {
  readonly tokenizerName?: string;
}

const describeTokenizerOutput = (output: unknown): string => {
  if (output === null) {
    return 'null';
  }

  if (output === undefined) {
    return 'undefined';
  }

  if (typeof output === 'number') {
    return Number.isNaN(output) ? 'number(NaN)' : `number(${output})`;
  }

  if (typeof output === 'object') {
    if ('value' in output) {
      const rawValue = (output as { readonly value?: unknown }).value;
      if (typeof rawValue === 'number') {
        return Number.isNaN(rawValue)
          ? 'TokenCount.value(number(NaN))'
          : `TokenCount.value(number(${rawValue}))`;
      }
      return `TokenCount.value(${String(rawValue)})`;
    }

    return 'object(without value field)';
  }

  return typeof output;
};

const validateTokenizerTokenCount = (
  output: unknown,
  tokenizer: string,
  operation: TokenizerOperation,
): TokenCount => {
  if (typeof output !== 'object' || output === null || !('value' in output)) {
    throw new InvalidTokenizerOutputError(tokenizer, operation, describeTokenizerOutput(output));
  }

  const tokenValue = (output as { readonly value: unknown }).value;

  if (
    typeof tokenValue !== 'number' ||
    !Number.isFinite(tokenValue) ||
    !Number.isSafeInteger(tokenValue) ||
    tokenValue < 0
  ) {
    throw new InvalidTokenizerOutputError(tokenizer, operation, describeTokenizerOutput(output));
  }

  return output as TokenCount;
};

const describeDelegateFailure = (error: unknown): string => {
  if (error instanceof Error) {
    return `delegate threw ${error.name}: ${error.message}`;
  }

  return `delegate threw ${String(error)}`;
};

/**
 * Adapter-level tokenizer output validation wrapper.
 *
 * Ensures TokenizerPort outputs satisfy TokenCount invariants and normalizes
 * delegate throw paths into InvalidTokenizerOutputError.
 */
export class ValidatingTokenizerAdapter implements TokenizerPort {
  private readonly tokenizerName: string;

  constructor(
    private readonly delegate: TokenizerPort,
    options: ValidatingTokenizerAdapterOptions = {},
  ) {
    const delegateName = delegate.constructor.name;
    this.tokenizerName = options.tokenizerName ?? (delegateName.length > 0 ? delegateName : 'TokenizerPort');
  }

  countTokens(text: string): TokenCount {
    return this.invokeAndValidate(() => this.delegate.countTokens(text), 'countTokens');
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return this.invokeAndValidate(
      () => this.delegate.estimateFromBytes(byteLength),
      'estimateFromBytes',
    );
  }

  private invokeAndValidate(call: () => unknown, operation: TokenizerOperation): TokenCount {
    try {
      const output = call();
      return validateTokenizerTokenCount(output, this.tokenizerName, operation);
    } catch (error) {
      if (error instanceof InvalidTokenizerOutputError) {
        throw error;
      }

      if (error instanceof InvariantViolationError) {
        throw error;
      }

      throw new InvalidTokenizerOutputError(
        this.tokenizerName,
        operation,
        describeDelegateFailure(error),
      );
    }
  }
}
