import { describe, expect, it } from 'vitest';

import {
  AgenticMapUseCase,
  ExecuteOperatorTaskUseCase,
  FinalizeOperatorRunUseCase,
  type ClockPort,
  type UnitOfWorkPort,
  createOperatorConfig,
  type StructuredGenerationPort,
} from '@ledgermind/application';
import {
  InMemoryArtifactStore,
  InMemoryConversationStore,
  InMemoryContextProjection,
  InMemoryJobQueueAdapter,
  InMemoryLedgerStore,
  InMemoryOperatorExecutionStore,
  InMemorySummaryDag,
  SimpleTokenizerAdapter,
  createInMemoryPersistenceState,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversationConfig,
  createIdService,
  createTimestamp,
  createTokenCount,
  type HashPort,
} from '@ledgermind/domain';
import { createOperatorWorker } from '../../apps/operator-worker/src/index';

const baseNow = Date.UTC(2026, 3, 13, 0, 0, 0);

class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const value = new Date(baseNow + this.tick * 1000);
    this.tick += 1;
    return createTimestamp(value);
  }
}

class ManualClock implements ClockPort {
  constructor(private currentMs: number = baseNow) {}

  now() {
    return createTimestamp(new Date(this.currentMs));
  }

  advanceSeconds(seconds: number): void {
    this.currentMs += seconds * 1000;
  }
}

class DeterministicHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
}

const createRuntime = () => {
  const state = createInMemoryPersistenceState();
  const artifactStore = new InMemoryArtifactStore(state);
  const operatorExecution = new InMemoryOperatorExecutionStore(state);
  const conversations = new InMemoryConversationStore(state);
  const ledger = new InMemoryLedgerStore(state);
  const context = new InMemoryContextProjection(state);
  const dag = new InMemorySummaryDag(state);

  return {
    state,
    artifactStore,
    operatorExecution,
    conversations,
    ledger,
    context,
    dag,
  };
};

const createConversation = async (runtime: ReturnType<typeof createRuntime>) => {
  return runtime.conversations.create(
    createConversationConfig({
      modelName: 'operator-worker-regression',
      contextWindow: createTokenCount(16_384),
      thresholds: createCompactionThresholds(0.6, 0.9),
    }),
  );
};

const createUnitOfWork = (runtime: ReturnType<typeof createRuntime>): UnitOfWorkPort => {
  return {
    async execute<T>(work: (uow: {
      readonly ledger: InMemoryLedgerStore;
      readonly context: InMemoryContextProjection;
      readonly dag: InMemorySummaryDag;
      readonly artifacts: InMemoryArtifactStore;
      readonly conversations: InMemoryConversationStore;
      readonly operators: InMemoryOperatorExecutionStore;
    }) => Promise<T>): Promise<T> {
      return work({
        ledger: runtime.ledger,
        context: runtime.context,
        dag: runtime.dag,
        artifacts: runtime.artifactStore,
        conversations: runtime.conversations,
        operators: runtime.operatorExecution,
      });
    },
  };
};

const createFinalizeUseCase = (runtime: ReturnType<typeof createRuntime>, clock: ClockPort) => {
  const hashPort = new DeterministicHashPort();
  return new FinalizeOperatorRunUseCase({
    unitOfWork: createUnitOfWork(runtime),
    idService: createIdService(hashPort),
    hashPort,
    tokenizer: new SimpleTokenizerAdapter(),
    clock,
  });
};

