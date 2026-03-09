import type { MemoryEngine } from './memory-engine.port';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(input: unknown): Promise<unknown>;
}

export interface ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[];
}
