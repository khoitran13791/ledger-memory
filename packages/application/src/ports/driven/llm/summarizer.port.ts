import type { ArtifactId, MessageRole, TokenCount } from '@ledgermind/domain';

export type SummarizationMode = 'normal' | 'aggressive';

export interface SummarizationMessage {
  readonly role: MessageRole;
  readonly content: string;
}

export interface SummarizationInput {
  readonly messages: readonly SummarizationMessage[];
  readonly mode: SummarizationMode;
  readonly targetTokens?: number;
  readonly artifactIdsToPreserve: readonly ArtifactId[];
}

export interface SummarizationOutput {
  readonly content: string;
  readonly tokenCount: TokenCount;
  readonly preservedArtifactIds: readonly ArtifactId[];
}

export interface SummarizerPort {
  summarize(input: SummarizationInput): Promise<SummarizationOutput>;
}
