import type { TokenizerPort } from '@ledgermind/application';
import { createTokenCount, type TokenCount } from '@ledgermind/domain';

/**
 * Deterministic tokenizer for snapshot-stable tests.
 * Uses a fixed ratio of 1 token ≈ 4 characters/bytes.
 */
export class SimpleTokenizer implements TokenizerPort {
  /**
   * Uses UTF-16 code units (`text.length`) for deterministic counting.
   *
   * For ASCII text, code units align with byte length. For non-ASCII text,
   * small drift versus model tokenization is accepted in Phase 1 to preserve
   * deterministic, snapshot-stable behavior.
   */
  countTokens(text: string): TokenCount {
    return createTokenCount(Math.ceil(text.length / 4));
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(Math.ceil(byteLength / 4));
  }
}
