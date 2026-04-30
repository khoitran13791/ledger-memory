import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  CheckIntegrityInput,
  CheckIntegrityOutput,
  CreateHandoffInput,
  CreateHandoffOutput,
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  ExploreArtifactInput,
  ExploreArtifactOutput,
  GrepInput,
  GrepOutput,
  LLMMapInput,
  LLMMapOutput,
  MaterializeContextInput,
  MaterializeContextOutput,
  MemoryEngine,
  RunCompactionInput,
  RunCompactionOutput,
  StoreArtifactInput,
  StoreArtifactOutput,
  AgenticMapInput,
  AgenticMapOutput,
  GetOperatorRunInput,
  GetOperatorRunOutput,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  GetNextStepsInput,
  GetNextStepsOutput,
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  RecallForTaskInput,
  RecallForTaskOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
} from '@ledgermind/application';
import {
  createArtifactId,
  createEventId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { runPostToolUseCommand } from '../commands/post-tool-use';

class RecordingMemoryEngine implements MemoryEngine {
  readonly storeArtifactCalls: StoreArtifactInput[] = [];
  readonly recordContinuityCalls: RecordContinuityInput[] = [];

  async append(_input: AppendLedgerEventsInput): Promise<AppendLedgerEventsOutput> {
    void _input;
    return {
      appendedEvents: [],
      contextTokenCount: createTokenCount(0),
    };
  }

  async materializeContext(_input: MaterializeContextInput): Promise<MaterializeContextOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async runCompaction(_input: RunCompactionInput): Promise<RunCompactionOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async checkIntegrity(_input: CheckIntegrityInput): Promise<CheckIntegrityOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async grep(_input: GrepInput): Promise<GrepOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async describe(_input: DescribeInput): Promise<DescribeOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async expand(_input: ExpandInput): Promise<ExpandOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async storeArtifact(input: StoreArtifactInput): Promise<StoreArtifactOutput> {
    this.storeArtifactCalls.push(input);
    return {
      artifactId: createArtifactId('art_test'),
      tokenCount: createTokenCount(12),
    };
  }

  async exploreArtifact(_input: ExploreArtifactInput): Promise<ExploreArtifactOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async recordContinuity(input: RecordContinuityInput): Promise<RecordContinuityOutput> {
    this.recordContinuityCalls.push(input);
    return {
      record: {
        recordId: input.idempotencyKey ?? `${input.kind}:${input.title.toLowerCase()}`,
        conversationId: input.conversationId,
        kind: input.kind,
        status: input.status ?? 'active',
        title: input.title,
        content: input.content,
        importance: input.importance ?? 'normal',
        provenance: input.provenance ?? {},
        relatedRecordIds: input.relatedRecordIds ?? [],
        supersedesRecordIds: input.supersedesRecordIds ?? [],
        createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
        eventId: createEventId('evt_tool_evidence'),
      },
      contextTokenCount: createTokenCount(10),
    };
  }

  async createHandoff(_input: CreateHandoffInput): Promise<CreateHandoffOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async getCurrentState(_input: GetCurrentStateInput): Promise<GetCurrentStateOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async getNextSteps(_input: GetNextStepsInput): Promise<GetNextStepsOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async recallForTask(_input: RecallForTaskInput): Promise<RecallForTaskOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async markContinuityRecord(
    _input: MarkContinuityRecordInput,
  ): Promise<MarkContinuityRecordOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async llmMap(_input: LLMMapInput): Promise<LLMMapOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async agenticMap(_input: AgenticMapInput): Promise<AgenticMapOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async getOperatorRun(_input: GetOperatorRunInput): Promise<GetOperatorRunOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }
}

