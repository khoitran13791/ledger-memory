import type { ArtifactId, ConversationId, Timestamp } from '@ledgermind/domain';

import type {
  AgenticMapInput,
  DelegatedScopeInput,
  KeptWorkInput,
  LLMMapInput,
  OperatorBootstrapState,
  OperatorFailureMetadata,
  OperatorFinalizationStage,
  OperatorKind,
  OperatorRunStatus,
  OperatorTaskStatus,
  RetryPolicy,
} from '../../driving/operator-execution.port';

export interface StoredOperatorRun {
  readonly runId: string;
  readonly conversationId: ConversationId;
  readonly operatorKind: OperatorKind;
  readonly status: OperatorRunStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly prompt?: string;
  readonly taskPrompt?: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly concurrencyLimit: number;
  readonly retryPolicy: RetryPolicy;
  readonly delegatedScope?: DelegatedScopeInput;
  readonly keptWork?: KeptWorkInput;
  readonly idempotencyKey?: string;
  readonly normalizedInputDigest?: string;
  readonly inputArtifactId?: ArtifactId;
  readonly outputArtifactId?: ArtifactId;
  readonly finalizationStage: OperatorFinalizationStage;
  readonly needsFinalizationRetry?: boolean;
  readonly parentHandleAppendedAt?: Timestamp;
  readonly taskCount: number;
  readonly succeededTaskCount: number;
  readonly failedTaskCount: number;
  readonly retryableFailureTaskCount: number;
  readonly runningTaskCount: number;
  readonly pendingTaskCount: number;
  readonly terminalFailureSummary?: OperatorFailureMetadata;
}

export interface StoredOperatorTask {
  readonly taskId: string;
  readonly runId: string;
  readonly conversationId: ConversationId;
  readonly itemIndex: number;
  readonly status: OperatorTaskStatus;
  readonly attemptCount: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: Timestamp;
  readonly nextRetryAt?: Timestamp;
  readonly childConversationId?: ConversationId;
  readonly bootstrapState: OperatorBootstrapState;
  readonly resultArtifactId?: ArtifactId;
  readonly terminalFailure?: OperatorFailureMetadata;
}

export interface CreateOperatorRunWithTasksInput {
  readonly runId: string;
  readonly operatorKind: OperatorKind;
  readonly conversationId: ConversationId;
  readonly taskCount: number;
  readonly prompt?: string;
  readonly taskPrompt?: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly concurrencyLimit: number;
  readonly retryPolicy: RetryPolicy;
  readonly delegatedScope?: DelegatedScopeInput;
  readonly keptWork?: KeptWorkInput;
  readonly idempotencyKey?: string;
  readonly normalizedInputDigest?: string;
  readonly inputArtifactId?: ArtifactId;
  readonly items: readonly unknown[];
}

export interface ClaimTaskLeaseInput {
  readonly workerId: string;
  readonly now: Timestamp;
  readonly leaseDurationSeconds: number;
  readonly allowedStatuses?: readonly Extract<OperatorTaskStatus, 'pending' | 'retryable_failure'>[];
}

export interface RecordTaskSuccessInput {
  readonly taskId: string;
  readonly output: unknown;
  readonly completedAt: Timestamp;
  readonly resultArtifactId?: ArtifactId;
}

export interface RecordTaskFailureInput {
  readonly taskId: string;
  readonly failure: OperatorFailureMetadata;
  readonly completedAt: Timestamp;
}

export interface MarkTaskRetryableFailureInput {
  readonly taskId: string;
  readonly failure: OperatorFailureMetadata;
  readonly nextRetryAt: Timestamp;
}

export interface AssignTaskChildConversationInput {
  readonly taskId: string;
  readonly childConversationId: ConversationId;
}

export interface ClaimRunForFinalizationRetryInput {
  readonly workerId: string;
  readonly now: Timestamp;
}

export interface AdvanceFinalizationStageInput {
  readonly runId: string;
  readonly from: OperatorFinalizationStage;
  readonly to: OperatorFinalizationStage;
}

export interface FinalizeRunInput {
  readonly runId: string;
  readonly status: OperatorRunStatus;
  readonly completedAt: Timestamp;
  readonly outputArtifactId?: ArtifactId;
  readonly terminalFailureSummary?: OperatorFailureMetadata;
}

export interface OperatorExecutionPort {
  createRunWithTasks(input: CreateOperatorRunWithTasksInput): Promise<StoredOperatorRun>;
  getRun(runId: string): Promise<StoredOperatorRun | null>;
  getTask(taskId: string): Promise<StoredOperatorTask | null>;
  listTasksForRun(runId: string): Promise<readonly StoredOperatorTask[]>;
  lookupRunByIdempotencyKey(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): Promise<StoredOperatorRun | null>;
  claimTaskLease(input: ClaimTaskLeaseInput): Promise<StoredOperatorTask | null>;
  recordTaskSuccess(input: RecordTaskSuccessInput): Promise<void>;
  recordTaskFailure(input: RecordTaskFailureInput): Promise<void>;
  markTaskRetryableFailure(input: MarkTaskRetryableFailureInput): Promise<void>;
  assignTaskChildConversation(input: AssignTaskChildConversationInput): Promise<ConversationId>;
  getTaskBootstrapState(taskId: string): Promise<OperatorBootstrapState>;
  markBootstrapStarted(taskId: string): Promise<void>;
  markBootstrapCompleted(taskId: string): Promise<void>;
  claimRunForFinalizationRetry(input: ClaimRunForFinalizationRetryInput): Promise<StoredOperatorRun | null>;
  advanceFinalizationStage(input: AdvanceFinalizationStageInput): Promise<OperatorFinalizationStage>;
  finalizeRun(input: FinalizeRunInput): Promise<StoredOperatorRun>;
}

export type OperatorSubmissionInput = LLMMapInput | AgenticMapInput;
