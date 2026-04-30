import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  MemoryEngine,
  RecallForTaskInput,
  RecallForTaskOutput,
} from '@ledgermind/application';
import { createTokenCount } from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { runUserPromptSubmitCommand } from '../commands/user-prompt-submit';

class RecordingWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

const createPayload = (directory: string) =>
  JSON.stringify({
    session_id: 'sess-user-prompt',
    transcript_path: join(directory, '.claude', 'transcript.jsonl'),
    cwd: directory,
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Fix failing auth tests',
  });

describe('runUserPromptSubmitCommand', () => {
  it('injects recallForTask context when continuity injection is enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-user-prompt-'));
    tempDirectories.push(directory);
    const stdout = new RecordingWritable();
    const recallCalls: RecallForTaskInput[] = [];
    const engine = {
      recallForTask: async (input: RecallForTaskInput): Promise<RecallForTaskOutput> => {
        recallCalls.push(input);
        return {
          contextBlock: 'LedgerMind current state\n\nGoal:\n- Fix auth tests',
          currentState: {
            goalRecords: [],
            decisions: [],
            constraints: [],
            progress: [],
            nextSteps: [],
            handoffs: [],
            verification: [],
            failures: [],
            openQuestions: [],
            artifactChanges: [],
            sessionSummaries: [],
            activeRecordCount: 0,
            staleRecordCount: 0,
          },
          recalledSummaryIds: [],
          recalledArtifactIds: [],
          recalledEventIds: [],
          why: [],
          budgetUsed: createTokenCount(12),
        };
      },
    } as unknown as MemoryEngine;

    await runUserPromptSubmitCommand({
      stdin: Readable.from([createPayload(directory)]),
      stdout,
      stderr: new RecordingWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_CONTINUITY_INJECTION: 'true',
        LEDGERMIND_CLAUDE_RECALL_BUDGET_TOKENS: '900',
      },
      engine,
    });

    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0]).toMatchObject({
      task: 'Fix failing auth tests',
      budgetTokens: 900,
      includeHandoff: true,
      includeEvidence: true,
    });
    expect(JSON.parse(stdout.toString())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'LedgerMind current state\n\nGoal:\n- Fix auth tests',
      },
    });
  });

  it('exits successfully without extra context when continuity injection is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-user-prompt-disabled-'));
    tempDirectories.push(directory);
    const stdout = new RecordingWritable();
    let recallCalled = false;
    const engine = {
      recallForTask: async () => {
        recallCalled = true;
        throw new Error('should not recall when disabled');
      },
    } as unknown as MemoryEngine;

    await runUserPromptSubmitCommand({
      stdin: Readable.from([createPayload(directory)]),
      stdout,
      stderr: new RecordingWritable(),
      env: {
        USER: 'agent',
      },
      engine,
    });

    expect(recallCalled).toBe(false);
    expect(JSON.parse(stdout.toString())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
      },
    });
  });
});