class MemoryWritable extends Writable {
  override _write(
    _chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('runPostToolUseCommand', () => {
  it('indexes only edited workspace files when artifact indexing is enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-post-tool-'));
    tempDirectories.push(directory);
    const existingFilePath = join(directory, 'src', 'feature.ts');
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(existingFilePath, 'export const feature = true;\n', 'utf8');

    const engine = new RecordingMemoryEngine();

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'Write',
          tool_input: {
            file_path: existingFilePath,
          },
          tool_response: {
            success: true,
          },
          tool_use_id: 'toolu_1',
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING: 'true',
      },
      engine,
    });

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: {
            command: 'ls',
          },
          tool_response: {
            exit_code: 0,
          },
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING: 'true',
      },
      engine,
    });

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: {
            file_path: join(directory, 'src', 'missing.ts'),
          },
          tool_response: {
            success: true,
          },
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_ARTIFACT_INDEXING: 'true',
      },
      engine,
    });

    expect(engine.storeArtifactCalls).toEqual([
      expect.objectContaining({
        source: {
          kind: 'path',
          path: existingFilePath,
        },
      }),
    ]);
  });

  it('records Bash verification evidence for test commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-post-tool-evidence-bash-'));
    tempDirectories.push(directory);
    const engine = new RecordingMemoryEngine();

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool-bash',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: {
            command: 'pnpm typecheck',
          },
          tool_response: {
            exit_code: 0,
            stdout: 'typecheck passed',
          },
          tool_use_id: 'toolu_bash_1',
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE: 'true',
      },
      engine,
    });

    expect(engine.recordContinuityCalls).toEqual([
      expect.objectContaining({
        kind: 'verification',
        title: 'Bash verification: pnpm typecheck',
        content: expect.stringContaining('typecheck passed'),
        provenance: {
          toolUseId: 'toolu_bash_1',
          command: 'pnpm typecheck',
        },
      }),
    ]);
  });

  it('records edit artifact changes with normalized workspace paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-post-tool-evidence-edit-'));
    tempDirectories.push(directory);
    const engine = new RecordingMemoryEngine();

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool-edit',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'MultiEdit',
          tool_input: {
            edits: [{ file_path: join(directory, 'src', 'continuity.ts') }],
          },
          tool_response: {
            success: true,
          },
          tool_use_id: 'toolu_edit_1',
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE: 'true',
      },
      engine,
    });

    expect(engine.recordContinuityCalls).toEqual([
      expect.objectContaining({
        kind: 'artifact_change',
        title: 'MultiEdit changed 1 workspace file',
        content: 'Changed files:\n- src/continuity.ts',
        provenance: {
          toolUseId: 'toolu_edit_1',
        },
      }),
    ]);
  });

  it('records failed tool evidence with redacted output summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-post-tool-evidence-failure-'));
    tempDirectories.push(directory);
    const engine = new RecordingMemoryEngine();

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool-fail',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: {
            file_path: 'secrets.txt',
          },
          tool_response: {
            success: false,
            error: 'failed with sk-liveSecret and postgres://user:pass@localhost/db',
          },
          tool_use_id: 'toolu_fail_1',
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE: 'true',
        LEDGERMIND_CLAUDE_TOOL_OUTPUT_BUDGET_CHARS: '80',
      },
      engine,
    });

    expect(engine.recordContinuityCalls).toHaveLength(1);
    const [call] = engine.recordContinuityCalls;
    expect(call).toMatchObject({
      kind: 'failure',
      title: 'Read failed',
      provenance: {
        toolUseId: 'toolu_fail_1',
      },
    });
    expect(call?.content).toContain('[REDACTED]');
    expect(call?.content).not.toContain('sk-liveSecret');
    expect(call?.content).not.toContain('postgres://user:pass@localhost/db');
    expect(call?.content.length).toBeLessThanOrEqual(100);
  });

  it('redacts secrets from Bash evidence command fields', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'ledgermind-post-tool-evidence-command-redaction-'),
    );
    tempDirectories.push(directory);
    const engine = new RecordingMemoryEngine();

    await runPostToolUseCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-post-tool-command-redaction',
          transcript_path: join(directory, '.claude', 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: {
            command: 'pnpm test --db=postgres://user:pass@localhost/db --token=sk-liveSecret',
          },
          tool_response: {
            exit_code: 0,
            stdout: 'tests passed',
          },
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE: 'true',
      },
      engine,
    });

    const [call] = engine.recordContinuityCalls;
    const serialized = JSON.stringify(call);
    expect(call?.title).toBe('Bash verification: pnpm test --db=[REDACTED] --token=[REDACTED]');
    expect(call?.provenance).toEqual({
      command: 'pnpm test --db=[REDACTED] --token=[REDACTED]',
    });
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('postgres://user:pass@localhost/db');
    expect(serialized).not.toContain('sk-liveSecret');
  });

  it('uses distinct fallback idempotency keys when tool use id is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-post-tool-evidence-idempotency-'));
    tempDirectories.push(directory);
    const engine = new RecordingMemoryEngine();

    for (const stdout of ['first pass', 'second pass']) {
      await runPostToolUseCommand({
        stdin: Readable.from([
          JSON.stringify({
            session_id: 'sess-post-tool-idempotency',
            transcript_path: join(directory, '.claude', 'transcript.jsonl'),
            cwd: directory,
            permission_mode: 'default',
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: {
              command: 'pnpm test',
            },
            tool_response: {
              exit_code: 0,
              stdout,
            },
          }),
        ]),
        stdout: new MemoryWritable(),
        stderr: new MemoryWritable(),
        env: {
          USER: 'agent',
          LEDGERMIND_CLAUDE_ENABLE_TOOL_EVIDENCE: 'true',
        },
        engine,
      });
    }

    expect(engine.recordContinuityCalls).toHaveLength(2);
    expect(engine.recordContinuityCalls[0]?.idempotencyKey).not.toBe(
      engine.recordContinuityCalls[1]?.idempotencyKey,
    );
  });
});
