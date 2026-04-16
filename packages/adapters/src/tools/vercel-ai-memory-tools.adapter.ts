import { jsonSchema, tool, type ToolSet } from 'ai';

import type { MemoryEngine, ToolDefinition, ToolProviderPort } from '@ledgermind/application';

import { createCanonicalMemoryToolCatalog } from './canonical-memory-tool-catalog';

const createToolDefinitions = (engine: MemoryEngine): readonly ToolDefinition[] =>
  createCanonicalMemoryToolCatalog(engine);

export type VercelMemoryToolSet = ToolSet;

/**
 * Creates Vercel AI SDK-native memory tools from the canonical memory tool catalog.
 */
export const createVercelMemoryTools = (engine: MemoryEngine): VercelMemoryToolSet => {
  const definitions = createToolDefinitions(engine);

  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
        execute: async (input: unknown) => definition.execute(input),
      }),
    ]),
  ) as VercelMemoryToolSet;
};

export const createVercelTools = createVercelMemoryTools;

export class VercelAiMemoryToolsAdapter implements ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[] {
    return [...createToolDefinitions(engine)];
  }
}
