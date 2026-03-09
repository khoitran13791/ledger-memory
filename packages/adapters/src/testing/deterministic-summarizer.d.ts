import type { SummarizationInput, SummarizationOutput, SummarizerPort, TokenizerPort } from '@ledgermind/application';
/**
 * Deterministic summarizer for replay-stable tests.
 * - normal: keeps ~60% of source content
 * - aggressive: keeps ~30% of source content
 */
export declare class DeterministicSummarizer implements SummarizerPort {
    private readonly tokenizer;
    constructor(tokenizer: TokenizerPort);
    summarize(input: SummarizationInput): Promise<SummarizationOutput>;
}
//# sourceMappingURL=deterministic-summarizer.d.ts.map