describe('operator worker regressions', () => {
  it('treats duplicate queue wake-up delivery as harmless', async () => {
    const executeCalls: string[] = [];
    const waitCalls: number[] = [];
    const queue = new InMemoryJobQueueAdapter();
    let shouldClaim = true;

    const worker = createOperatorWorker({
      config: {
        storage: { type: 'in-memory' },
        pollIntervalMs: 250,
        batchSize: 1,
        workerId: 'worker-duplicate-delivery',
        jobQueue: queue,
        operators: {
          structuredGeneration: {
            async generate() {
              executeCalls.push('generate');
              shouldClaim = false;
              return {
                status: 'succeeded',
                output: { ok: true },
              };
            },
          } satisfies StructuredGenerationPort,
        },
      },
      wait: async (ms: number) => {
        waitCalls.push(ms);
      },
    });

    worker.executeOperatorTaskUseCase.execute = async () => {
      if (!shouldClaim) {
        return null;
      }

      executeCalls.push('task');
      shouldClaim = false;
      return {
        runId: 'run_duplicate',
        taskId: 'task_duplicate',
        status: 'succeeded',
      };
    };

    worker.finalizeOperatorRunUseCase.execute = async () => {
      executeCalls.push('finalize');
      return {
        runId: 'run_duplicate',
        status: 'completed',
      };
    };

    const idle = worker.pollLoop.waitForNextCycle();
    await queue.enqueue({
      type: 'operator-run-created',
      payload: { runId: 'run_duplicate', conversationId: 'conv_duplicate' },
      priority: 'normal',
    });
    await queue.enqueue({
      type: 'operator-run-created',
      payload: { runId: 'run_duplicate', conversationId: 'conv_duplicate' },
      priority: 'normal',
    });
    await idle;

    await worker.pollLoop.runIteration();

    expect(executeCalls).toEqual(['task', 'finalize']);
    expect(waitCalls).toEqual([]);
  });

  it('reuses the same child conversation after a crash before bootstrap completion', async () => {
    const runtime = createRuntime();
    const rootConversation = await createConversation(runtime);
    const clock = new ManualClock();
    const hashPort = new DeterministicHashPort();
    const tokenizer = new SimpleTokenizerAdapter();
    const jobQueue = new InMemoryJobQueueAdapter();

    const submit = new AgenticMapUseCase({
      unitOfWork: createUnitOfWork(runtime),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer,
      clock,
      jobQueue,
    });

    const submitted = await submit.execute({
      conversationId: rootConversation.id,
      taskPrompt: 'Bootstrap child once and keep using it.',
      items: [{ label: 'recoverable', depth: 0 }],
      delegatedScope: { note: 'scope for crash recovery' },
      keptWork: {
        description: 'keep only a compact result in the parent',
        expectedOutput: 'Return a structured JSON object.',
      },
      outputSchema: {
        type: 'object',
        required: ['summary'],
      },
      concurrencyLimit: 1,
      retryPolicy: {
        maxRetries: 1,
        retryBackoffSeconds: 1,
      },
    });

    const finalize = createFinalizeUseCase(runtime, clock);
    const crashBeforeBootstrap = new ExecuteOperatorTaskUseCase({
      operatorExecution: runtime.operatorExecution,
      artifactStore: runtime.artifactStore,
      structuredGeneration: {
        async generate() {
          return {
            status: 'succeeded',
            output: { unused: true },
          };
        },
      },
      finalizeOperatorRun: finalize,
      clock,
      workerId: 'worker-crash-1',
      unitOfWork: createUnitOfWork(runtime),
      delegationScopeResolver: {
        async resolve() {
          return {
            bootstrapEvents: [],
            childArtifacts: [],
            sourceReferenceIds: [],
          };
        },
      },
      subAgentExecutor: {
        async execute() {
          throw new Error('Sub-agent executor should not run before bootstrap completes.');
        },
      },
      tokenizer,
      idService: createIdService(hashPort),
    });

    const originalAppendEvents = runtime.ledger.appendEvents.bind(runtime.ledger);
    let crashInjected = false;
    runtime.ledger.appendEvents = async (...args) => {
      await originalAppendEvents(...args);
      if (!crashInjected) {
        crashInjected = true;
        throw new Error('simulated worker crash after child creation');
      }
    };

    await expect(crashBeforeBootstrap.execute()).rejects.toThrow('simulated worker crash after child creation');

    const taskAfterCrash = (await runtime.operatorExecution.listTasksForRun(submitted.runId))[0];
    expect(taskAfterCrash?.childConversationId).toBeDefined();
    expect(taskAfterCrash?.bootstrapState).toBe('bootstrap_in_progress');
    const childConversationId = taskAfterCrash?.childConversationId;
    if (childConversationId === undefined) {
      throw new Error('Expected child conversation to be created before crash.');
    }

    runtime.ledger.appendEvents = originalAppendEvents;

    const recoveredExecutorCalls: string[] = [];
    const recovered = new ExecuteOperatorTaskUseCase({
      operatorExecution: runtime.operatorExecution,
      artifactStore: runtime.artifactStore,
      structuredGeneration: {
        async generate() {
          return {
            status: 'succeeded',
            output: { unused: true },
          };
        },
      },
      finalizeOperatorRun: finalize,
      clock,
      workerId: 'worker-crash-2',
      unitOfWork: createUnitOfWork(runtime),
      delegationScopeResolver: {
        async resolve() {
          return {
            bootstrapEvents: [],
            childArtifacts: [],
            sourceReferenceIds: [],
          };
        },
      },
      subAgentExecutor: {
        async execute(input) {
          recoveredExecutorCalls.push(input.childConversationId);
          return {
            status: 'succeeded',
            output: { summary: 'recovered after crash' },
          };
        },
      },
      tokenizer,
      idService: createIdService(hashPort),
    });

    clock.advanceSeconds(createOperatorConfig().leaseDurationSeconds + 1);
    while ((await recovered.execute()) !== null) {
      // keep draining until the recovered task finishes and finalization runs
    }

    const taskAfterRecovery = (await runtime.operatorExecution.listTasksForRun(submitted.runId))[0];
    expect(taskAfterRecovery?.childConversationId).toBe(childConversationId);
    expect(taskAfterRecovery?.bootstrapState).toBe('bootstrap_completed');
  });

  it('allows lease expiry so another worker can recover and finish the task', async () => {
    const runtime = createRuntime();
    const rootConversation = await createConversation(runtime);
    const clock = new ManualClock();
    const hashPort = new DeterministicHashPort();
    const tokenizer = new SimpleTokenizerAdapter();

    const submit = new AgenticMapUseCase({
      unitOfWork: createUnitOfWork(runtime),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer,
      clock,
    });

    const submitted = await submit.execute({
      conversationId: rootConversation.id,
      taskPrompt: 'Recover expired leases.',
      items: [{ label: 'lease', depth: 0 }],
      delegatedScope: { note: 'lease scope' },
      keptWork: {
        description: 'finish after another worker crashes',
        expectedOutput: 'Return structured JSON.',
      },
      outputSchema: {
        type: 'object',
        required: ['summary'],
      },
      concurrencyLimit: 1,
      retryPolicy: {
        maxRetries: 1,
        retryBackoffSeconds: 1,
      },
    });

    const firstClaim = await runtime.operatorExecution.claimTaskLease({
      workerId: 'worker-expired-1',
      now: clock.now(),
      leaseDurationSeconds: createOperatorConfig().leaseDurationSeconds,
    });
    expect(firstClaim).not.toBeNull();

    const secondClaimBeforeExpiry = await runtime.operatorExecution.claimTaskLease({
      workerId: 'worker-expired-2',
      now: clock.now(),
      leaseDurationSeconds: createOperatorConfig().leaseDurationSeconds,
    });
    expect(secondClaimBeforeExpiry).toBeNull();

    clock.advanceSeconds(createOperatorConfig().leaseDurationSeconds + 1);

    const finalize = createFinalizeUseCase(runtime, clock);
    const recoveringExecutor = new ExecuteOperatorTaskUseCase({
      operatorExecution: runtime.operatorExecution,
      artifactStore: runtime.artifactStore,
      structuredGeneration: {
        async generate() {
          return {
            status: 'succeeded',
            output: { unused: true },
          };
        },
      },
      finalizeOperatorRun: finalize,
      clock,
      workerId: 'worker-expired-2',
      unitOfWork: createUnitOfWork(runtime),
      delegationScopeResolver: {
        async resolve() {
          return {
            bootstrapEvents: [],
            childArtifacts: [],
            sourceReferenceIds: [],
          };
        },
      },
      subAgentExecutor: {
        async execute() {
          return {
            status: 'succeeded',
            output: { summary: 'lease recovered' },
          };
        },
      },
      tokenizer,
      idService: createIdService(hashPort),
    });

    while ((await recoveringExecutor.execute()) !== null) {
      // keep draining until the reclaimed task finishes and finalization runs
    }

    const task = (await runtime.operatorExecution.listTasksForRun(submitted.runId))[0];
    expect(task?.status).toBe('succeeded');
    expect(task?.attemptCount).toBe(2);
    expect(task?.leaseOwner).toBeUndefined();
  });

  it('resumes finalization retry from the persisted stage after a partial success', async () => {
    const runtime = createRuntime();
    const rootConversation = await createConversation(runtime);
    const clock = new DeterministicClock();
    const hashPort = new DeterministicHashPort();
    const tokenizer = new SimpleTokenizerAdapter();

    const submit = new AgenticMapUseCase({
      unitOfWork: createUnitOfWork(runtime),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer,
      clock,
    });

    const submitted = await submit.execute({
      conversationId: rootConversation.id,
      taskPrompt: 'Resume finalization from artifact_written.',
      items: [{ label: 'finalize', depth: 0 }],
      delegatedScope: { note: 'finalization scope' },
      keptWork: {
        description: 'persist the stage and resume safely',
        expectedOutput: 'Return structured JSON.',
      },
      outputSchema: {
        type: 'object',
        required: ['summary'],
      },
      concurrencyLimit: 1,
      retryPolicy: {
        maxRetries: 0,
        retryBackoffSeconds: 1,
      },
    });

    const task = (await runtime.operatorExecution.listTasksForRun(submitted.runId))[0];
    expect(task).toBeDefined();
    if (task === undefined) {
      throw new Error('Expected operator task.');
    }

    await runtime.operatorExecution.recordTaskSuccess({
      taskId: task.taskId,
      output: { summary: 'partial finalization' },
      completedAt: clock.now(),
    });

    const partialFinalize = createFinalizeUseCase(runtime, clock);
    const originalStore = runtime.artifactStore.store.bind(runtime.artifactStore);
    let crashInjected = false;
    runtime.artifactStore.store = async (artifact, content) => {
      await originalStore(artifact, content);
      if (!crashInjected && artifact.mimeType === 'application/x-ndjson') {
        crashInjected = true;
        const run = await runtime.operatorExecution.getRun(submitted.runId);
        if (run !== null) {
          runtime.state.operatorRunsById.set(submitted.runId, {
            ...run,
            outputArtifactId: artifact.id,
            finalizationStage: 'artifact_written',
            needsFinalizationRetry: true,
          });
        }
        throw new Error('simulated crash after artifact write');
      }
    };

    await expect(partialFinalize.execute({ runId: submitted.runId })).rejects.toThrow('simulated crash after artifact write');

    const runAfterCrash = await runtime.operatorExecution.getRun(submitted.runId);
    expect(runAfterCrash?.finalizationStage).toBe('artifact_written');
    expect(runAfterCrash?.needsFinalizationRetry).toBe(true);

    runtime.artifactStore.store = originalStore;

    const worker = createOperatorWorker({
      config: {
        storage: { type: 'in-memory' },
        pollIntervalMs: 100,
        batchSize: 1,
        workerId: 'worker-finalization-retry',
        operators: {
          structuredGeneration: {
            async generate() {
              return {
                status: 'succeeded',
                output: { ok: true },
              };
            },
          },
        },
      },
    });

    worker.finalizeOperatorRunUseCase.execute = partialFinalize.execute.bind(partialFinalize);
    worker.executeOperatorTaskUseCase.execute = async () => null;

    await worker.pollLoop.runIteration();

    const finalizedRun = await runtime.operatorExecution.getRun(submitted.runId);
    expect(finalizedRun?.finalizationStage).toBe('completed');
    expect(finalizedRun?.needsFinalizationRetry).toBe(false);
    expect(finalizedRun?.parentHandleAppendedAt).toBeDefined();
  });
});
