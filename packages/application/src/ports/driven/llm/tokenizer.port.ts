import type { TokenCount } from '@ledgermind/domain';

export interface TokenizerPort {
  countTokens(text: string): TokenCount;
  estimateFromBytes(byteLength: number): TokenCount;
}
