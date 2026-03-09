import type { MimeType, TokenCount } from '@ledgermind/domain';

export interface ExplorerHints {
  readonly preferredExplorer?: string;
}

export interface ExplorerInput {
  readonly content: string | Uint8Array;
  readonly path: string;
  readonly mimeType: MimeType;
  readonly maxTokens?: number;
}

export interface ExplorerOutput {
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tokenCount: TokenCount;
}

export interface ExplorerPort {
  readonly name: string;
  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number;
  explore(input: ExplorerInput): Promise<ExplorerOutput>;
}
