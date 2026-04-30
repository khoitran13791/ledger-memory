import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  AgenticMapInput,
  AgenticMapOutput,
  AppendLedgerEventsInput,
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
  GetOperatorRunInput,
  GetOperatorRunOutput,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  GetNextStepsInput,
  GetNextStepsOutput,
  GrepInput,
  GrepOutput,
  LLMMapInput,
  LLMMapOutput,
  MaterializeContextInput,
  MaterializeContextOutput,
  MemoryEngine,
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  RecallForTaskInput,
  RecallForTaskOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
  RunCompactionInput,
  RunCompactionOutput,
  StoreArtifactInput,
  StoreArtifactOutput,
} from '@ledgermind/application';
import { createEventId, createTimestamp, createTokenCount } from '@ledgermind/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { runStopCommand } from '../commands/stop';

class RecordingMemoryEngine implements MemoryEngine {
  readonly appendCalls: AppendLedgerEventsInput[] = [];
  readonly runCompactionCalls: RunCompactionInput[] = [];
  readonly createHandoffCalls: CreateHandoffInput[] = [];

  async append(input: AppendLedgerEventsInput) {
    this.appendCalls.push(input);
    return {
      appendedEvents: [],
      contextTokenCount: createTokenCount(0),
    };
  }

  async materializeContext(_input: MaterializeContextInput): Promise<MaterializeContextOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
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

  async recordContinuity(_input: RecordContinuityInput): Promise<RecordContinuityOutput> {
    void _input;
    throw new Error('Not implemented in test double.');
  }

  async createHandoff(input: CreateHandoffInput): Promise<CreateHandoffOutput> {
    this.createHandoffCalls.push(input);
    return {
      handoff: {
        recordId: 'handoff:test',
        conversationId: input.conversationId,
        kind: 'handoff',
        status: 'active',
        title: `Continue: ${input.goal}`,
        content: input.completed.join('\n'),
        importance: 'normal',
        provenance: input.provenance ?? {},
        relatedRecordIds: [],
        supersedesRecordIds: [],
        createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
        eventId: createEventId('evt_handoff_test'),
      },
      nextStepRecords: [],
    };
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

describe('runStopCommand', () => {
  it('archives the final transcript tail before writing a bounded closing note', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledgermind-stop-'));
    tempDirectories.push(directory);

    const transcriptDirectory = join(directory, '.claude');
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(
      join(transcriptDirectory, 'transcript.jsonl'),
      [
        JSON.stringify({
          message: { role: 'user', content: 'Please summarize the deployment risk.' },
        }),
        JSON.stringify({
          message: { role: 'assistant', content: 'We decided to add a rollback plan.' },
        }),
        JSON.stringify({ message: { role: 'assistant', content: 'Next, run pnpm typecheck.' } }),
      ].join('\n'),
      'utf8',
    );

    const engine = new RecordingMemoryEngine();
    const repeatedMessage = 'Final debugging note. '.repeat(150);

    await runStopCommand({
      stdin: Readable.from([
        JSON.stringify({
          session_id: 'sess-stop',
          transcript_path: join(transcriptDirectory, 'transcript.jsonl'),
          cwd: directory,
          permission_mode: 'default',
          hook_event_name: 'Stop',
          stop_hook_active: true,
          last_assistant_message: repeatedMessage,
        }),
      ]),
      stdout: new MemoryWritable(),
      stderr: new MemoryWritable(),
      env: {
        USER: 'agent',
        LEDGERMIND_CLAUDE_CONTEXT_BUDGET_CHARS: '240',
      },
      engine,
    });

    expect(engine.appendCalls).toHaveLength(1);
    const [appendCall] = engine.appendCalls;
    expect(appendCall).toBeDefined();
    expect(appendCall?.events).toHaveLength(4);
    expect(appendCall?.events[0]).toMatchObject({
      role: 'user',
      content: 'Please summarize the deployment risk.',
    });
    expect(appendCall?.events[1]).toMatchObject({
      role: 'assistant',
      content: 'We decided to add a rollback plan.',
    });
    const stopEvent = appendCall?.events[3];
    expect(stopEvent).toBeDefined();
    expect(stopEvent).toMatchObject({
      role: 'system',
      metadata: {
        source: 'claude-code',
        hook: 'Stop',
        transcriptPath: join(transcriptDirectory, 'transcript.jsonl'),
      },
    });
    expect(stopEvent?.content).toContain('Session closed in Claude Code.');
    expect(stopEvent?.content).toContain('Last assistant message excerpt:');
    expect(stopEvent?.content).not.toContain(repeatedMessage);
    expect(stopEvent?.content.length).toBeLessThan(500);

    expect(engine.runCompactionCalls).toEqual([
      expect.objectContaining({
        trigger: 'soft',
      }),
    ]);
    expect(engine.createHandoffCalls).toEqual([
      expect.objectContaining({
        goal: 'Please summarize the deployment risk.',
        decisions: ['We decided to add a rollback plan.'],
        nextSteps: [
          {
            title: 'Next, run pnpm typecheck.',
            content: 'Next, run pnpm typecheck.',
            provenance: expect.any(Object),
          },
        ],
        verification: ['Next, run pnpm typecheck.'],
        provenance: expect.objectContaining({
          transcriptPath: join(transcriptDirectory, 'transcript.jsonl'),
        }),
      }),
    ]);
  });
});
