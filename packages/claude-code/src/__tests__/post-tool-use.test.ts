import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  CheckIntegrityInput,
  CheckIntegrityOutput,
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
} from '@ledgermind/application';
import { createArtifactId, createTokenCount } from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { runPostToolUseCommand } from '../commands/post-tool-use';

class RecordingMemoryEngine implements MemoryEngine {
  readonly storeArtifactCalls: StoreArtifactInput[] = [];

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
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
});
