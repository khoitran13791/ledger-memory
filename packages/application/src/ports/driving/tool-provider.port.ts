import type { MemoryEngine } from './memory-engine.port';

export type ToolAccessLevel = 'read' | 'write' | 'privileged';

export interface ToolPolicyMetadata {
  readonly access: ToolAccessLevel;
  readonly requiresApproval: boolean;
  readonly subAgentOnly: boolean;
  readonly idempotent: boolean;
  readonly approvalHint?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly access?: ToolAccessLevel;
  readonly requiresApproval?: boolean;
  readonly subAgentOnly?: boolean;
  readonly idempotent?: boolean;
  readonly approvalHint?: string;
  execute(input: unknown): Promise<unknown>;
}

export interface ToolProviderPort {
  createTools(engine: MemoryEngine): ToolDefinition[];
}
