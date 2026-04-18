import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createIdService,
  createMimeType,
  createTimestamp,
  createTokenCount,
  type Artifact,
} from '@ledgermind/domain';

import {
  ArtifactContentUnavailableError,
  ConversationNotFoundError,
  OperatorInputValidationError,
} from '../../errors/application-errors';
import type { Job, JobId, JobQueuePort } from '../../ports/driven/jobs/job-queue.port';
import type { AgenticMapInput } from '../../ports/driving/operator-execution.port';
import { AgenticMapUseCase } from '../agentic-map';
import {
  DeterministicClock,
  DeterministicHashPort,
  DeterministicOperatorExecutionPort,
  InMemoryArtifactStoreDouble,
  InMemoryConversationStoreDouble,
  SimpleTokenizerDouble,
  createOperatorUnitOfWorkPort,
} from './operator-test-doubles';

const conversationId = createConversationId('conv_agentic_map_test');
const childConversationId = createConversationId('conv_agentic_map_child');
const otherConversationId = createConversationId('conv_agentic_map_other');
const hashPort = new DeterministicHashPort();
const idService = createIdService(hashPort);
const existingArtifactId = idService.generateArtifactId({
  contentHashHex: 'ab'.repeat(32),
});
const invalidArtifactId = idService.generateArtifactId({
  contentHashHex: 'cd'.repeat(32),
});

class RecordingJobQueue implements JobQueuePort {
  readonly enqueued: Job[] = [];

  async enqueue(job: Job): Promise<JobId> {
    this.enqueued.push(job);
    return `job_${this.enqueued.length}` as JobId;
  }

  async subscribe() {
    return {
      close(): void {
        return;
      },
    };
  }
}

const createConversationEntity = (id: typeof conversationId, parentId: typeof conversationId | null = null) =>
  createConversation({
    id,
    parentId,
    config: createConversationConfig({
      modelName: 'gpt-4.1-mini',
      contextWindow: createTokenCount(8_192),
      thresholds: createCompactionThresholds(0.6, 0.8),
    }),
    createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
  });

const createArtifactRecord = (input: {
  artifactId: Artifact['id'];
  conversationId: typeof conversationId;
  content: string | Uint8Array;
}): { artifact: Artifact; content: string | Uint8Array } => ({
  artifact: createArtifact({
    id: input.artifactId,
    conversationId: input.conversationId,
    storageKind: 'inline_text',
    mimeType: createMimeType('application/json'),
    tokenCount: createTokenCount(typeof input.content === 'string' ? input.content.length : input.content.byteLength),
  }),
  content: input.content,
});

const createBaseInput = (): AgenticMapInput => ({
  conversationId,
  taskPrompt: 'Extract one action item.',
  delegatedScope: {
    note: 'Only use the selected references.',
    messageIds: ['evt_1'],
  },
  keptWork: {
    description: 'Keep a concise child summary and final structured output.',
    expectedOutput: 'JSON object with action and owner.',
  },
  outputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      owner: { type: 'string' },
    },
    required: ['action', 'owner'],
  },
  concurrencyLimit: 2,
  retryPolicy: {
    maxRetries: 1,
    retryBackoffSeconds: 30,
  },
  items: [{ title: 'Follow up with finance' }, { title: 'Schedule customer call' }],
});

const createArtifactBackedInput = (inputArtifactId: Artifact['id']): AgenticMapInput => {
  const baseInput = createBaseInput();

  return {
    conversationId: baseInput.conversationId,
    taskPrompt: baseInput.taskPrompt,
    delegatedScope: baseInput.delegatedScope,
    keptWork: baseInput.keptWork,
    outputSchema: baseInput.outputSchema,
    concurrencyLimit: baseInput.concurrencyLimit,
    retryPolicy: baseInput.retryPolicy,
    ...(baseInput.prompt === undefined ? {} : { prompt: baseInput.prompt }),
    ...(baseInput.idempotencyKey === undefined ? {} : { idempotencyKey: baseInput.idempotencyKey }),
    inputArtifactId,
  };
};

