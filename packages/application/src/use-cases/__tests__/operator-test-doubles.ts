import {
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
  type ContextItem,
  type ContextVersion,
  type HashPort,
  type SequenceNumber,
  type SummaryNode,
  type SummaryNodeId,
  type TokenCount,
} from '@ledgermind/domain';

import { IdempotencyConflictError } from '../../errors/application-errors';
import type { DelegationScopeResolution, DelegationScopeResolverPort } from '../../ports/driven/agents/delegation-scope-resolver.port';
import type { SubAgentExecutorInput, SubAgentExecutorPort, SubAgentExecutorResult } from '../../ports/driven/agents/sub-agent-executor.port';
import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type {
  StructuredGenerationInput,
  StructuredGenerationPort,
  StructuredGenerationResult,
} from '../../ports/driven/llm/structured-generation.port';
import type { TokenizerPort } from '../../ports/driven/llm/tokenizer.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerAppendPort } from '../../ports/driven/persistence/ledger-append.port';
import type {
  AdvanceFinalizationStageInput,
  AssignTaskChildConversationInput,
  ClaimRunForFinalizationRetryInput,
  ClaimTaskLeaseInput,
  CreateOperatorRunWithTasksInput,
  FinalizeRunInput,
  MarkTaskRetryableFailureInput,
  OperatorExecutionPort,
  RecordTaskFailureInput,
  RecordTaskSuccessInput,
  StoredOperatorRun,
  StoredOperatorTask,
} from '../../ports/driven/persistence/operator-execution.port';
import { createNoopOperatorExecutionPort } from '../../ports/driven/persistence/noop-operator-execution.port';
import type { IntegrityReport, SummaryDagPort } from '../../ports/driven/persistence/summary-dag.port';
import type { UnitOfWork, UnitOfWorkPort } from '../../ports/driven/persistence/unit-of-work.port';

const defaultTimestamp = createTimestamp(new Date('2026-04-13T00:00:00.000Z'));

const createDefaultConversationConfig = (): ConversationConfig =>
  createConversationConfig({
    modelName: 'gpt-4.1-mini',
    contextWindow: createTokenCount(8_192),
    thresholds: createCompactionThresholds(0.6, 0.8),
  });

const createLookupKey = (conversationId: ConversationId, idempotencyKey: string): string => {
  return `${conversationId}::${idempotencyKey}`;
};

type StoredOperatorTaskWithOutput = StoredOperatorTask & {
  readonly output?: unknown;
};

const isTaskTerminal = (task: StoredOperatorTask): boolean => {
  return task.status === 'succeeded' || task.status === 'failed';
};

export class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const date = new Date(Date.UTC(2026, 3, 13, 0, 0, this.tick));
    this.tick += 1;
    return createTimestamp(date);
  }
}

export class DeterministicHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
}

export class SimpleTokenizerDouble implements TokenizerPort {
  countTokens(text: string): TokenCount {
    return createTokenCount(Math.max(1, text.length));
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(Math.max(1, byteLength));
  }
}

export class InMemoryArtifactStoreDouble implements ArtifactStorePort {
  readonly storedMetadata = new Map<ArtifactId, Artifact>();
  readonly storedContents = new Map<ArtifactId, string | Uint8Array>();
  readonly storeCalls: Array<{ artifactId: ArtifactId; content: string | Uint8Array | undefined }> = [];

  constructor(entries: readonly { artifact: Artifact; content: string | Uint8Array }[] = []) {
    for (const entry of entries) {
      this.storedMetadata.set(entry.artifact.id, entry.artifact);
      this.storedContents.set(entry.artifact.id, entry.content);
    }
  }

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<void> {
    this.storeCalls.push({ artifactId: artifact.id, content });
    this.storedMetadata.set(artifact.id, artifact);
    if (content !== undefined) {
      this.storedContents.set(artifact.id, content);
    }
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

export class InMemoryConversationStoreDouble implements ConversationPort {
  readonly createCalls: Array<{ config: ConversationConfig; parentId?: ConversationId }> = [];
  private readonly conversations = new Map<ConversationId, Conversation>();

  constructor(entries: readonly Conversation[] = []) {
    for (const entry of entries) {
      this.conversations.set(entry.id, entry);
    }
  }

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
    this.createCalls.push({ config, ...(parentId === undefined ? {} : { parentId }) });
    const conversation = createConversation({
      id: createConversationId(`conv_created_${String(parentId ?? 'root')}_${this.createCalls.length}`),
      parentId: parentId ?? null,
      config,
      createdAt: defaultTimestamp,
    });
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]> {
    const chain: ConversationId[] = [];
    let current = this.conversations.get(id) ?? null;
    const visited = new Set<ConversationId>();

    while (current !== null && current.parentId !== null) {
      const parentId = current.parentId;
      if (visited.has(parentId)) {
        break;
      }

      visited.add(parentId);
      chain.push(parentId);
      current = this.conversations.get(parentId) ?? null;
    }

    return chain;
  }
}

export class DeterministicStructuredGenerationPort implements StructuredGenerationPort {
  readonly calls: StructuredGenerationInput[] = [];

