import type { ClockPort } from '../ports/driven/clock/clock.port';
import type {
  StructuredGenerationPort,
  StructuredGenerationResult,
} from '../ports/driven/llm/structured-generation.port';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { StoredOperatorTask } from '../ports/driven/persistence/operator-execution.port';
import type { OperatorFailureMetadata } from '../ports/driving/operator-execution.port';
import { createOperatorConfig, type OperatorConfig } from './operators/shared/operator-config';
import { loadOperatorDataset } from './operators/shared/input-dataset';

import type { OperatorExecutionPort } from '../ports/driven/persistence/operator-execution.port';

export interface ExecuteOperatorTaskUseCaseDeps {
  readonly operatorExecution: OperatorExecutionPort;
  readonly artifactStore: ArtifactStorePort;
  readonly structuredGeneration: StructuredGenerationPort;
  readonly finalizeOperatorRun: {
    execute(input: { readonly runId: string }): Promise<unknown>;
  };
  readonly clock: ClockPort;
  readonly workerId: string;
  readonly config?: Partial<OperatorConfig>;
}

const toFailureMetadata = (
  result: Extract<StructuredGenerationResult, { readonly status: 'failed' }>,
  attemptCount: number,
  retryable: boolean,
): OperatorFailureMetadata => ({
  ...result.failure,
  retryable,
  attemptCount,
});

export class ExecuteOperatorTaskUseCase {
  private readonly config: OperatorConfig;

  constructor(private readonly deps: ExecuteOperatorTaskUseCaseDeps) {
    this.config = createOperatorConfig(deps.config);
  }

  async execute(): Promise<{ readonly taskId: string; readonly runId: string; readonly status: StoredOperatorTask['status'] } | null> {
    const claimedTask = await this.deps.operatorExecution.claimTaskLease({
      workerId: this.deps.workerId,
      now: this.deps.clock.now(),
      leaseDurationSeconds: this.config.leaseDurationSeconds,
    });

    if (claimedTask === null) {
      return null;
    }

    const run = await this.deps.operatorExecution.getRun(claimedTask.runId);
    if (run === null) {
      throw new Error(`Operator run not found for claimed task ${claimedTask.taskId}.`);
    }

    if (run.operatorKind !== 'llmMap') {
      throw new Error(`ExecuteOperatorTaskUseCase does not support ${run.operatorKind} yet.`);
    }

    const dataset = await loadOperatorDataset(
      {
        conversationId: run.conversationId,
        ...(run.inputArtifactId === undefined ? {} : { inputArtifactId: run.inputArtifactId }),
      },
      {
        artifactStore: this.deps.artifactStore,
      },
    );
    const item = dataset.items[claimedTask.itemIndex];

    const result = await this.deps.structuredGeneration.generate({
      item,
      prompt: run.prompt ?? '',
      outputSchema: run.outputSchema,
      timeoutSeconds: this.config.executionTimeoutSeconds,
    });

    if (result.status === 'succeeded') {
      await this.deps.operatorExecution.recordTaskSuccess({
        taskId: claimedTask.taskId,
        output: result.output,
        completedAt: this.deps.clock.now(),
      });
      await this.deps.finalizeOperatorRun.execute({ runId: claimedTask.runId });
      return {
        taskId: claimedTask.taskId,
        runId: claimedTask.runId,
        status: 'succeeded',
      };
    }

    const maxAttempts = run.retryPolicy.maxRetries + 1;
    const hasRetriesRemaining = claimedTask.attemptCount < maxAttempts;
    if (result.failure.retryable && hasRetriesRemaining) {
      await this.deps.operatorExecution.markTaskRetryableFailure({
        taskId: claimedTask.taskId,
        failure: toFailureMetadata(result, claimedTask.attemptCount, true),
        nextRetryAt: new Date(
          this.deps.clock.now().getTime() + run.retryPolicy.retryBackoffSeconds * 1000,
        ) as ReturnType<ClockPort['now']>,
      });
      return {
        taskId: claimedTask.taskId,
        runId: claimedTask.runId,
        status: 'retryable_failure',
      };
    }

    await this.deps.operatorExecution.recordTaskFailure({
      taskId: claimedTask.taskId,
      failure: toFailureMetadata(result, claimedTask.attemptCount, false),
      completedAt: this.deps.clock.now(),
    });
    await this.deps.finalizeOperatorRun.execute({ runId: claimedTask.runId });
    return {
      taskId: claimedTask.taskId,
      runId: claimedTask.runId,
      status: 'failed',
    };
  }
}
