export type ClaudeHookName = 'SessionStart' | 'PreCompact' | 'Stop' | 'PostToolUse';

interface ClaudeHookContextBase {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly permissionMode: string;
  readonly hookName: ClaudeHookName;
}

export interface SessionStartHookContext extends ClaudeHookContextBase {
  readonly hookName: 'SessionStart';
  readonly source: string;
  readonly model: string;
  readonly agentType?: string;
}

export interface PreCompactHookContext extends ClaudeHookContextBase {
  readonly hookName: 'PreCompact';
  readonly trigger: string;
  readonly customInstructions: string;
}

export interface StopHookContext extends ClaudeHookContextBase {
  readonly hookName: 'Stop';
  readonly stopHookActive: boolean;
  readonly lastAssistantMessage?: string;
}

export interface PostToolUseHookContext extends ClaudeHookContextBase {
  readonly hookName: 'PostToolUse';
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolResponse: unknown;
  readonly toolUseId?: string;
}

export type ClaudeHookContext =
  | SessionStartHookContext
  | PreCompactHookContext
  | StopHookContext
  | PostToolUseHookContext;

const readRequiredString = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Claude hook payload is missing required string field "${field}".`);
  }

  return value;
};

const readOptionalString = (input: Record<string, unknown>, field: string): string | undefined => {
  const value = input[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

const readRequiredObject = (input: Record<string, unknown>, field: string): Record<string, unknown> => {
  const value = input[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Claude hook payload is missing required object field "${field}".`);
  }

  return value as Record<string, unknown>;
};

export const parseClaudeHookContext = (payload: unknown): ClaudeHookContext => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Claude hook payload must be an object.');
  }

  const input = payload as Record<string, unknown>;
  const base = {
    sessionId: readRequiredString(input, 'session_id'),
    transcriptPath: readRequiredString(input, 'transcript_path'),
    cwd: readRequiredString(input, 'cwd'),
    workspaceRoot: readRequiredString(input, 'cwd'),
    permissionMode: readRequiredString(input, 'permission_mode'),
    hookName: readRequiredString(input, 'hook_event_name') as ClaudeHookName,
  };

  switch (base.hookName) {
    case 'SessionStart': {
      const agentType = readOptionalString(input, 'agent_type');
      return {
        ...base,
        hookName: 'SessionStart',
        source: readRequiredString(input, 'source'),
        model: readRequiredString(input, 'model'),
        ...(agentType === undefined ? {} : { agentType }),
      };
    }
    case 'PreCompact':
      return {
        ...base,
        hookName: 'PreCompact',
        trigger: readRequiredString(input, 'trigger'),
        customInstructions: readRequiredString(input, 'custom_instructions'),
      };
    case 'Stop': {
      const lastAssistantMessage = readOptionalString(input, 'last_assistant_message');
      return {
        ...base,
        hookName: 'Stop',
        stopHookActive: input.stop_hook_active === true,
        ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }),
      };
    }
    case 'PostToolUse': {
      const toolUseId = readOptionalString(input, 'tool_use_id');
      return {
        ...base,
        hookName: 'PostToolUse',
        toolName: readRequiredString(input, 'tool_name'),
        toolInput: readRequiredObject(input, 'tool_input'),
        toolResponse: input.tool_response,
        ...(toolUseId === undefined ? {} : { toolUseId }),
      };
    }
    default:
      throw new Error(`Unsupported Claude hook event: ${String(base.hookName)}.`);
  }
};
