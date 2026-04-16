import type { ArtifactId } from '@ledgermind/domain';

import {
  ArtifactContentUnavailableError,
  ArtifactNotFoundError,
  OperatorInputValidationError,
  OperatorRunNotFoundError,
} from '../errors/application-errors';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type { OperatorExecutionPort } from '../ports/driven/persistence/operator-execution.port';
import type { GetOperatorRunInput, GetOperatorRunOutput, OperatorResultEntry } from '../ports/driving/operator-execution.port';
import { createOperatorConfig, type OperatorConfig } from './operators/shared/operator-config';

export interface GetOperatorRunUseCaseDeps {
  readonly operatorExecution: OperatorExecutionPort;
  readonly artifactStore: ArtifactStorePort;
  readonly config?: Partial<OperatorConfig>;
}

const parseInlineResults = async (
  outputArtifactId: ArtifactId | undefined,
  artifactStore: ArtifactStorePort,
  maxInlineRunResultsBytes: number,
): Promise<readonly OperatorResultEntry[] | undefined> => {
  if (outputArtifactId === undefined) {
    return undefined;
  }

  const artifact = await artifactStore.getMetadata(outputArtifactId);
  if (artifact === null) {
    throw new ArtifactNotFoundError(outputArtifactId);
  }

  const content = await artifactStore.getContent(outputArtifactId);
  if (typeof content !== 'string') {
    throw new ArtifactContentUnavailableError(outputArtifactId);
  }

  if (Buffer.byteLength(content, 'utf8') > maxInlineRunResultsBytes) {
    return undefined;
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const parsed = lines.map((line) => JSON.parse(line) as OperatorResultEntry);
  parsed.sort((left, right) => left.itemIndex - right.itemIndex);
  return parsed;
};

export class GetOperatorRunUseCase {
  private readonly config: OperatorConfig;

  constructor(private readonly deps: GetOperatorRunUseCaseDeps) {
    this.config = createOperatorConfig(deps.config);
  }

  async execute(input: GetOperatorRunInput): Promise<GetOperatorRunOutput> {
    if (input.runId.trim().length === 0) {
      throw new OperatorInputValidationError('runId is required.');
    }

    const run = await this.deps.operatorExecution.getRun(input.runId);
    if (run === null) {
      throw new OperatorRunNotFoundError(input.runId);
    }

    const tasks = await this.deps.operatorExecution.listTasksForRun(run.runId);
    const inlineResults = await parseInlineResults(
      run.outputArtifactId,
      this.deps.artifactStore,
      this.config.maxInlineRunResultsBytes,
    );

    return {
      runId: run.runId,
      conversationId: run.conversationId,
      operatorKind: run.operatorKind,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
      ...(run.inputArtifactId === undefined ? {} : { inputArtifactId: run.inputArtifactId }),
      ...(run.outputArtifactId === undefined ? {} : { outputArtifactId: run.outputArtifactId }),
      taskCount: run.taskCount,
      succeededTaskCount: run.succeededTaskCount,
      failedTaskCount: run.failedTaskCount,
      retryableFailureTaskCount: run.retryableFailureTaskCount,
      runningTaskCount: run.runningTaskCount,
      pendingTaskCount: run.pendingTaskCount,
      ...(run.terminalFailureSummary === undefined
        ? {}
        : { terminalFailureSummary: run.terminalFailureSummary }),
      ...(inlineResults === undefined ? {} : { inlineResults }),
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        itemIndex: task.itemIndex,
        status: task.status,
        attemptCount: task.attemptCount,
        ...(task.childConversationId === undefined
          ? {}
          : { childConversationId: task.childConversationId }),
        ...(task.resultArtifactId === undefined
          ? {}
          : { resultArtifactId: task.resultArtifactId }),
        ...(task.terminalFailure === undefined
          ? {}
          : { terminalFailure: task.terminalFailure }),
      })),
    };
  }
}
