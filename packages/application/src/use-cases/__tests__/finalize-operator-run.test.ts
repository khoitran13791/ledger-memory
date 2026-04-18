import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createArtifactId,
  createConversation,
  createConversationConfig,
  createConversationId,
  createEventId,
  createMimeType,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  type Artifact,
  type ArtifactId,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type LedgerEvent,
  type SequenceNumber,
  type Timestamp,
  type TokenCount,
} from '@ledgermind/domain';

import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerAppendPort } from '../../ports/driven/persistence/ledger-append.port';
import type {
  OperatorExecutionPort,
  StoredOperatorRun,
  StoredOperatorTask,
} from '../../ports/driven/persistence/operator-execution.port';
import type { IntegrityReport, SummaryDagPort } from '../../ports/driven/persistence/summary-dag.port';
import type { UnitOfWork, UnitOfWorkPort } from '../../ports/driven/persistence/unit-of-work.port';
import { FinalizeOperatorRunUseCase } from '../finalize-operator-run';

const conversationId = createConversationId('conv_finalize_operator_run');
const runId = 'run_finalize_operator_run';

type StoredTaskWithOutput = StoredOperatorTask & {
  readonly output?: unknown;
};

class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const date = new Date(Date.UTC(2026, 3, 13, 0, 0, this.tick));
    this.tick += 1;
    return createTimestamp(date);
  }
}

class DeterministicHashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
}

class SimpleTokenizer {
  countTokens(text: string): TokenCount {
    return createTokenCount(Math.max(1, text.length));
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(Math.max(1, byteLength));
  }
}

class TestArtifactStore implements ArtifactStorePort {
  readonly storedMetadata = new Map<ArtifactId, Artifact>();
  readonly storedContents = new Map<ArtifactId, string | Uint8Array>();
  readonly storeCalls: Array<{ artifactId: ArtifactId; content: string | Uint8Array | undefined }> = [];

  constructor(entries: readonly { artifact: Artifact; content: string | Uint8Array }[] = []) {
    for (const entry of entries) {
      this.storedMetadata.set(entry.artifact.id, entry.artifact);
      this.storedContents.set(entry.artifact.id, entry.content);
    }
  }

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<boolean> {
    this.storeCalls.push({ artifactId: artifact.id, content });
    this.storedMetadata.set(artifact.id, artifact);
    if (content !== undefined) {
      this.storedContents.set(artifact.id, content);
    }
    return true;
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    return this.storedMetadata.get(id) ?? null;
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    return this.storedContents.get(id) ?? null;
  }

  async updateExploration(): Promise<void> {
    return;
  }
}

class TestLedgerPort implements LedgerAppendPort {
  readonly appendedEvents: LedgerEvent[] = [];
  private nextSequence = 1;

  async appendEvents(conversationIdInput: ConversationId, events: readonly LedgerEvent[]): Promise<void> {
    for (const event of events) {
      if (event.conversationId !== conversationIdInput) {
        throw new Error('conversation mismatch');
      }
      this.appendedEvents.push(event);
      this.nextSequence = event.sequence + 1;
    }
  }

  async getNextSequence(): Promise<SequenceNumber> {
    return createSequenceNumber(this.nextSequence);
  }
}

class TestConversationStore implements ConversationPort {
  constructor(private readonly conversations: readonly Conversation[]) {}

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
    return createConversation({
      id: createConversationId(`conv_created_${parentId ?? 'root'}`),
      config,
      createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
    });
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.find((conversation) => conversation.id === id) ?? null;
  }

  async getAncestorChain(): Promise<readonly ConversationId[]> {
    return [];
  }
}

class FakeOperatorExecutionPort implements OperatorExecutionPort {
  finalizeCalls = 0;
  advanceCalls: Array<{ from: StoredOperatorRun['finalizationStage']; to: StoredOperatorRun['finalizationStage'] }> = [];

  constructor(
    private run: StoredOperatorRun,
    private readonly tasks: readonly StoredTaskWithOutput[],
  ) {}