const createUseCase = (input?: {
  readonly conversations?: readonly ReturnType<typeof createConversationEntity>[];
  readonly artifacts?: readonly { artifact: Artifact; content: string | Uint8Array }[];
  readonly operatorExecution?: DeterministicOperatorExecutionPort;
  readonly jobQueue?: JobQueuePort;
  readonly maxKeptWorkChars?: number;
}) => {
  const artifactStore = new InMemoryArtifactStoreDouble(input?.artifacts ?? []);
  const conversationStore = new InMemoryConversationStoreDouble(
    input?.conversations ?? [createConversationEntity(conversationId)],
  );
  const operatorExecution = input?.operatorExecution ?? new DeterministicOperatorExecutionPort();
  const jobQueue = input?.jobQueue;

  const useCase = new AgenticMapUseCase({
    unitOfWork: createOperatorUnitOfWorkPort({
      artifactStore,
      conversations: conversationStore,
      operators: operatorExecution,
    }),
    idService,
    hashPort,
    tokenizer: new SimpleTokenizerDouble(),
    clock: new DeterministicClock(),
    ...(jobQueue === undefined ? {} : { jobQueue }),
    ...(input?.maxKeptWorkChars === undefined ? {} : { config: { maxKeptWorkChars: input.maxKeptWorkChars } }),
  });

  return {
    useCase,
    artifactStore,
    conversationStore,
    operatorExecution,
    jobQueue,
  };
};

