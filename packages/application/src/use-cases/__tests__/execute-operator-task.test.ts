import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createArtifactId,
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  type Artifact,
  type ArtifactId,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type TokenCount,
} from '@ledgermind/domain';

import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type {
  StructuredGenerationInput,
  StructuredGenerationPort,
  StructuredGenerationResult,
} from '../../ports/driven/llm/structured-generation.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerAppendPort } from '../../ports/driven/persistence/ledger-append.port';
import type {
  CreateOperatorRunWithTasksInput,
  OperatorExecutionPort,
  StoredOperatorRun,
  StoredOperatorTask,
} from '../../ports/driven/persistence/operator-execution.port';
import type { IntegrityReport, SummaryDagPort } from '../../ports/driven/persistence/summary-dag.port';
import type { UnitOfWork, UnitOfWorkPort } from '../../ports/driven/persistence/unit-of-work.port';
import type { LLMMapInput } from '../../ports/driving/operator-execution.port';
import { LLMMapUseCase } from '../llm-map';
import { ExecuteOperatorTaskUseCase } from '../execute-operator-task';

const conversationId = createConversationId('conv_execute_operator_task');

class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const date = new Date(Date.UTC(2026, 3, 13, 0, 0, this.tick));
    this.tick += 1;
    return createTimestamp(date);
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

class TestArtifactStore implements ArtifactStorePort {
  readonly storedMetadata = new Map<Artifact['id'], Artifact>();
  readonly storedContents = new Map<Artifact['id'], string | Uint8Array>();

  constructor(entries: readonly { artifact: Artifact; content: string | Uint8Array }[] = []) {
    for (const entry of entries) {
      this.storedMetadata.set(entry.artifact.id, entry.artifact);
      this.storedContents.set(entry.artifact.id, entry.content);
    }
  }

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<void> {
    this.storedMetadata.set(artifact.id, artifact);
    if (content !== undefined) {
      this.storedContents.set(artifact.id, content);
    }
  }

  async getMetadata(id: Artifact['id']): Promise<Artifact | null> {
    return this.storedMetadata.get(id) ?? null;
  }

  async getContent(id: Artifact['id']): Promise<string | Uint8Array | null> {
    return this.storedContents.get(id) ?? null;
  }