  async createRunWithTasks(): Promise<StoredOperatorRun> {
    throw new Error('createRunWithTasks not needed in this test suite');
  }

  async getRun(runIdInput: string): Promise<StoredOperatorRun | null> {
    return this.run.runId === runIdInput ? this.run : null;
  }

  async getTask(): Promise<StoredOperatorTask | null> {
    return null;
  }

  async listTasksForRun(runIdInput: string): Promise<readonly StoredTaskWithOutput[]> {
    return runIdInput === this.run.runId ? this.tasks : [];
  }

  async lookupRunByIdempotencyKey(): Promise<StoredOperatorRun | null> {
    return null;
  }

  async claimTaskLease(): Promise<StoredOperatorTask | null> {
    return null;
  }

  async recordTaskSuccess(): Promise<void> {
    throw new Error('recordTaskSuccess not needed in this test suite');
  }

  async recordTaskFailure(): Promise<void> {
    throw new Error('recordTaskFailure not needed in this test suite');
  }

  async markTaskRetryableFailure(): Promise<void> {
    throw new Error('markTaskRetryableFailure not needed in this test suite');
  }

  async assignTaskChildConversation(): Promise<ConversationId> {
    throw new Error('assignTaskChildConversation not needed in this test suite');
  }

  async getTaskBootstrapState(): Promise<StoredOperatorTask['bootstrapState']> {
    return 'bootstrap_not_started';
  }

  async markBootstrapStarted(): Promise<void> {
    throw new Error('markBootstrapStarted not needed in this test suite');
  }

  async markBootstrapCompleted(): Promise<void> {
    throw new Error('markBootstrapCompleted not needed in this test suite');
  }

  async claimRunForFinalizationRetry(): Promise<StoredOperatorRun | null> {
    return this.run.finalizationStage === 'completed' ? null : this.run;
  }

  async advanceFinalizationStage(input: { runId: string; from: StoredOperatorRun['finalizationStage']; to: StoredOperatorRun['finalizationStage'] }): Promise<StoredOperatorRun['finalizationStage']> {
    if (input.runId !== this.run.runId) {
      return this.run.finalizationStage;
    }
    this.advanceCalls.push({ from: input.from, to: input.to });
    if (this.run.finalizationStage !== input.from) {
      return this.run.finalizationStage;
    }
    this.run = {
      ...this.run,
      finalizationStage: input.to,
      ...(input.to === 'handle_appended' ? { parentHandleAppendedAt: createTimestamp(new Date('2026-04-13T00:00:03.000Z')) } : {}),
    };
    return this.run.finalizationStage;
  }

  async finalizeRun(input: {
    runId: string;
    status: StoredOperatorRun['status'];
    completedAt: Timestamp;
    outputArtifactId?: ArtifactId;
    terminalFailureSummary?: StoredOperatorRun['terminalFailureSummary'];
  }): Promise<StoredOperatorRun> {
    this.finalizeCalls += 1;
    this.run = {
      ...this.run,
      status: input.status,
      completedAt: input.completedAt,
      ...(input.outputArtifactId === undefined ? {} : { outputArtifactId: input.outputArtifactId }),
      ...(input.terminalFailureSummary === undefined ? {} : { terminalFailureSummary: input.terminalFailureSummary }),
      finalizationStage: 'completed',
      needsFinalizationRetry: false,
    };
    return this.run;
  }
}

class NoopContextProjectionPort implements ContextProjectionPort {
  async getCurrentContext() {
    return { items: [], version: 0 as never };
  }

  async getContextTokenCount(): Promise<TokenCount> {
    return createTokenCount(0);
  }

  async appendContextItems() {
    return 0 as never;
  }

  async replaceContextItems() {
    return 0 as never;
  }
}

class NoopSummaryDagPort implements SummaryDagPort {
  async createNode() {
    throw new Error('createNode not needed in this test suite');
  }

  async getNode() {
    return null;
  }

  async addLeafEdges(): Promise<void> {
    return;
  }

  async addCondensedEdges(): Promise<void> {
    return;
  }

