import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  Conversation,
  ConversationConfig,
  ConversationId,
  HashPort,
  IdService,
  SequenceNumber,
  SummaryNode,
  SummaryNodeId,
  TokenCount,
} from '@ledgermind/domain';
import {
  createArtifact,
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createIdService,
  createMimeType,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  type ContextItem,
  type LedgerEvent,
} from '@ledgermind/domain';

import {
  ConversationNotFoundError,
  IdempotencyConflictError,
  OperatorInputValidationError,
} from '../../errors/application-errors';
import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type { Job, JobId, JobQueuePort } from '../../ports/driven/jobs/job-queue.port';
import type { TokenizerPort } from '../../ports/driven/llm/tokenizer.port';
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

const conversationId = createConversationId('conv_llm_map_test');
const otherConversationId = createConversationId('conv_llm_map_other');
const existingArtifactId = createIdService(new (class implements HashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
})()).generateArtifactId({
  contentHashHex: 'ab'.repeat(32),
});

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

class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const date = new Date(Date.UTC(2026, 3, 13, 0, 0, this.tick));
    this.tick += 1;
    return createTimestamp(date);
  }
}

class SimpleTokenizer implements TokenizerPort {
  countTokens(text: string): TokenCount {
    return createTokenCount(Math.max(1, text.length));
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(Math.max(1, byteLength));
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
  private readonly runIdByLookupKey = new Map<string, string>();

  async createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun> {
    const lookupKey =
      input.idempotencyKey === undefined ? undefined : `${input.conversationId}::${input.idempotencyKey}`;

    if (lookupKey !== undefined) {
      const existingRunId = this.runIdByLookupKey.get(lookupKey);
      if (existingRunId !== undefined) {
        const existingRun = this.runs.get(existingRunId);
        if (existingRun === undefined) {
          throw new Error('Existing run missing from fake operator store.');
        }

        if (existingRun.normalizedInputDigest !== input.normalizedInputDigest) {
          const idempotencyKey = input.idempotencyKey;
          if (idempotencyKey === undefined) {
            throw new Error('Expected idempotencyKey for conflicting operator submission.');
          }
          throw new IdempotencyConflictError(input.conversationId, idempotencyKey);
        }

        return existingRun;
      }
    }

    const now = createTimestamp(new Date('2026-04-13T00:00:00.000Z'));
    const run: StoredOperatorRun = {
      runId: input.runId,
      conversationId: input.conversationId,
      operatorKind: input.operatorKind,
      status: input.taskCount === 0 ? 'completed' : 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.taskCount === 0 ? { completedAt: now } : {}),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      outputSchema: input.outputSchema,
      concurrencyLimit: input.concurrencyLimit,
      retryPolicy: input.retryPolicy,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.normalizedInputDigest === undefined
        ? {}
        : { normalizedInputDigest: input.normalizedInputDigest }),
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
    if (lookupKey !== undefined) {
      this.runIdByLookupKey.set(lookupKey, run.runId);
    }

    return run;
  }

  async getRun(runId: string): Promise<StoredOperatorRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async getTask(): Promise<StoredOperatorTask | null> {
    return null;
  }

  async listTasksForRun(runId: string): Promise<readonly StoredOperatorTask[]> {
    return this.tasksByRun.get(runId) ?? [];
  }

  async lookupRunByIdempotencyKey(
    conversationIdInput: ConversationId,
    idempotencyKey: string,
  ): Promise<StoredOperatorRun | null> {
    const runId = this.runIdByLookupKey.get(`${conversationIdInput}::${idempotencyKey}`);
    return runId === undefined ? null : (this.runs.get(runId) ?? null);
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
    return null;
  }

  async advanceFinalizationStage(): Promise<StoredOperatorRun['finalizationStage']> {
    return 'completed';
  }

  async finalizeRun(input: {
    readonly runId: string;
    readonly status: StoredOperatorRun['status'];
    readonly completedAt: StoredOperatorRun['createdAt'];
    readonly outputArtifactId?: Artifact['id'];
  }): Promise<StoredOperatorRun> {
    const existingRun = this.runs.get(input.runId);
    if (existingRun === undefined) {
      throw new Error(`Unknown run: ${input.runId}`);
    }

    const finalized: StoredOperatorRun = {
      ...existingRun,
      status: input.status,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
      finalizationStage: 'completed',
      ...(input.outputArtifactId === undefined ? {} : { outputArtifactId: input.outputArtifactId }),
      pendingTaskCount: 0,
    };
    this.runs.set(input.runId, finalized);
    return finalized;
  }
}

class NoopLedgerAppendPort implements LedgerAppendPort {
  async appendEvents(): Promise<void> {
    return;
  }

