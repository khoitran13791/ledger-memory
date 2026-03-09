import type { TokenizerPort } from '@ledgermind/application';
import { type TokenCount } from '@ledgermind/domain';
/**
 * Deterministic tokenizer for snapshot-stable tests.
 * Uses a fixed ratio of 1 token ≈ 4 characters/bytes.
 */
export declare class SimpleTokenizer implements TokenizerPort {
    countTokens(text: string): TokenCount;
    estimateFromBytes(byteLength: number): TokenCount;
}
//# sourceMappingURL=simple-tokenizer.d.ts.map