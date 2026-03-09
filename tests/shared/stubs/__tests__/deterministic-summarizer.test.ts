import { describe, expect, it } from 'vitest';

import { DeterministicSummarizer, SimpleTokenizer } from '@ledgermind/adapters';
import { createArtifactId } from '@ledgermind/domain';

describe('DeterministicSummarizer', () => {
  const tokenizer = new SimpleTokenizer();
  const summarizer = new DeterministicSummarizer(tokenizer);

  const messages = [
    { role: 'user' as const, content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' },
    { role: 'assistant' as const, content: 'lambda mu nu xi omicron pi rho sigma tau upsilon' },
  ];

  it('produces deterministic normal summaries with artifact passthrough', async () => {
    const artifactIds = [createArtifactId('file_alpha')];

    const first = await summarizer.summarize({
      messages,
      mode: 'normal',
      artifactIdsToPreserve: artifactIds,
    });

    const second = await summarizer.summarize({
      messages,
      mode: 'normal',
      artifactIdsToPreserve: artifactIds,
    });

    expect(first).toEqual(second);
    expect(first.content.startsWith('[Summary] ')).toBe(true);
    expect(first.preservedArtifactIds).toEqual(artifactIds);
    expect(first.tokenCount.value).toBe(tokenizer.countTokens(first.content).value);
  });

  it('produces deterministic aggressive summaries that are no longer than normal summaries', async () => {
    const normal = await summarizer.summarize({
      messages,
      mode: 'normal',
      artifactIdsToPreserve: [],
    });

    const aggressive = await summarizer.summarize({
      messages,
      mode: 'aggressive',
      artifactIdsToPreserve: [],
    });

    expect(aggressive.content.startsWith('[Aggressive Summary] ')).toBe(true);
    expect(aggressive.content.length).toBeLessThanOrEqual(normal.content.length);
  });
});
