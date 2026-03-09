import type {
  SummarizationInput,
  SummarizationOutput,
  SummarizerPort,
  TokenizerPort,
} from '@ledgermind/application';

/**
 * Deterministic summarizer adapter for replay-stable behavior.
 * - normal: keeps ~60% of source content
 * - aggressive: keeps ~30% of source content
 */
export class DeterministicSummarizerAdapter implements SummarizerPort {
  constructor(private readonly tokenizer: TokenizerPort) {}

  async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
    const joined = input.messages.map((message) => message.content).join('\n');
    const modeConfig =
      input.mode === 'normal'
        ? { fraction: 0.6, prefix: '[Summary] ' }
        : { fraction: 0.3, prefix: '[Aggressive Summary] ' };

    const target = Math.floor(joined.length * modeConfig.fraction);
    const cutoff = joined.lastIndexOf(' ', target);
    const sliceEnd = cutoff > 0 ? cutoff : target;
    const content = `${modeConfig.prefix}${joined.substring(0, sliceEnd)}`;

    return {
      content,
      tokenCount: this.tokenizer.countTokens(content),
      preservedArtifactIds: input.artifactIdsToPreserve,
    };
  }
}
