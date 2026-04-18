import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  AgenticMapInput,
  AgenticMapOutput,
  AppendLedgerEventsInput,
  CheckIntegrityInput,
  CheckIntegrityOutput,
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  ExploreArtifactInput,
  ExploreArtifactOutput,
  GetOperatorRunInput,
  GetOperatorRunOutput,
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
} from '@ledgermind/application';
import { createTokenCount } from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { runPreCompactCommand } from '../commands/pre-compact';

class RecordingMemoryEngine implements MemoryEngine {
  readonly appendCalls: AppendLedgerEventsInput[] = [];
  readonly runCompactionCalls: RunCompactionInput[] = [];
  readonly materializeContextCalls: MaterializeContextInput[] = [];

  private readonly seenIdempotencyKeys = new Set<string>();

  async append(input: AppendLedgerEventsInput) {
    if (input.idempotencyKey === undefined || !this.seenIdempotencyKeys.has(input.idempotencyKey)) {
      this.appendCalls.push(input);
      if (input.idempotencyKey !== undefined) {
        this.seenIdempotencyKeys.add(input.idempotencyKey);
      }
    }

    return {
      appendedEvents: [],
      contextTokenCount: createTokenCount(0),
    };
  }

  async materializeContext(input: MaterializeContextInput): Promise<MaterializeContextOutput> {
    this.materializeContextCalls.push(input);
    return {
      systemPreamble: 'Compacted debugging summary',
      modelMessages: [],
      summaryReferences: [],
      artifactReferences: [],
      budgetUsed: createTokenCount(32),
    };
  }

  async runCompaction(input: RunCompactionInput): Promise<RunCompactionOutput> {
    this.runCompactionCalls.push(input);
    return {
      rounds: 1,
      nodesCreated: [],
      tokensFreed: createTokenCount(0),
      converged: true,
    };
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

  async storeArtifact(_input: StoreArtifactInput): Promise<StoreArtifactOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
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

describe('runPreCompactCommand', () => {
  it('archives transcript content exactly once for a repeated hook payload and emits a bounded summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-precompact-'));
    tempDirectories.push(directory);

    const transcriptPath = join(directory, 'transcript.jsonl');
    const bindingStorePath = join(directory, 'bindings.json');

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ message: { role: 'user', content: 'Investigate the auth regression.' } }),
        '{not valid json}',
        JSON.stringify({ message: { role: 'assistant', content: 'I found the middleware mismatch.' } }),
      ].join('\n'),
      'utf8',
    );

    const payload = {
      session_id: 'sess-precompact',
      transcript_path: transcriptPath,
      cwd: '/workspace/ledger-memory',
      permission_mode: 'default',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: 'Keep the debugging trail.',
    };

    const engine = new RecordingMemoryEngine();

    const firstStdout = new MemoryWritable();
    await runPreCompactCommand({
      stdin: Readable.from([JSON.stringify(payload)]),
      stdout: firstStdout,
      stderr: new MemoryWritable(),
      env: {
        LEDGERMIND_MCP_BINDING_STORE: bindingStorePath,
        USER: 'agent',
        LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS: '1200',
      },
      engine,
    });

    const secondStdout = new MemoryWritable();
    await runPreCompactCommand({
      stdin: Readable.from([JSON.stringify(payload)]),
      stdout: secondStdout,
      stderr: new MemoryWritable(),
      env: {
        LEDGERMIND_MCP_BINDING_STORE: bindingStorePath,
        USER: 'agent',
        LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS: '1200',
      },
      engine,
    });

    expect(engine.appendCalls).toHaveLength(1);
    const [appendCall] = engine.appendCalls;
    expect(appendCall).toBeDefined();
    expect(appendCall).toMatchObject({
      events: [
        {
          role: 'user',
          content: 'Investigate the auth regression.',
          metadata: {
            source: 'claude-code',
            hook: 'PreCompact',
            trigger: 'manual',
          },
        },
        {
          role: 'assistant',
          content: 'I found the middleware mismatch.',
        },
      ],
    });
    expect(appendCall?.idempotencyKey).toBeTruthy();
    expect(engine.runCompactionCalls).toHaveLength(2);
    expect(engine.materializeContextCalls).toHaveLength(2);

    expect(firstStdout.toString()).toContain('LedgerMind archived the full Claude Code transcript');
    expect(firstStdout.toString()).toContain('Compacted debugging summary');
    expect(secondStdout.toString()).toContain('Compacted debugging summary');
  });

  it('appends only the transcript suffix that was not archived yet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-precompact-growth-'));
    tempDirectories.push(directory);

    const transcriptPath = join(directory, 'transcript.jsonl');
    const bindingStorePath = join(directory, 'bindings.json');

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ message: { role: 'user', content: 'Step one.' } }),
        JSON.stringify({ message: { role: 'assistant', content: 'Step two.' } }),
      ].join('\n'),
      'utf8',
    );

    const payload = {
      session_id: 'sess-precompact-growth',
      transcript_path: transcriptPath,
      cwd: directory,
      permission_mode: 'default',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      custom_instructions: 'Keep the latest steps.',
    };

    const engine = new RecordingMemoryEngine();

    await runPreCompactCommand({
      stdin: Readable.from([JSON.stringify(payload)]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        LEDGERMIND_MCP_BINDING_STORE: bindingStorePath,
        USER: 'agent',
      },
      engine,
    });

    await appendFile(
      transcriptPath,
      `\n${JSON.stringify({ message: { role: 'assistant', content: 'Step three.' } })}`,
      'utf8',
    );

    await runPreCompactCommand({
      stdin: Readable.from([JSON.stringify(payload)]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        LEDGERMIND_MCP_BINDING_STORE: bindingStorePath,
        USER: 'agent',
      },
      engine,
    });

    expect(engine.appendCalls).toHaveLength(2);
    expect(engine.appendCalls[0]?.events).toHaveLength(2);
    expect(engine.appendCalls[1]?.events).toMatchObject([
      {
        role: 'assistant',
        content: 'Step three.',
      },
    ]);
  });
});