  async getNextSequence(): Promise<SequenceNumber> {
    return createSequenceNumber(1);
  }
}

class NoopContextProjectionPort implements ContextProjectionPort {
  async getCurrentContext(): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: number & { readonly __brand: 'ContextVersion' };
  }> {
    return { items: [], version: 0 as number & { readonly __brand: 'ContextVersion' } };
  }

  async getContextTokenCount(): Promise<TokenCount> {
    return createTokenCount(0);
  }

  async appendContextItems(): Promise<number & { readonly __brand: 'ContextVersion' }> {
    return 0 as number & { readonly __brand: 'ContextVersion' };
  }

  async replaceContextItems(): Promise<number & { readonly __brand: 'ContextVersion' }> {
    return 0 as number & { readonly __brand: 'ContextVersion' };
  }
}

class NoopSummaryDagPort implements SummaryDagPort {
  async createNode(): Promise<void> {
    return;
  }

  async getNode(): Promise<SummaryNode | null> {
    return null;
  }

  async addLeafEdges(): Promise<void> {
    return;
  }

  async addCondensedEdges(): Promise<void> {
    return;
  }

  async getParentSummaryIds(): Promise<readonly SummaryNode['id'][]> {
    return [];
  }

  async expandToMessages(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async searchSummaries(
    conversationIdInput?: ConversationId,
    queryInput?: string,
    scopeInput?: SummaryNodeId,
  ): Promise<readonly SummaryNode[]> {
    void conversationIdInput;
    void queryInput;
    void scopeInput;
    return [];
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    return { passed: true, checks: [] };
  }
}

class TestUnitOfWorkPort implements UnitOfWorkPort {
  readonly uow: UnitOfWork;

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

class TestJobQueue implements JobQueuePort {
  readonly jobs: Job[] = [];

  async enqueue<TPayload>(job: Job<TPayload>): Promise<JobId> {
    this.jobs.push(job);
    return `job_${this.jobs.length}` as JobId;
  }