  async updateExploration(): Promise<void> {
    return;
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

class TestOperatorExecutionPort implements OperatorExecutionPort {
  readonly runs = new Map<string, StoredOperatorRun>();
  readonly tasksByRun = new Map<string, StoredOperatorTask[]>();
  readonly retryableFailures: Array<{
    taskId: string;
    failure: StoredOperatorTask['terminalFailure'];
    nextRetryAt: ReturnType<ClockPort['now']>;
  }> = [];
  readonly terminalFailures: Array<{ taskId: string; failure: StoredOperatorTask['terminalFailure'] }> = [];
  readonly successes: Array<{ taskId: string; output: unknown }> = [];
  readonly finalizationAttempts: string[] = [];

  async createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun> {
    const now = createTimestamp(new Date('2026-04-13T00:00:00.000Z'));
    const run: StoredOperatorRun = {
      runId: input.runId,
      conversationId: input.conversationId,
      operatorKind: input.operatorKind,
      status: input.taskCount === 0 ? 'completed' : 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      outputSchema: input.outputSchema,
      concurrencyLimit: input.concurrencyLimit,
      retryPolicy: input.retryPolicy,
      ...(input.inputArtifactId === undefined ? {} : { inputArtifactId: input.inputArtifactId }),
      finalizationStage: input.taskCount === 0 ? 'completed' : 'not_started',
      taskCount: input.taskCount,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      retryableFailureTaskCount: 0,
      runningTaskCount: 0,
      pendingTaskCount: input.taskCount,
    };
    const tasks = input.items.map<StoredOperatorTask>((_, itemIndex) => ({
      taskId: `${input.runId}:task:${String(itemIndex).padStart(4, '0')}`,
      runId: input.runId,
      conversationId: input.conversationId,
      itemIndex,
      status: 'pending',
      attemptCount: 0,
      bootstrapState: 'bootstrap_not_started',
    }));

    this.runs.set(run.runId, run);
    this.tasksByRun.set(run.runId, tasks);
    return run;
  }

  async getRun(runId: string): Promise<StoredOperatorRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async getTask(taskId: string): Promise<StoredOperatorTask | null> {
    for (const tasks of this.tasksByRun.values()) {
      const task = tasks.find((candidate) => candidate.taskId === taskId);
      if (task !== undefined) {
        return task;
      }
    }

    return null;
  }

  async listTasksForRun(runId: string): Promise<readonly StoredOperatorTask[]> {
    return this.tasksByRun.get(runId) ?? [];
  }

  async lookupRunByIdempotencyKey(): Promise<StoredOperatorRun | null> {
    return null;
  }

  async claimTaskLease(): Promise<StoredOperatorTask | null> {
    for (const [runId, tasks] of this.tasksByRun.entries()) {
      const nextIndex = tasks.findIndex((task) => task.status === 'pending' || task.status === 'retryable_failure');
      if (nextIndex === -1) {
        continue;
      }

      const task = tasks[nextIndex];
      if (task === undefined) {
        continue;
      }

      const claimed: StoredOperatorTask = {
        ...task,
        status: 'running',
        attemptCount: task.attemptCount + 1,
        leaseOwner: 'worker-test',
        leaseExpiresAt: createTimestamp(new Date('2026-04-13T00:05:00.000Z')),
      };
      tasks[nextIndex] = claimed;
      const run = this.runs.get(runId);
      if (run !== undefined) {
        this.runs.set(runId, {
          ...run,
          status: 'running',
          runningTaskCount: 1,
          pendingTaskCount: Math.max(0, run.pendingTaskCount - 1),
        });
      }
      return claimed;
    }

    return null;
  }

  async recordTaskSuccess(input: { taskId: string; output: unknown; completedAt: Date; resultArtifactId?: ArtifactId }): Promise<void> {
    void input.completedAt;
    this.successes.push({ taskId: input.taskId, output: input.output });
    for (const [runId, tasks] of this.tasksByRun.entries()) {
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      if (index === -1) {
        continue;
      }
      const current = tasks[index];
      if (current === undefined) {
        continue;
      }
      tasks[index] = {
        ...current,
        status: 'succeeded',
        ...(input.resultArtifactId === undefined ? {} : { resultArtifactId: input.resultArtifactId }),
      };
      const run = this.runs.get(runId);
      if (run !== undefined) {
        const updatedTasks = tasks;
        this.runs.set(runId, {
          ...run,
          status: updatedTasks.every((task) => task.status === 'succeeded') ? 'completed' : run.status,
          succeededTaskCount: updatedTasks.filter((task) => task.status === 'succeeded').length,
          failedTaskCount: updatedTasks.filter((task) => task.status === 'failed').length,
          retryableFailureTaskCount: updatedTasks.filter((task) => task.status === 'retryable_failure').length,
          runningTaskCount: updatedTasks.filter((task) => task.status === 'running').length,
          pendingTaskCount: updatedTasks.filter((task) => task.status === 'pending').length,
        });
      }
      return;
    }
  }

  async recordTaskFailure(input: { taskId: string; failure: NonNullable<StoredOperatorTask['terminalFailure']>; completedAt: Date }): Promise<void> {
    void input.completedAt;
    this.terminalFailures.push({ taskId: input.taskId, failure: input.failure });
    for (const [runId, tasks] of this.tasksByRun.entries()) {
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      if (index === -1) {
        continue;
      }
      const current = tasks[index];
      if (current === undefined) {
        continue;
      }
      tasks[index] = {
        ...current,
        status: 'failed',
        terminalFailure: input.failure,
      };
      const run = this.runs.get(runId);
      if (run !== undefined) {
        const updatedTasks = tasks;
        this.runs.set(runId, {
          ...run,
          status: updatedTasks.every((task) => task.status === 'failed') ? 'failed' : 'completed_with_failures',
          succeededTaskCount: updatedTasks.filter((task) => task.status === 'succeeded').length,
          failedTaskCount: updatedTasks.filter((task) => task.status === 'failed').length,
          retryableFailureTaskCount: updatedTasks.filter((task) => task.status === 'retryable_failure').length,
          runningTaskCount: updatedTasks.filter((task) => task.status === 'running').length,
          pendingTaskCount: updatedTasks.filter((task) => task.status === 'pending').length,
          terminalFailureSummary: input.failure,
        });
      }
      return;
    }
  }

  async markTaskRetryableFailure(input: {
    taskId: string;
    failure: NonNullable<StoredOperatorTask['terminalFailure']>;
    nextRetryAt: ReturnType<ClockPort['now']>;
  }): Promise<void> {
    this.retryableFailures.push({ taskId: input.taskId, failure: input.failure, nextRetryAt: input.nextRetryAt });
    for (const [runId, tasks] of this.tasksByRun.entries()) {
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      if (index === -1) {
        continue;
      }
      const current = tasks[index];
      if (current === undefined) {
        continue;
      }
      tasks[index] = {
        ...current,
        status: 'retryable_failure',
        terminalFailure: input.failure,
        nextRetryAt: input.nextRetryAt,
      };
      const run = this.runs.get(runId);
      if (run !== undefined) {
        const updatedTasks = tasks;
        this.runs.set(runId, {
          ...run,
          status: 'pending',
          succeededTaskCount: updatedTasks.filter((task) => task.status === 'succeeded').length,
          failedTaskCount: updatedTasks.filter((task) => task.status === 'failed').length,
          retryableFailureTaskCount: updatedTasks.filter((task) => task.status === 'retryable_failure').length,
          runningTaskCount: updatedTasks.filter((task) => task.status === 'running').length,
          pendingTaskCount: updatedTasks.filter((task) => task.status === 'pending').length,
        });
      }
      return;
    }
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
    return null;
  }

  async advanceFinalizationStage(): Promise<StoredOperatorRun['finalizationStage']> {
    return 'completed';
  }

  async finalizeRun(): Promise<StoredOperatorRun> {
    throw new Error('finalizeRun not needed in this test suite');
  }
}

class NoopLedgerAppendPort implements LedgerAppendPort {
  async appendEvents(): Promise<void> {
    return;
  }

  async getNextSequence(): Promise<ReturnType<typeof createSequenceNumber>> {
    return createSequenceNumber(1);
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
    readonly conversations: ConversationPort;
    readonly artifacts: ArtifactStorePort;
    readonly operators: OperatorExecutionPort;
  }) {
    this.uow = {
      ledger: new NoopLedgerAppendPort(),
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

class QueueingFinalizeOperatorRunUseCase {
  readonly calls: string[] = [];

  async execute(input: { runId: string }): Promise<void> {
    this.calls.push(input.runId);
  }
}

class SequencedStructuredGenerationPort implements StructuredGenerationPort {
  readonly calls: StructuredGenerationInput[] = [];

  constructor(private readonly results: readonly StructuredGenerationResult[]) {}

  async generate(input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
    this.calls.push(input);
    const next = this.results[this.calls.length - 1];
    if (next === undefined) {
      throw new Error('No structured generation result configured for test call.');
    }
    return next;
  }
}

const createConversationRecord = (id: ConversationId = conversationId): Conversation => {
  const config = createConversationConfig({
    modelName: 'gpt-4o-mini',
    contextWindow: createTokenCount(8_000),
    thresholds: createCompactionThresholds(0.7, 1),
  });

  return createConversation({
    id,
    config,
    createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
  });
};

const createUseCases = (generationResults: readonly StructuredGenerationResult[]) => {
  const artifactStore = new TestArtifactStore();
  const operators = new TestOperatorExecutionPort();
  const unitOfWork = new TestUnitOfWorkPort({
    conversations: new TestConversationStore([createConversationRecord()]),
    artifacts: artifactStore,
    operators,
  });

  const llmMap = new LLMMapUseCase({
    unitOfWork,
    idService: {
      generateArtifactId: ({ contentHashHex }: { contentHashHex: string }) => createArtifactId(`file_${contentHashHex.slice(0, 12)}`),
      generateEventId: () => {
        throw new Error('generateEventId not needed in this test suite');
      },
      generateSummaryId: () => {
        throw new Error('generateSummaryId not needed in this test suite');
      },
    },
    hashPort: new DeterministicHashPort(),
    tokenizer: new SimpleTokenizer(),
    clock: new DeterministicClock(),
  });
  const finalizeOperatorRun = new QueueingFinalizeOperatorRunUseCase();
  const executeOperatorTask = new ExecuteOperatorTaskUseCase({
    operatorExecution: operators,
    artifactStore,
    structuredGeneration: new SequencedStructuredGenerationPort(generationResults),
    finalizeOperatorRun,
    clock: new DeterministicClock(),
    workerId: 'worker-test',
  });

  return {
    llmMap,
    executeOperatorTask,
    operators,
    artifactStore,
    finalizeOperatorRun,
    structuredGeneration: executeOperatorTask['deps'].structuredGeneration as SequencedStructuredGenerationPort,
  };
};

const createInput = (overrides: {
  readonly items?: LLMMapInput['items'];
  readonly retryPolicy?: LLMMapInput['retryPolicy'];
} = {}): LLMMapInput => ({
  conversationId,
  prompt: 'Summarize the item.',
  outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  concurrencyLimit: 1,
  retryPolicy: overrides.retryPolicy ?? { maxRetries: 1, retryBackoffSeconds: 30 },
  items: overrides.items ?? [{ text: 'alpha' }],
});

describe('ExecuteOperatorTaskUseCase', () => {
  it('marks structured-generation validation failures as retryable until maxRetries is exhausted, then records a terminal failure with attemptCount details', async () => {
    const generationFailure: StructuredGenerationResult = {
      status: 'failed',
      failure: {
        code: 'SCHEMA_INVALID',
        message: 'Output did not match schema.',
        retryable: true,
      },
    };
    const { llmMap, executeOperatorTask, operators, finalizeOperatorRun } = createUseCases([
      generationFailure,
      generationFailure,
    ]);
    const submit = await llmMap.execute(createInput({ retryPolicy: { maxRetries: 1, retryBackoffSeconds: 30 } }));

    await executeOperatorTask.execute();
    let [taskAfterFirstAttempt] = await operators.listTasksForRun(submit.runId);

    expect(taskAfterFirstAttempt?.status).toBe('retryable_failure');
    expect(taskAfterFirstAttempt?.terminalFailure).toEqual({
      code: 'SCHEMA_INVALID',
      message: 'Output did not match schema.',
      retryable: true,
      attemptCount: 1,
    });
    expect(finalizeOperatorRun.calls).toHaveLength(0);

    await executeOperatorTask.execute();
    [taskAfterFirstAttempt] = await operators.listTasksForRun(submit.runId);

    expect(taskAfterFirstAttempt?.status).toBe('failed');
    expect(taskAfterFirstAttempt?.terminalFailure).toEqual({
      code: 'SCHEMA_INVALID',
      message: 'Output did not match schema.',
      retryable: false,
      attemptCount: 2,
    });
    expect(finalizeOperatorRun.calls).toEqual([submit.runId]);
  });

  it('records successful structured generation output and triggers finalization after a terminal task update', async () => {
    const { llmMap, executeOperatorTask, operators, finalizeOperatorRun } = createUseCases([
      {
        status: 'succeeded',
        output: { summary: 'alpha' },
      },
    ]);
    const submit = await llmMap.execute(createInput());

    await executeOperatorTask.execute();

    const [task] = await operators.listTasksForRun(submit.runId);
    expect(task?.status).toBe('succeeded');
    expect(finalizeOperatorRun.calls).toEqual([submit.runId]);
  });
});
