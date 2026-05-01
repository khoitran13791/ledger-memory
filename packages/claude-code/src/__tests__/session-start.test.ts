import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  GetCurrentStateOutput,
  MemoryEngine,
  RecallForTaskInput,
  RecallForTaskOutput,
} from '@ledgermind/application';
import { createEventId, createTimestamp, createTokenCount } from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { runSessionStartCommand } from '../commands/session-start';

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
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const payloadFor = (directory: string) =>
  JSON.stringify({
    session_id: 'sess-session-start',
    transcript_path: join(directory, '.claude', 'transcript.jsonl'),
    cwd: directory,
    permission_mode: 'default',
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'claude-sonnet-4-6',
  });

const emptyState = (): GetCurrentStateOutput => ({
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
});

describe('runSessionStartCommand', () => {
  it('keeps the concise resumed message when no continuity records exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-session-start-empty-'));
    tempDirectories.push(directory);
    const stdout = new RecordingWritable();
    const stderr = new RecordingWritable();
    const engine = {
      getCurrentState: async (): Promise<GetCurrentStateOutput> => emptyState(),
    } as unknown as MemoryEngine;

    await runSessionStartCommand({
      stdin: Readable.from([payloadFor(directory)]),
      stdout,
      stderr,
      env: { USER: 'agent' },
      engine,
    });

    expect(JSON.parse(stdout.toString()).hookSpecificOutput.additionalContext).toContain(
      'LedgerMind resumed conversation',
    );
    expect(stderr.toString()).toBe('');
  });

  it('warns only when explicitly configured for in-memory storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-session-start-memory-'));
    tempDirectories.push(directory);
    const stdout = new RecordingWritable();
    const stderr = new RecordingWritable();
    const engine = {
      getCurrentState: async (): Promise<GetCurrentStateOutput> => emptyState(),
    } as unknown as MemoryEngine;

    await runSessionStartCommand({
      stdin: Readable.from([payloadFor(directory)]),
      stdout,
      stderr,
      env: { USER: 'agent', LEDGERMIND_CLAUDE_STORAGE: 'in-memory' },
      engine,
    });

    expect(stderr.toString()).toBe(
      'LedgerMind continuity is using in-memory storage; records will not survive process exit. Set LEDGERMIND_SQLITE_PATH or LEDGERMIND_DB_URL for durable memory.\n',
    );
  });

  it('injects task recall context when current continuity state exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-session-start-state-'));
    tempDirectories.push(directory);
    const stdout = new RecordingWritable();
    const recallCalls: RecallForTaskInput[] = [];
    const engine = {
      getCurrentState: async (): Promise<GetCurrentStateOutput> => ({
        ...emptyState(),
        goalRecords: [
          {
            recordId: 'goal:resume',
            conversationId:
              'conv_unused' as GetCurrentStateOutput['goalRecords'][number]['conversationId'],
            kind: 'goal',
            status: 'active',
            title: 'Resume agent continuity',
            content: 'Continue coding work.',
            importance: 'high',
            provenance: {},
            relatedRecordIds: [],
            supersedesRecordIds: [],
            createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
            eventId: createEventId('evt_session_start_goal'),
          },
        ],
        activeRecordCount: 1,
      }),
      recallForTask: async (input: RecallForTaskInput): Promise<RecallForTaskOutput> => {
        recallCalls.push(input);
        return {
          contextBlock: 'LedgerMind current state\n\nGoal:\n- Resume agent continuity',
          currentState: emptyState(),
          recalledSummaryIds: [],
          recalledArtifactIds: [],
          recalledEventIds: [],
          why: [],
          budgetUsed: createTokenCount(12),
        };
      },
    } as unknown as MemoryEngine;

    await runSessionStartCommand({
      stdin: Readable.from([payloadFor(directory)]),
      stdout,
      stderr: new RecordingWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_RECALL_BUDGET_TOKENS: '700',
      },
      engine,
    });

    expect(recallCalls[0]).toMatchObject({
      task: 'Resume this coding session',
      budgetTokens: 700,
      includeHandoff: true,
      includeEvidence: true,
    });
    expect(JSON.parse(stdout.toString()).hookSpecificOutput.additionalContext).toContain(
      'LedgerMind current state',
    );
  });
});
