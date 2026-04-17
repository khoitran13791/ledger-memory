import {
  createArtifact,
  createContextItem,
  createMessageContextItemRef,
  createMimeType,
  createSequenceNumber,
  createTokenCount,
  createLedgerEvent,
  type IdService,
} from '@ledgermind/domain';

import type { DelegationScopeResolverPort } from '../ports/driven/agents/delegation-scope-resolver.port';
import type { SubAgentExecutorPort, SubAgentExecutorResult } from '../ports/driven/agents/sub-agent-executor.port';
import type { ClockPort } from '../ports/driven/clock/clock.port';
import type {
  StructuredGenerationPort,
  StructuredGenerationResult,
} from '../ports/driven/llm/structured-generation.port';
import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
import type { ArtifactStorePort } from '../ports/driven/persistence/artifact-store.port';
import type {
  OperatorExecutionPort,
  StoredOperatorRun,
  StoredOperatorTask,
} from '../ports/driven/persistence/operator-execution.port';
import type { UnitOfWorkPort } from '../ports/driven/persistence/unit-of-work.port';
import type { NewLedgerEvent } from '../ports/driving/memory-engine.port';
import type { OperatorFailureMetadata } from '../ports/driving/operator-execution.port';
import { ConversationNotFoundError, OperatorFinalizationError } from '../errors/application-errors';
import { createOperatorConfig, type OperatorConfig } from './operators/shared/operator-config';
import { loadOperatorDataset } from './operators/shared/input-dataset';

export interface ExecuteOperatorTaskUseCaseDeps {
  readonly operatorExecution: OperatorExecutionPort;
  readonly artifactStore: ArtifactStorePort;
  readonly structuredGeneration: StructuredGenerationPort;
  readonly finalizeOperatorRun: {
    execute(input: { readonly runId: string }): Promise<unknown>;
  };
  readonly clock: ClockPort;
  readonly workerId: string;
  readonly unitOfWork?: UnitOfWorkPort;
  readonly subAgentExecutor?: SubAgentExecutorPort;
  readonly delegationScopeResolver?: DelegationScopeResolverPort;
  readonly tokenizer?: TokenizerPort;
  readonly idService?: IdService;
  readonly config?: Partial<OperatorConfig>;
}

const toFailureMetadata = (
  result:
    | Extract<StructuredGenerationResult, { readonly status: 'failed' }>
    | Extract<SubAgentExecutorResult, { readonly status: 'failed' }>,
  attemptCount: number,
  retryable: boolean,
): OperatorFailureMetadata => ({
  ...result.failure,
  retryable,
  attemptCount,
});

const validateStructuredOutput = (
  output: unknown,
  outputSchema: Readonly<Record<string, unknown>>,
): OperatorFailureMetadata | null => {
  const required = outputSchema['required'];
  if (!Array.isArray(required) || required.length === 0) {
    return null;
  }

  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return {
      code: 'SCHEMA_INVALID',
      message: 'Output did not match schema.',
      retryable: false,
    };
  }

  for (const key of required) {
    if (typeof key !== 'string') {
      continue;
    }
    if (!(key in output)) {
      return {
        code: 'SCHEMA_INVALID',
        message: 'Output did not match schema.',
        retryable: false,
      };
    }
  }

  return null;
};

const buildBootstrapEvents = (input: {
  task: StoredOperatorTask;
  run: StoredOperatorRun;
  item: unknown;
  scopeReferenceIds: readonly string[];
}): readonly NewLedgerEvent[] => {
  const events: NewLedgerEvent[] = [
    {
      role: 'system',
      content: 'You are executing a delegated agenticMap task.',
      tokenCount: createTokenCount(1),
    },
    {
      role: 'user',
      content: JSON.stringify({
        taskPrompt: input.run.taskPrompt,
        item: input.item,
        keptWork: input.run.keptWork,
      }),
      tokenCount: createTokenCount(1),
    },
  ];

  if (input.scopeReferenceIds.length > 0) {
    events.push({
      role: 'user',
      content: JSON.stringify({
        delegatedScope: input.run.delegatedScope,
        sourceReferenceIds: input.scopeReferenceIds,
      }),
      tokenCount: createTokenCount(1),
    });
  }

  return events;
};

