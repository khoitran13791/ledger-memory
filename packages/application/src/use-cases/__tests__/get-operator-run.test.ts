import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createArtifactId,
  createConversationId,
  createMimeType,
  createTimestamp,
  createTokenCount,
  type Artifact,
  type ArtifactId,
  type ConversationId,
} from '@ledgermind/domain';

import { OperatorRunNotFoundError } from '../../errors/application-errors';
import type {
  OperatorKind,
  OperatorResultEntry,
  OperatorRunStatus,
  OperatorTaskStatus,
} from '../../ports/driving/operator-execution.port';
import type {
  AssignTaskChildConversationInput,
  OperatorExecutionPort,
  StoredOperatorRun,
  StoredOperatorTask,
} from '../../ports/driven/persistence/operator-execution.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import { GetOperatorRunUseCase } from '../get-operator-run';
import { createOperatorConfig } from '../operators/shared/operator-config';

const conversationId = createConversationId('conv_operator_run_test');
const runId = 'run_operator_test';
const outputArtifactId = createArtifactId('file_operator_results');
const smallResults = [
  {
    itemIndex: 0,
    status: 'succeeded',
    output: { summary: 'alpha' },
  },
] satisfies readonly OperatorResultEntry[];

const createOutputArtifact = (artifactId: ArtifactId, content: string): Artifact =>
  createArtifact({
    id: artifactId,
    conversationId,
    storageKind: 'inline_text',
    mimeType: createMimeType('application/x-ndjson'),
    tokenCount: createTokenCount(content.length),
    explorationSummary: null,
    explorerUsed: null,
  });

class FakeArtifactStorePort implements ArtifactStorePort {
  private readonly artifacts = new Map<ArtifactId, Artifact>();
  private readonly contents = new Map<ArtifactId, string | Uint8Array>();

  constructor(entries: readonly { artifact: Artifact; content: string | Uint8Array }[] = []) {
    for (const entry of entries) {
      this.artifacts.set(entry.artifact.id, entry.artifact);
      this.contents.set(entry.artifact.id, entry.content);
    }
  }

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<void> {
    this.artifacts.set(artifact.id, artifact);
    if (content !== undefined) {
      this.contents.set(artifact.id, content);
    }
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    return this.artifacts.get(id) ?? null;
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    return this.contents.get(id) ?? null;
  }

  async updateExploration(): Promise<void> {
    throw new Error('updateExploration not needed in this test suite');
  }
}

const createStoredRun = (
  overrides: Partial<StoredOperatorRun> = {},
): StoredOperatorRun => ({
  runId,
  conversationId,
  operatorKind: 'llmMap' as OperatorKind,
  status: 'completed' as OperatorRunStatus,
  createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
  updatedAt: createTimestamp(new Date('2026-04-13T00:00:01.000Z')),
  completedAt: createTimestamp(new Date('2026-04-13T00:00:02.000Z')),
  outputSchema: { type: 'object' },
  concurrencyLimit: 1,
  retryPolicy: {
    maxRetries: 0,
    retryBackoffSeconds: 30,
  },
  outputArtifactId,
  taskCount: 1,
  succeededTaskCount: 1,
  failedTaskCount: 0,
  retryableFailureTaskCount: 0,
  runningTaskCount: 0,
  pendingTaskCount: 0,
  finalizationStage: 'completed',
  ...overrides,
});

const createStoredTask = (
  overrides: Partial<StoredOperatorTask> = {},
): StoredOperatorTask => ({
  taskId: 'task_operator_test_0',
  runId,
  conversationId,
  itemIndex: 0,
  status: 'succeeded' as OperatorTaskStatus,
  attemptCount: 1,
  bootstrapState: 'bootstrap_not_started',
  ...overrides,
});

class FakeOperatorExecutionPort implements OperatorExecutionPort {
  constructor(
    private readonly run: StoredOperatorRun | null,
    private readonly tasks: readonly StoredOperatorTask[] = [],
  ) {}

  async createRunWithTasks(): Promise<StoredOperatorRun> {
    throw new Error('createRunWithTasks not needed in this test suite');
  }

  async getRun(runIdInput: string): Promise<StoredOperatorRun | null> {
    return this.run?.runId === runIdInput ? this.run : null;
  }

  async getTask(): Promise<StoredOperatorTask | null> {
    return null;
  }

  async listTasksForRun(runIdInput: string): Promise<readonly StoredOperatorTask[]> {
    return runIdInput === this.run?.runId ? this.tasks : [];
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

  async assignTaskChildConversation(
    input: AssignTaskChildConversationInput,
  ): Promise<ConversationId> {
    void input;
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
    if (this.run === null) {
      throw new Error('finalizeRun not needed without a run');
    }

    return this.run;
  }
}

describe('GetOperatorRunUseCase', () => {
  it('inlines ordered results only when the serialized payload stays under the configured byte ceiling', async () => {
    const content = `${JSON.stringify(smallResults[0])}\n`;
    const artifactStore = new FakeArtifactStorePort([
      {
        artifact: createOutputArtifact(outputArtifactId, content),
        content,
      },
    ]);
    const operatorExecution = new FakeOperatorExecutionPort(createStoredRun(), [createStoredTask()]);
    const useCase = new GetOperatorRunUseCase({
      operatorExecution,
      artifactStore,
      config: createOperatorConfig({ maxInlineRunResultsBytes: content.length + 8 }),
    });

    const output = await useCase.execute({ runId });

    expect(output.inlineResults).toEqual(smallResults);
    expect(output.outputArtifactId).toBe(outputArtifactId);
    expect(output.tasks.map((task) => task.itemIndex)).toEqual([0]);
  });

  it('throws a dedicated error when the run does not exist', async () => {
    const useCase = new GetOperatorRunUseCase({
      operatorExecution: new FakeOperatorExecutionPort(null),
      artifactStore: new FakeArtifactStorePort(),
      config: createOperatorConfig(),
    });

    const execution = useCase.execute({ runId });

    await expect(execution).rejects.toBeInstanceOf(OperatorRunNotFoundError);
    await expect(execution).rejects.toMatchObject({
      code: 'OPERATOR_RUN_NOT_FOUND',
      runId,
    });
  });
});