  constructor(
    private readonly results: readonly StructuredGenerationResult[] = [
      {
        status: 'succeeded',
        output: { ok: true },
      },
    ],
  ) {}

  async generate(input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
    this.calls.push(input);
    return this.results[this.calls.length - 1] ?? this.results[this.results.length - 1]!;
  }
}

export class DeterministicSubAgentExecutorPort implements SubAgentExecutorPort {
  readonly calls: SubAgentExecutorInput[] = [];

  constructor(
    private readonly results: readonly SubAgentExecutorResult[] = [
      {
        status: 'succeeded',
        output: { ok: true },
      },
    ],
  ) {}

  async execute(input: SubAgentExecutorInput): Promise<SubAgentExecutorResult> {
    this.calls.push(input);
    return this.results[this.calls.length - 1] ?? this.results[this.results.length - 1]!;
  }
}

export class DeterministicDelegationScopeResolverPort implements DelegationScopeResolverPort {
  readonly calls: Parameters<DelegationScopeResolverPort['resolve']>[0][] = [];

  constructor(
    private readonly result: DelegationScopeResolution = {
      bootstrapEvents: [],
      childArtifacts: [],
      sourceReferenceIds: [],
    },
  ) {}

  async resolve(scope: Parameters<DelegationScopeResolverPort['resolve']>[0]): Promise<DelegationScopeResolution> {
    this.calls.push(scope);
    return this.result;
  }
}

export class DeterministicOperatorExecutionPort implements OperatorExecutionPort {
  readonly runs = new Map<string, StoredOperatorRun>();
  readonly tasksByRun = new Map<string, StoredOperatorTaskWithOutput[]>();
  readonly successes: Array<{ taskId: string; output: unknown }> = [];
  readonly retryableFailures: MarkTaskRetryableFailureInput[] = [];
  readonly terminalFailures: RecordTaskFailureInput[] = [];
  readonly assignedChildConversations: AssignTaskChildConversationInput[] = [];
  readonly bootstrapStartedTaskIds: string[] = [];
  readonly bootstrapCompletedTaskIds: string[] = [];
  readonly finalizationClaims: ClaimRunForFinalizationRetryInput[] = [];
  readonly finalizationTransitions: AdvanceFinalizationStageInput[] = [];
  private readonly runIdByLookupKey = new Map<string, string>();

  async createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun> {
    const lookupKey =
      input.idempotencyKey === undefined
        ? undefined
        : createLookupKey(input.conversationId, input.idempotencyKey);

    if (lookupKey !== undefined) {
      const existingRunId = this.runIdByLookupKey.get(lookupKey);
      if (existingRunId !== undefined) {
        const existingRun = this.runs.get(existingRunId);
        if (existingRun === undefined) {
          throw new Error('Existing operator run missing from deterministic store.');
        }

        if (existingRun.normalizedInputDigest !== input.normalizedInputDigest) {
          throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey!);
        }

        return existingRun;
      }
    }

    const now = defaultTimestamp;
    const run: StoredOperatorRun = {
      runId: input.runId,
      conversationId: input.conversationId,
      operatorKind: input.operatorKind,
      status: input.taskCount === 0 ? 'completed' : 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.taskCount === 0 ? { completedAt: now } : {}),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
      outputSchema: input.outputSchema,
      concurrencyLimit: input.concurrencyLimit,
      retryPolicy: input.retryPolicy,
      ...(input.delegatedScope === undefined ? {} : { delegatedScope: input.delegatedScope }),
      ...(input.keptWork === undefined ? {} : { keptWork: input.keptWork }),
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