export class ExecuteOperatorTaskUseCase {
  private readonly config: OperatorConfig;

  constructor(private readonly deps: ExecuteOperatorTaskUseCaseDeps) {
    this.config = createOperatorConfig(deps.config);
  }

  private async finalizeRunIfReady(runId: string): Promise<void> {
    try {
      await this.deps.finalizeOperatorRun.execute({ runId });
    } catch (error) {
      if (!(error instanceof OperatorFinalizationError)) {
        throw error;
      }
    }
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

    if (run.operatorKind === 'llmMap') {
      return this.executeLlmMapTask(claimedTask, run, item);
    }

    if (run.operatorKind === 'agenticMap') {
      return this.executeAgenticMapTask(claimedTask, run, item);
    }

    throw new Error(`ExecuteOperatorTaskUseCase does not support ${run.operatorKind}.`);
  }

  private async executeLlmMapTask(
    claimedTask: StoredOperatorTask,
    run: StoredOperatorRun,
    item: unknown,
  ): Promise<{ readonly taskId: string; readonly runId: string; readonly status: StoredOperatorTask['status'] }> {
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
      await this.finalizeRunIfReady(claimedTask.runId);
      return {
        taskId: claimedTask.taskId,
        runId: claimedTask.runId,
        status: 'succeeded',
      };
    }