describe('AgenticMapUseCase', () => {
  it('rejects a missing delegated scope', async () => {
    const { useCase } = createUseCase();
    const input = {
      ...createBaseInput(),
      delegatedScope: undefined,
    } as unknown as AgenticMapInput;

    await expect(useCase.execute(input)).rejects.toThrowError(OperatorInputValidationError);
    await expect(useCase.execute(input)).rejects.toThrow('delegatedScope is required');
  });

  it('rejects a missing kept-work description', async () => {
    const { useCase } = createUseCase();
    const input = {
      ...createBaseInput(),
      keptWork: {
        ...createBaseInput().keptWork,
        description: '   ',
      },
    };

    await expect(useCase.execute(input)).rejects.toThrowError(OperatorInputValidationError);
    await expect(useCase.execute(input)).rejects.toThrow('keptWork.description is required');
  });

  it('rejects an oversized kept-work description', async () => {
    const { useCase } = createUseCase({ maxKeptWorkChars: 16 });
    const input = {
      ...createBaseInput(),
      keptWork: {
        ...createBaseInput().keptWork,
        description: 'x'.repeat(17),
      },
    };

    await expect(useCase.execute(input)).rejects.toThrowError(OperatorInputValidationError);
    await expect(useCase.execute(input)).rejects.toThrow('keptWork.description exceeds maxKeptWorkChars');
  });

  it('rejects recursive child-originated delegation when delegated scope is missing', async () => {
    const { useCase } = createUseCase({
      conversations: [
        createConversationEntity(conversationId),
        createConversationEntity(childConversationId, conversationId),
      ],
    });
    const input = {
      ...createBaseInput(),
      conversationId: childConversationId,
      delegatedScope: undefined,
    } as unknown as AgenticMapInput;

    await expect(useCase.execute(input)).rejects.toThrowError(OperatorInputValidationError);
    await expect(useCase.execute(input)).rejects.toThrow('Child-originated agenticMap submissions require delegatedScope');
  });

  it('rejects recursive child-originated delegation when kept work is missing', async () => {
    const { useCase } = createUseCase({
      conversations: [
        createConversationEntity(conversationId),
        createConversationEntity(childConversationId, conversationId),
      ],
    });
    const input = {
      ...createBaseInput(),
      conversationId: childConversationId,
      keptWork: undefined,
    } as unknown as AgenticMapInput;

    await expect(useCase.execute(input)).rejects.toThrowError(OperatorInputValidationError);
    await expect(useCase.execute(input)).rejects.toThrow('Child-originated agenticMap submissions require keptWork');
  });

  it('rejects artifact-backed datasets from another conversation', async () => {
    const { useCase } = createUseCase({
      artifacts: [
        createArtifactRecord({
          artifactId: existingArtifactId,
          conversationId: otherConversationId,
          content: JSON.stringify([{ item: 1 }]),
        }),
      ],
    });

    await expect(useCase.execute(createArtifactBackedInput(existingArtifactId))).rejects.toThrowError(
      OperatorInputValidationError,
    );
  });

  it('rejects artifact-backed datasets that are not one JSON array payload', async () => {
    const { useCase } = createUseCase({
      artifacts: [
        createArtifactRecord({
          artifactId: invalidArtifactId,
          conversationId,
          content: JSON.stringify({ item: 1 }),
        }),
      ],
    });

    await expect(useCase.execute(createArtifactBackedInput(invalidArtifactId))).rejects.toThrowError(
      OperatorInputValidationError,
    );
  });

  it('completes zero-item submission immediately without creating child conversations and still writes an empty output artifact', async () => {
    const operatorExecution = new DeterministicOperatorExecutionPort();
    const jobQueue = new RecordingJobQueue();
    const { useCase, artifactStore, conversationStore } = createUseCase({
      operatorExecution,
      jobQueue,
    });

    const output = await useCase.execute({
      ...createBaseInput(),
      items: [],
    });

    expect(output.status).toBe('completed');
    const run = await operatorExecution.getRun(output.runId);
    expect(run?.outputArtifactId).toBeDefined();
    expect(run?.finalizationStage).toBe('completed');
    expect(conversationStore.createCalls).toHaveLength(0);
    expect(jobQueue.enqueued).toHaveLength(0);
    const outputArtifactId = run?.outputArtifactId;
    expect(outputArtifactId).toBeDefined();
    await expect(artifactStore.getContent(outputArtifactId!)).resolves.toBe('');
  });

  it('persists task rows that start in bootstrap_not_started and stores durable child-bootstrap metadata', async () => {
    const operatorExecution = new DeterministicOperatorExecutionPort();
    const jobQueue = new RecordingJobQueue();
    const { useCase, artifactStore } = createUseCase({
      operatorExecution,
      jobQueue,
    });

    const output = await useCase.execute(createBaseInput());

    expect(output.status).toBe('pending');
    const run = await operatorExecution.getRun(output.runId);
    expect(run).not.toBeNull();
    expect(run?.operatorKind).toBe('agenticMap');
    expect(run?.taskPrompt).toBe('Extract one action item.');
    expect(run?.delegatedScope).toEqual(createBaseInput().delegatedScope);
    expect(run?.keptWork).toEqual(createBaseInput().keptWork);
    expect(run?.inputArtifactId).toBe(output.inputArtifactId);
    expect(run?.normalizedInputDigest).toBeDefined();
    const tasks = await operatorExecution.listTasksForRun(output.runId);
    expect(tasks.map((task) => task.bootstrapState)).toEqual(['bootstrap_not_started', 'bootstrap_not_started']);
    expect(jobQueue.enqueued).toHaveLength(1);
    expect(jobQueue.enqueued[0]?.type).toBe('operator-run-created');
    await expect(artifactStore.getMetadata(output.inputArtifactId!)).resolves.not.toBeNull();
  });

  it('throws when the target conversation does not exist', async () => {
    const { useCase } = createUseCase({ conversations: [] });

    await expect(useCase.execute(createBaseInput())).rejects.toThrowError(ConversationNotFoundError);
  });

  it('surfaces binary artifact payloads as unavailable dataset content', async () => {
    const { useCase } = createUseCase({
      artifacts: [
        createArtifactRecord({
          artifactId: invalidArtifactId,
          conversationId,
          content: new Uint8Array([1, 2, 3]),
        }),
      ],
    });

    await expect(useCase.execute(createArtifactBackedInput(invalidArtifactId))).rejects.toThrowError(
      ArtifactContentUnavailableError,
    );
  });
});