    const tasks = input.items.map<StoredOperatorTaskWithOutput>((_, itemIndex) => ({
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
    return [...(this.tasksByRun.get(runId) ?? [])].sort((left, right) => left.itemIndex - right.itemIndex);
  }

  async lookupRunByIdempotencyKey(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): Promise<StoredOperatorRun | null> {
    const runId = this.runIdByLookupKey.get(createLookupKey(conversationId, idempotencyKey));
    return runId === undefined ? null : (this.runs.get(runId) ?? null);
  }

  async claimTaskLease(input: ClaimTaskLeaseInput): Promise<StoredOperatorTask | null> {
    for (const [runId, tasks] of this.tasksByRun.entries()) {
      const run = this.runs.get(runId);
      if (run === undefined) {
        continue;
      }

      const runningCount = tasks.filter((task) => task.status === 'running').length;
      if (runningCount >= run.concurrencyLimit) {
        continue;
      }

      const nextTask = tasks.find((task) => {
        if (task.status === 'running') {
          return task.leaseExpiresAt !== undefined && task.leaseExpiresAt.getTime() <= input.now.getTime();
        }

        if (task.status === 'pending') {
          return true;
        }

        if (task.status === 'retryable_failure') {
          return task.nextRetryAt === undefined || task.nextRetryAt.getTime() <= input.now.getTime();
        }

        return false;
      });

      if (nextTask === undefined) {
        continue;
      }

      this.updateTask(nextTask.taskId, (task) => ({
        ...task,
        status: 'running',
        attemptCount: task.attemptCount + 1,
        leaseOwner: input.workerId,
        leaseExpiresAt: createTimestamp(
          new Date(input.now.getTime() + input.leaseDurationSeconds * 1000),
        ),
      }));
      this.recomputeRunStats(runId);
      return this.getTask(nextTask.taskId);
    }

    return null;
  }

  async recordTaskSuccess(input: RecordTaskSuccessInput): Promise<void> {
    this.successes.push({ taskId: input.taskId, output: input.output });
    const task = await this.getTask(input.taskId);
    if (task === null) {
      return;
    }

    this.updateTask(input.taskId, (current) => ({
      ...current,
      status: 'succeeded',
      ...(input.resultArtifactId === undefined ? {} : { resultArtifactId: input.resultArtifactId }),
      output: input.output,
    }));
    this.recomputeRunStats(task.runId);
  }

  async recordTaskFailure(input: RecordTaskFailureInput): Promise<void> {
    this.terminalFailures.push(input);
    const task = await this.getTask(input.taskId);
    if (task === null) {
      return;
    }

    this.updateTask(input.taskId, (current) => ({
      ...current,
      status: 'failed',
      terminalFailure: input.failure,
    }));
    this.recomputeRunStats(task.runId);
  }

  async markTaskRetryableFailure(input: MarkTaskRetryableFailureInput): Promise<void> {
    this.retryableFailures.push(input);
    const task = await this.getTask(input.taskId);
    if (task === null) {
      return;
    }

    this.updateTask(input.taskId, (current) => ({
      ...current,
      status: 'retryable_failure',
      nextRetryAt: input.nextRetryAt,
      terminalFailure: input.failure,
    }));
    this.recomputeRunStats(task.runId);
  }

  async assignTaskChildConversation(input: AssignTaskChildConversationInput): Promise<ConversationId> {
    const task = await this.getTask(input.taskId);
    if (task === null) {
      throw new Error(`Unknown operator task: ${input.taskId}`);
    }

    if (task.childConversationId !== undefined) {
      return task.childConversationId;
    }

    this.assignedChildConversations.push(input);
    this.updateTask(input.taskId, (current) => ({
      ...current,
      childConversationId: input.childConversationId,
    }));
    return input.childConversationId;
  }

  async getTaskBootstrapState(taskId: string): Promise<StoredOperatorTask['bootstrapState']> {
    return (await this.getTask(taskId))?.bootstrapState ?? 'bootstrap_not_started';
  }

  async markBootstrapStarted(taskId: string): Promise<void> {
    this.bootstrapStartedTaskIds.push(taskId);
    this.updateTask(taskId, (task) => ({
      ...task,
      bootstrapState: 'bootstrap_in_progress',
    }));
  }

  async markBootstrapCompleted(taskId: string): Promise<void> {
    this.bootstrapCompletedTaskIds.push(taskId);
    this.updateTask(taskId, (task) => ({
      ...task,
      bootstrapState: 'bootstrap_completed',
    }));
  }

  async claimRunForFinalizationRetry(input: ClaimRunForFinalizationRetryInput): Promise<StoredOperatorRun | null> {
    this.finalizationClaims.push(input);
    for (const [runId, run] of this.runs.entries()) {
      if (run.finalizationStage === 'completed') {
        continue;
      }

      const tasks = this.tasksByRun.get(runId) ?? [];
      if (tasks.length > 0 && !tasks.every((task) => isTaskTerminal(task))) {
        continue;
      }

      return run;
    }

    return null;
  }

  async advanceFinalizationStage(input: AdvanceFinalizationStageInput): Promise<StoredOperatorRun['finalizationStage']> {
    this.finalizationTransitions.push(input);
    const run = this.runs.get(input.runId);
    if (run === undefined) {
      return input.from;
    }

    if (run.finalizationStage !== input.from) {
      return run.finalizationStage;
    }

    this.runs.set(input.runId, {
      ...run,
      finalizationStage: input.to,
      updatedAt: defaultTimestamp,
      needsFinalizationRetry: false,
    });
    return input.to;
  }

  async finalizeRun(input: FinalizeRunInput): Promise<StoredOperatorRun> {
    const run = this.runs.get(input.runId);
    if (run === undefined) {
      throw new Error(`Unknown operator run: ${input.runId}`);
    }

    const finalized: StoredOperatorRun = {
      ...run,
      status: input.status,
      completedAt: input.completedAt,
      ...(input.outputArtifactId === undefined ? {} : { outputArtifactId: input.outputArtifactId }),
      ...(input.terminalFailureSummary === undefined
        ? {}
        : { terminalFailureSummary: input.terminalFailureSummary }),
      finalizationStage: 'completed',
      updatedAt: input.completedAt,
      needsFinalizationRetry: false,
    };
    this.runs.set(input.runId, finalized);
    return finalized;
  }

  private updateTask(taskId: string, updater: (task: StoredOperatorTaskWithOutput) => StoredOperatorTaskWithOutput): void {
    for (const [runId, tasks] of this.tasksByRun.entries()) {
      const index = tasks.findIndex((task) => task.taskId === taskId);
      if (index === -1) {
        continue;
      }

      const current = tasks[index];
      if (current === undefined) {
        return;
      }

      const updatedTasks = [...tasks];
      updatedTasks[index] = updater(current);
      this.tasksByRun.set(runId, updatedTasks);
      return;
    }
  }

  private recomputeRunStats(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return;
    }

    const tasks = this.tasksByRun.get(runId) ?? [];
    const succeededTaskCount = tasks.filter((task) => task.status === 'succeeded').length;
    const failedTaskCount = tasks.filter((task) => task.status === 'failed').length;
    const retryableFailureTaskCount = tasks.filter((task) => task.status === 'retryable_failure').length;
    const runningTaskCount = tasks.filter((task) => task.status === 'running').length;
    const pendingTaskCount = tasks.filter((task) => task.status === 'pending').length;

    const firstTerminalFailure = tasks.find((task) => task.status === 'failed')?.terminalFailure;

    this.runs.set(runId, {
      ...run,
      succeededTaskCount,
      failedTaskCount,
      retryableFailureTaskCount,
      runningTaskCount,
      pendingTaskCount,
      status:
        runningTaskCount > 0
          ? 'running'
          : succeededTaskCount + failedTaskCount === tasks.length && tasks.length > 0
            ? run.status
            : 'pending',
      updatedAt: defaultTimestamp,
      ...(failedTaskCount > 0 && firstTerminalFailure !== undefined
        ? { terminalFailureSummary: firstTerminalFailure }
        : {}),
    });
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
    readonly version: ContextVersion;
  }> {
    return {
      items: [],
      version: 0 as ContextVersion,
    };
  }

  async getContextTokenCount(): Promise<TokenCount> {
    return createTokenCount(0);
  }

  async appendContextItems(): Promise<ContextVersion> {
    return 1 as ContextVersion;
  }

  async replaceContextItems(): Promise<ContextVersion> {
    return 1 as ContextVersion;
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

  async getParentSummaryIds(): Promise<readonly SummaryNodeId[]> {
    return [];
  }

  async expandToMessages() {
    return [];
  }

  async searchSummaries(): Promise<readonly SummaryNode[]> {
    return [];
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    return {
      passed: true,
      checks: [],
    };
  }
}

export const createOperatorUnitOfWorkPort = (deps: {
  readonly artifactStore: ArtifactStorePort;
  readonly conversations: ConversationPort;
  readonly operators: OperatorExecutionPort;
  readonly ledger?: LedgerAppendPort;
  readonly context?: ContextProjectionPort;
  readonly dag?: SummaryDagPort;
}): UnitOfWorkPort => {
  const uow: UnitOfWork = {
    ledger: deps.ledger ?? new NoopLedgerAppendPort(),
    context: deps.context ?? new NoopContextProjectionPort(),
    dag: deps.dag ?? new NoopSummaryDagPort(),
    artifacts: deps.artifactStore,
    conversations: deps.conversations,
    operators: deps.operators,
  };

  return {
    async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      return work(uow);
    },
  };
};

export { createNoopOperatorExecutionPort };