    return this.recordFailureResult(claimedTask, run, result);
  }

  private async executeAgenticMapTask(
    claimedTask: StoredOperatorTask,
    run: StoredOperatorRun,
    item: unknown,
  ): Promise<{ readonly taskId: string; readonly runId: string; readonly status: StoredOperatorTask['status'] }> {
    if (
      this.deps.unitOfWork === undefined ||
      this.deps.subAgentExecutor === undefined ||
      this.deps.delegationScopeResolver === undefined
    ) {
      throw new Error('agenticMap execution requires unitOfWork, subAgentExecutor, and delegationScopeResolver.');
    }

    const childConversationId = await this.ensureChildConversation(claimedTask, run);
    if (childConversationId === undefined) {
      throw new Error(`Child conversation missing for operator task ${claimedTask.taskId}.`);
    }
    const bootstrapState = await this.deps.operatorExecution.getTaskBootstrapState(claimedTask.taskId);
    if (bootstrapState !== 'bootstrap_completed') {
      await this.bootstrapChildConversation({ claimedTask, run, item, childConversationId, bootstrapState });
    }

    const result = await this.deps.subAgentExecutor.execute({
      childConversationId,
      outputSchema: run.outputSchema,
      timeoutSeconds: this.config.executionTimeoutSeconds,
    });

    if (result.status === 'failed') {
      return this.recordFailureResult(claimedTask, run, result);
    }

    const schemaFailure = validateStructuredOutput(result.output, run.outputSchema);
    if (schemaFailure !== null) {
      await this.deps.operatorExecution.recordTaskFailure({
        taskId: claimedTask.taskId,
        failure: {
          ...schemaFailure,
          attemptCount: claimedTask.attemptCount,
        },
        completedAt: this.deps.clock.now(),
      });
      await this.finalizeRunIfReady(claimedTask.runId);
      return {
        taskId: claimedTask.taskId,
        runId: claimedTask.runId,
        status: 'failed',
      };
    }

    await this.deps.operatorExecution.recordTaskSuccess({
      taskId: claimedTask.taskId,
      output: result.output,
      completedAt: this.deps.clock.now(),
    });
    await this.finalizeRunIfReady(claimedTask.runId);
    return {
      taskId: claimedTask.taskId,
      runId: claimedTask.runId,
      status: 'succeeded',
    };
  }

  private async ensureChildConversation(
    claimedTask: StoredOperatorTask,
    run: StoredOperatorRun,
  ): Promise<StoredOperatorTask['childConversationId']> {
    const existingTask = await this.deps.operatorExecution.getTask(claimedTask.taskId);
    if (existingTask?.childConversationId !== undefined) {
      return existingTask.childConversationId;
    }

    if (this.deps.unitOfWork === undefined) {
      throw new Error('agenticMap execution requires unitOfWork.');
    }

    return this.deps.unitOfWork.execute(async (uow) => {
      const parentConversation = await uow.conversations.get(run.conversationId);
      if (parentConversation === null) {
        throw new ConversationNotFoundError(run.conversationId);
      }

      const childConversation = await uow.conversations.create(parentConversation.config, run.conversationId);
      return uow.operators.assignTaskChildConversation({
        taskId: claimedTask.taskId,
        childConversationId: childConversation.id,
      });
    });
  }

  private async bootstrapChildConversation(input: {
    claimedTask: StoredOperatorTask;
    run: StoredOperatorRun;
    item: unknown;
    childConversationId: NonNullable<StoredOperatorTask['childConversationId']>;
    bootstrapState: StoredOperatorTask['bootstrapState'];
  }): Promise<void> {
    if (this.deps.unitOfWork === undefined || this.deps.delegationScopeResolver === undefined) {
      throw new Error('agenticMap execution requires unitOfWork and delegationScopeResolver.');
    }

    const scope = input.run.delegatedScope;
    if (scope === undefined) {
      throw new Error(`Delegated scope missing for agenticMap run ${input.run.runId}.`);
    }

    const resolution = await this.deps.delegationScopeResolver.resolve(scope);
    if (input.bootstrapState === 'bootstrap_not_started') {
      await this.deps.operatorExecution.markBootstrapStarted(input.claimedTask.taskId);
    }

    await this.deps.unitOfWork.execute(async (uow) => {
      const childConversation = await uow.conversations.get(input.childConversationId as never);
      if (childConversation === null) {
        throw new ConversationNotFoundError(input.childConversationId as never);
      }

      const nextSequence = await uow.ledger.getNextSequence(input.childConversationId as never);
      const bootstrapEvents = buildBootstrapEvents({
        task: input.claimedTask,
        run: input.run,
        item: input.item,
        scopeReferenceIds: resolution.sourceReferenceIds,
      });
      const persistedEvents = bootstrapEvents.map((event, index) =>
        createLedgerEvent({
          id: this.deps.idService!.generateEventId({
            content: event.content,
            conversationId: input.childConversationId as never,
            role: event.role,
            sequence: createSequenceNumber(nextSequence + index),
          }),
          conversationId: input.childConversationId as never,
          sequence: createSequenceNumber(nextSequence + index),
          role: event.role,
          content: event.content,
          tokenCount: event.tokenCount,
          occurredAt: event.occurredAt ?? this.deps.clock.now(),
          metadata: event.metadata ?? {},
        }),
      );
      await uow.ledger.appendEvents(input.childConversationId as never, persistedEvents);
      await uow.context.appendContextItems(
        input.childConversationId as never,
        persistedEvents.map((event, index) =>
          createContextItem({
            conversationId: input.childConversationId as never,
            position: index,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );

      for (const childArtifact of resolution.childArtifacts) {
        const artifact = createArtifact({
          id: childArtifact.artifactId,
          conversationId: input.childConversationId as never,
          storageKind: 'inline_text',
          mimeType: createMimeType(childArtifact.mimeType),
          tokenCount: createTokenCount(1),
        });
        await uow.artifacts.store(artifact, childArtifact.content);
      }
    });

    await this.deps.operatorExecution.markBootstrapCompleted(input.claimedTask.taskId);
  }

  private async recordFailureResult(
    claimedTask: StoredOperatorTask,
    run: StoredOperatorRun,
    result:
      | Extract<StructuredGenerationResult, { readonly status: 'failed' }>
      | Extract<SubAgentExecutorResult, { readonly status: 'failed' }>,
  ): Promise<{ readonly taskId: string; readonly runId: string; readonly status: StoredOperatorTask['status'] }> {
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
    await this.finalizeRunIfReady(claimedTask.runId);
    return {
      taskId: claimedTask.taskId,
      runId: claimedTask.runId,
      status: 'failed',
    };
  }
}
