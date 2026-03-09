import { createTokenCount } from '@ledgermind/domain';
/**
 * Deterministic tokenizer for snapshot-stable tests.
 * Uses a fixed ratio of 1 token ≈ 4 characters/bytes.
 */
export class SimpleTokenizer {
    countTokens(text) {
        return createTokenCount(Math.ceil(text.length / 4));
    }
    estimateFromBytes(byteLength) {
        return createTokenCount(Math.ceil(byteLength / 4));
    }
}
//# sourceMappingURL=simple-tokenizer.js.map