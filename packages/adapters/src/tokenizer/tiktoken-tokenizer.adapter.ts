import type { TokenizerPort } from '@ledgermind/application';
import {
  InvariantViolationError,
  createTokenCount,
  type TokenCount,
} from '@ledgermind/domain';

import { encoding_for_model, type TiktokenModel } from 'tiktoken';

const DEFAULT_MODEL: TiktokenModel = 'gpt-4o-mini';
const ESTIMATION_SAMPLE_BYTES = 8192;
const ESTIMATION_SAMPLE_TEXT = 'a'.repeat(ESTIMATION_SAMPLE_BYTES);

export interface TiktokenTokenizerAdapterOptions {
  readonly model?: TiktokenModel;
}

/**
 * Model-aligned tokenizer adapter backed by tiktoken.
 * Defaults to the predefined Phase 1 model family.
 */
export class TiktokenTokenizerAdapter implements TokenizerPort {
  private readonly encoder: ReturnType<typeof encoding_for_model>;
  private readonly sampleTokenCount: number;

  constructor(options: TiktokenTokenizerAdapterOptions = {}) {
    this.encoder = encoding_for_model(options.model ?? DEFAULT_MODEL);
    this.sampleTokenCount = this.encoder.encode(ESTIMATION_SAMPLE_TEXT).length;
  }

  countTokens(text: string): TokenCount {
    return createTokenCount(this.encoder.encode(text).length);
  }

  estimateFromBytes(byteLength: number): TokenCount {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new InvariantViolationError(
        'estimateFromBytes: byteLength must be a non-negative safe integer.',
      );
    }

    if (byteLength === 0) {
      return createTokenCount(0);
    }

    if (byteLength <= ESTIMATION_SAMPLE_BYTES) {
      return createTokenCount(this.encoder.encode('a'.repeat(byteLength)).length);
    }

    return createTokenCount(
      Math.ceil((byteLength / ESTIMATION_SAMPLE_BYTES) * this.sampleTokenCount),
    );
  }
}
