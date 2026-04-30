import { describe, expect, it } from 'vitest';

import { parseClaudeHookContext } from '../context';

describe('parseClaudeHookContext', () => {
  it('normalizes SessionStart payloads into a runtime context', () => {
    const context = parseClaudeHookContext({
      session_id: 'abc123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/workspace/ledger-memory',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-sonnet-4-6',
    });

    expect(context).toMatchObject({
      sessionId: 'abc123',
      transcriptPath: '/tmp/transcript.jsonl',
      cwd: '/workspace/ledger-memory',
      workspaceRoot: '/workspace/ledger-memory',
      permissionMode: 'unknown',
      hookName: 'SessionStart',
      source: 'startup',
      model: 'claude-sonnet-4-6',
    });
  });

  it('normalizes PreCompact payloads with transcript context', () => {
    const context = parseClaudeHookContext({
      session_id: 'abc123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/workspace/ledger-memory',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: 'Keep recent debugging details.',
    });

    expect(context).toMatchObject({
      hookName: 'PreCompact',
      permissionMode: 'unknown',
      trigger: 'manual',
      customInstructions: 'Keep recent debugging details.',
    });
  });

  it('normalizes PostToolUse payloads with tool metadata', () => {
    const context = parseClaudeHookContext({
      session_id: 'abc123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/workspace/ledger-memory',
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: '/workspace/ledger-memory/README.md',
      },
      tool_response: {
        filePath: '/workspace/ledger-memory/README.md',
        success: true,
      },
      tool_use_id: 'toolu_123',
    });

    expect(context).toMatchObject({
      hookName: 'PostToolUse',
      toolName: 'Write',
      toolUseId: 'toolu_123',
      toolInput: {
        file_path: '/workspace/ledger-memory/README.md',
      },
      toolResponse: {
        filePath: '/workspace/ledger-memory/README.md',
        success: true,
      },
    });
  });

  it('normalizes UserPromptSubmit payloads with prompt text', () => {
    const context = parseClaudeHookContext({
      session_id: 'abc123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/workspace/ledger-memory',
      permission_mode: 'default',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Fix the failing auth tests',
    });

    expect(context).toMatchObject({
      hookName: 'UserPromptSubmit',
      prompt: 'Fix the failing auth tests',
    });
  });
});
