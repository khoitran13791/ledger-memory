import type { MimeType } from '@ledgermind/domain';

import type { ExplorerHints, ExplorerPort } from './explorer.port';

export interface ExplorerRegistryPort {
  register(explorer: ExplorerPort): void;
  resolve(mimeType: MimeType, path: string, hints?: ExplorerHints): ExplorerPort;
}