  async getParentSummaryIds() {
    return [];
  }

  async expandToMessages() {
    return [];
  }

  async searchSummaries() {
    return [];
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    return { passed: true, checks: [] };
  }
}

class TestUnitOfWorkPort implements UnitOfWorkPort {
  private readonly uow: UnitOfWork;

  constructor(input: {
    readonly ledger: LedgerAppendPort;
    readonly artifacts: ArtifactStorePort;
    readonly conversations: ConversationPort;
    readonly operators: OperatorExecutionPort;
  }) {
    this.uow = {
      ledger: input.ledger,
      context: new NoopContextProjectionPort(),
      dag: new NoopSummaryDagPort(),
      artifacts: input.artifacts,
      conversations: input.conversations,
      operators: input.operators,
    };
  }

  async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return work(this.uow);
  }
}

const createConversationRecord = (): Conversation => {
  const config = createConversationConfig({
    modelName: 'gpt-4o-mini',
    contextWindow: createTokenCount(8_000),
    thresholds: { soft: 0.7, hard: 1 },
  });

  return createConversation({
    id: conversationId,
    config,
    createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
  });
};

const createRun = (overrides: Partial<StoredOperatorRun> = {}): StoredOperatorRun => ({
  runId,
  conversationId,
  operatorKind: 'llmMap',
  status: 'completed_with_failures',
  createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
  updatedAt: createTimestamp(new Date('2026-04-13T00:00:01.000Z')),
  prompt: 'Summarize the item.',
  outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  concurrencyLimit: 2,
  retryPolicy: { maxRetries: 1, retryBackoffSeconds: 30 },
  finalizationStage: 'not_started',
  needsFinalizationRetry: true,
  inputArtifactId: createArtifactId('file_input_operator_finalize'),
  taskCount: 2,
  succeededTaskCount: 1,
  failedTaskCount: 1,
  retryableFailureTaskCount: 0,
  runningTaskCount: 0,
  pendingTaskCount: 0,
  terminalFailureSummary: {
    code: 'SCHEMA_INVALID',
    message: 'Output did not match schema.',
    retryable: false,
    attemptCount: 2,
  },
  ...overrides,
});

const createUseCase = (input?: {
  readonly run?: StoredOperatorRun;
  readonly tasks?: readonly StoredTaskWithOutput[];
  readonly artifactEntries?: readonly { artifact: Artifact; content: string | Uint8Array }[];
}) => {
  const run = input?.run ?? createRun();
  const tasks = input?.tasks ?? [
    {
      taskId: 'task_1',
      runId,
      conversationId,
      itemIndex: 1,
      status: 'succeeded',
      attemptCount: 1,
      bootstrapState: 'bootstrap_not_started',
      output: { summary: 'beta' },
    },
    {
      taskId: 'task_0',
      runId,
      conversationId,
      itemIndex: 0,
      status: 'failed',
      attemptCount: 2,
      bootstrapState: 'bootstrap_not_started',
      terminalFailure: {
        code: 'SCHEMA_INVALID',
        message: 'Output did not match schema.',
        retryable: false,
        attemptCount: 2,
      },
    },
  ] satisfies readonly StoredTaskWithOutput[];
  const artifactStore = new TestArtifactStore(input?.artifactEntries ?? []);
  const ledger = new TestLedgerPort();
  const operators = new FakeOperatorExecutionPort(run, tasks);
  const unitOfWork = new TestUnitOfWorkPort({
    ledger,
    artifacts: artifactStore,
    conversations: new TestConversationStore([createConversationRecord()]),
    operators,
  });

  return {
    useCase: new FinalizeOperatorRunUseCase({
      unitOfWork,
      idService: {
        generateArtifactId: ({ contentHashHex }: { contentHashHex: string }) => createArtifactId(`file_${contentHashHex.slice(0, 12)}`),
        generateEventId: ({ sequence }: { sequence: number }) => createEventId(`evt_operator_handle_${sequence}`),
        generateSummaryId: () => {
          throw new Error('generateSummaryId not needed in this test suite');
        },
      },
      hashPort: new DeterministicHashPort(),
      tokenizer: new SimpleTokenizer(),
      clock: new DeterministicClock(),
    }),
    artifactStore,
    ledger,
    operators,
    run,
  };
};