  async subscribe() {
    return {
      close(): void {
        return;
      },
    };
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

const createArtifactRecord = (
  id: Artifact['id'],
  conversationIdInput: ConversationId,
  content: string,
): Artifact =>
  createArtifact({
    id,
    conversationId: conversationIdInput,
    storageKind: 'inline_text',
    mimeType: createMimeType('application/json'),
    tokenCount: createTokenCount(content.length),
  });

const createUseCase = (input: {
  readonly conversations?: readonly Conversation[];
  readonly artifacts?: readonly { artifact: Artifact; content: string }[];
  readonly config?: { readonly maxInlineOperatorInputBytes?: number };
} = {}) => {
  const hashPort = new DeterministicHashPort();
  const idService: IdService = createIdService(hashPort);
  const artifactStore = new TestArtifactStore(input.artifacts ?? []);
  const operators = new TestOperatorExecutionPort();
  const unitOfWork = new TestUnitOfWorkPort({
    conversations: new TestConversationStore(input.conversations ?? [createConversationRecord()]),
    artifacts: artifactStore,
    operators,
  });
  const jobQueue = new TestJobQueue();

  const useCaseDeps = {
    unitOfWork,
    idService,
    hashPort,
    tokenizer: new SimpleTokenizer(),
    clock: new DeterministicClock(),
    jobQueue,
    ...(input.config === undefined ? {} : { config: input.config }),
  };

  return {
    useCase: new LLMMapUseCase(useCaseDeps),
    artifactStore,
    operators,
    jobQueue,
  };
};

const createInput = (overrides: {
  readonly conversationId?: LLMMapInput['conversationId'];
  readonly prompt?: LLMMapInput['prompt'];
  readonly outputSchema?: LLMMapInput['outputSchema'];
  readonly concurrencyLimit?: LLMMapInput['concurrencyLimit'];
  readonly retryPolicy?: LLMMapInput['retryPolicy'];
  readonly idempotencyKey?: LLMMapInput['idempotencyKey'];
  readonly items?: LLMMapInput['items'];
  readonly inputArtifactId?: LLMMapInput['inputArtifactId'];
} = {}): LLMMapInput => ({
  conversationId: overrides.conversationId ?? conversationId,
  prompt: overrides.prompt ?? 'Summarize the item.',
  outputSchema:
    overrides.outputSchema ?? { type: 'object', properties: { summary: { type: 'string' } } },
  concurrencyLimit: overrides.concurrencyLimit ?? 2,
  retryPolicy: overrides.retryPolicy ?? {
    maxRetries: 1,
    retryBackoffSeconds: 30,
  },
  ...(overrides.idempotencyKey === undefined ? {} : { idempotencyKey: overrides.idempotencyKey }),
  ...(overrides.items === undefined ? { items: [{ text: 'alpha' }, { text: 'beta' }] } : { items: overrides.items }),
  ...(overrides.inputArtifactId === undefined ? {} : { inputArtifactId: overrides.inputArtifactId }),
});

describe('LLMMapUseCase', () => {
  it('requires exactly one of items or inputArtifactId', async () => {
    const { useCase } = createUseCase();
    const missingDatasetInput = {
      conversationId,
      prompt: 'Summarize the item.',
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      concurrencyLimit: 2,
      retryPolicy: {
        maxRetries: 1,
        retryBackoffSeconds: 30,
      },
    } satisfies LLMMapInput;

    await expect(useCase.execute(missingDatasetInput)).rejects.toBeInstanceOf(
      OperatorInputValidationError,
    );
    await expect(
      useCase.execute(createInput({ items: [{ text: 'alpha' }], inputArtifactId: existingArtifactId })),
    ).rejects.toBeInstanceOf(OperatorInputValidationError);
  });

  it('rejects inline datasets over the configured byte ceiling', async () => {
    const { useCase } = createUseCase({
      config: { maxInlineOperatorInputBytes: 32 },
    });

    await expect(
      useCase.execute(
        createInput({
          items: [{ text: 'x'.repeat(64) }],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'OPERATOR_INPUT_INVALID',
    });
  });

  it('rejects artifact-backed datasets from another conversation', async () => {
    const content = JSON.stringify([{ text: 'alpha' }]);
    const { useCase } = createUseCase({
      artifacts: [
        {
          artifact: createArtifactRecord(existingArtifactId, otherConversationId, content),
          content,
        },
      ],
    });
    const artifactInput = {
      conversationId,
      prompt: 'Summarize the item.',
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      concurrencyLimit: 2,
      retryPolicy: {
        maxRetries: 1,
        retryBackoffSeconds: 30,
      },
      inputArtifactId: existingArtifactId,
    } satisfies LLMMapInput;

    await expect(useCase.execute(artifactInput)).rejects.toBeInstanceOf(OperatorInputValidationError);
  });

  it('rejects artifact-backed datasets when the payload is not one JSON array', async () => {
    const content = JSON.stringify({ text: 'alpha' });
    const { useCase } = createUseCase({
      artifacts: [
        {
          artifact: createArtifactRecord(existingArtifactId, conversationId, content),
          content,
        },
      ],
    });
    const artifactInput = {
      conversationId,
      prompt: 'Summarize the item.',
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      concurrencyLimit: 2,
      retryPolicy: {
        maxRetries: 1,
        retryBackoffSeconds: 30,
      },
      inputArtifactId: existingArtifactId,
    } satisfies LLMMapInput;

    await expect(useCase.execute(artifactInput)).rejects.toBeInstanceOf(OperatorInputValidationError);
  });

  it('finalizes zero-item submissions immediately with an empty output artifact and no tasks', async () => {
    const { useCase, artifactStore, operators, jobQueue } = createUseCase();

    const output = await useCase.execute(createInput({ items: [] }));
    const run = await operators.getRun(output.runId);
    const tasks = await operators.listTasksForRun(output.runId);

    expect(output.status).toBe('completed');
    expect(run?.status).toBe('completed');
    expect(run?.outputArtifactId).toBeDefined();
    expect(tasks).toHaveLength(0);
    expect(jobQueue.jobs).toHaveLength(0);
    expect(output.inputArtifactId).toBeDefined();
    expect(run?.inputArtifactId).toBe(output.inputArtifactId);
    expect(run?.outputArtifactId).toBeDefined();
    expect(artifactStore.storedContents.get(run?.outputArtifactId ?? existingArtifactId)).toBe('');
  });

  it('returns the existing run id when the same idempotency key is reused with the same normalized input', async () => {
    const { useCase, operators } = createUseCase();

    const first = await useCase.execute(
      createInput({
        idempotencyKey: 'same-input',
        items: [{ text: 'alpha', order: 2 }, { order: 1, text: 'beta' }],
      }),
    );
    const second = await useCase.execute(
      createInput({
        idempotencyKey: 'same-input',
        items: [{ order: 2, text: 'alpha' }, { text: 'beta', order: 1 }],
      }),
    );

    expect(second.runId).toBe(first.runId);
    expect([...operators.runs.values()]).toHaveLength(1);
  });

  it('throws when the conversation does not exist', async () => {
    const { useCase } = createUseCase({ conversations: [] });

    await expect(useCase.execute(createInput())).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
