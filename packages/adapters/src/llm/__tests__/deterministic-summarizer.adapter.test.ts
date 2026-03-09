import { describe, expect, it } from 'vitest';

import { DeterministicSummarizerAdapter, SimpleTokenizerAdapter } from '@ledgermind/adapters';
import { createArtifactId } from '@ledgermind/domain';

describe('DeterministicSummarizerAdapter', () => {
  const tokenizer = new SimpleTokenizerAdapter();
  const summarizer = new DeterministicSummarizerAdapter(tokenizer);

  const messages = [
    { role: 'user' as const, content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' },
    { role: 'assistant' as const, content: 'lambda mu nu xi omicron pi rho sigma tau upsilon' },
  ];

  it('produces deterministic normal summaries with expected prefix and preserved artifacts', async () => {
    const artifactIds = [createArtifactId('file_artifact_normal')];

    const output = await summarizer.summarize({
      messages,
      mode: 'normal',
      artifactIdsToPreserve: artifactIds,
    });

    expect(output.content.startsWith('[Summary] ')).toBe(true);
    expect(output.preservedArtifactIds).toEqual(artifactIds);
    expect(output.tokenCount.value).toBe(tokenizer.countTokens(output.content).value);
  });

  it('produces deterministic aggressive summaries that are not longer than normal summaries', async () => {
    const normalOutput = await summarizer.summarize({
      messages,
      mode: 'normal',
      artifactIdsToPreserve: [],
    });

    const aggressiveOutput = await summarizer.summarize({
      messages,
      mode: 'aggressive',
      artifactIdsToPreserve: [],
    });

    expect(aggressiveOutput.content.startsWith('[Aggressive Summary] ')).toBe(true);
    expect(aggressiveOutput.tokenCount.value).toBeLessThanOrEqual(normalOutput.tokenCount.value);
  });
});