describe('FinalizeOperatorRunUseCase', () => {
  it('writes one ordered JSONL row per input item, appends one compact parent handle, and completes finalization stages', async () => {
    const { useCase, artifactStore, ledger, operators } = createUseCase();

    const output = await useCase.execute({ runId });

    expect(output.status).toBe('completed_with_failures');
    expect(artifactStore.storeCalls).toHaveLength(1);
    const writtenContent = artifactStore.storeCalls[0]?.content;
    expect(typeof writtenContent).toBe('string');
    expect((writtenContent as string).trim().split('\n')).toEqual([
      JSON.stringify({
        itemIndex: 0,
        status: 'failed',
        error: {
          code: 'SCHEMA_INVALID',
          message: 'Output did not match schema.',
          retryable: false,
          attemptCount: 2,
        },
      }),
      JSON.stringify({
        itemIndex: 1,
        status: 'succeeded',
        output: { summary: 'beta' },
      }),
    ]);
    expect(ledger.appendedEvents).toHaveLength(1);
    expect(ledger.appendedEvents[0]?.metadata).toMatchObject({
      __ledgermind_idempotencyKey: `operator-run-handle:${runId}`,
    });
    expect(ledger.appendedEvents[0]?.content).toContain(runId);
    expect(operators.advanceCalls).toEqual([
      { from: 'not_started', to: 'artifact_written' },
      { from: 'artifact_written', to: 'handle_appended' },
    ]);
    expect(operators.finalizeCalls).toBe(1);
  });

  it('resumes from artifact_written without rewriting the output artifact', async () => {
    const outputArtifactId = createArtifactId('file_existing_output');
    const existingContent = '{"itemIndex":0,"status":"failed"}\n{"itemIndex":1,"status":"succeeded"}\n';
    const { useCase, artifactStore, ledger, operators } = createUseCase({
      run: createRun({ finalizationStage: 'artifact_written', outputArtifactId }),
      artifactEntries: [
        {
          artifact: createArtifact({
            id: outputArtifactId,
            conversationId,
            storageKind: 'inline_text',
            mimeType: createMimeType('application/x-ndjson'),
            tokenCount: createTokenCount(existingContent.length),
          }),
          content: existingContent,
        },
      ],
    });

    await useCase.execute({ runId });

    expect(artifactStore.storeCalls).toHaveLength(0);
    expect(ledger.appendedEvents).toHaveLength(1);
    expect(operators.advanceCalls).toEqual([{ from: 'artifact_written', to: 'handle_appended' }]);
    expect(operators.finalizeCalls).toBe(1);
  });

  it('resumes from handle_appended without duplicating the parent handle append', async () => {
    const outputArtifactId = createArtifactId('file_existing_output');
    const existingContent = '{"itemIndex":0,"status":"failed"}\n{"itemIndex":1,"status":"succeeded"}\n';
    const { useCase, artifactStore, ledger, operators } = createUseCase({
      run: createRun({
        finalizationStage: 'handle_appended',
        outputArtifactId,
        parentHandleAppendedAt: createTimestamp(new Date('2026-04-13T00:00:03.000Z')),
      }),
      artifactEntries: [
        {
          artifact: createArtifact({
            id: outputArtifactId,
            conversationId,
            storageKind: 'inline_text',
            mimeType: createMimeType('application/x-ndjson'),
            tokenCount: createTokenCount(existingContent.length),
          }),
          content: existingContent,
        },
      ],
    });

    await useCase.execute({ runId });

    expect(artifactStore.storeCalls).toHaveLength(0);
    expect(ledger.appendedEvents).toHaveLength(0);
    expect(operators.advanceCalls).toEqual([]);
    expect(operators.finalizeCalls).toBe(1);
  });
});
