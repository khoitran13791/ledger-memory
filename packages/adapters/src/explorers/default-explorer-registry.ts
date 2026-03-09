import type { ExplorerRegistryPort, TokenizerPort } from '@ledgermind/application';

import { ExplorerRegistry } from './explorer-registry';
import { FallbackExplorer } from './fallback-explorer';
import { JsonExplorer } from './json-explorer';
import { MarkdownExplorer } from './markdown-explorer';
import { PythonExplorer } from './python-explorer';
import { TypeScriptExplorer } from './typescript-explorer';

/**
 * Creates Phase 1 default explorer registry with deterministic registration order.
 */
export const createDefaultExplorerRegistry = (
  tokenizer: TokenizerPort,
): ExplorerRegistryPort => {
  const registry = new ExplorerRegistry();
  registry.register(new TypeScriptExplorer(tokenizer));
  registry.register(new PythonExplorer(tokenizer));
  registry.register(new JsonExplorer(tokenizer));
  registry.register(new MarkdownExplorer(tokenizer));
  registry.register(new FallbackExplorer(tokenizer));
  return registry;
};
