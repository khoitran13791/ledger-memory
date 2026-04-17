import type { ArtifactId, ConversationId, Timestamp } from '@ledgermind/domain';

export type OperatorKind = 'llmMap' | 'agenticMap';

export type OperatorRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_failures'
  | 'failed';

export type OperatorTaskStatus =
  | 'pending'
  | 'running'
  | 'retryable_failure'
  | 'succeeded'
  | 'failed';

export type OperatorBootstrapState =
  | 'bootstrap_not_started'
  | 'bootstrap_in_progress'
  | 'bootstrap_completed';

export type OperatorFinalizationStage =
  | 'not_started'
  | 'artifact_written'
  | 'handle_appended'
  | 'completed';

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly retryBackoffSeconds: number;
}

export interface DelegatedScopeInput {
  readonly messageIds?: readonly string[];
  readonly summaryIds?: readonly string[];
  readonly artifactIds?: readonly ArtifactId[];
  readonly note?: string;
}

export interface KeptWorkInput {
  readonly description: string;
  readonly expectedOutput: string;
}

interface OperatorMapInputBase {
  readonly conversationId: ConversationId;
  readonly prompt?: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly concurrencyLimit: number;
  readonly retryPolicy: RetryPolicy;
  readonly idempotencyKey?: string;
  readonly items?: readonly unknown[];
  readonly inputArtifactId?: ArtifactId;
}

export interface LLMMapInput extends OperatorMapInputBase {
  readonly prompt: string;
}

export interface LLMMapOutput {
  /**
   * Submit-only API: callers receive a durable runId immediately and inspect
   * final ordered results later via getOperatorRun().
   */
  readonly runId: string;
  readonly status: OperatorRunStatus;
  readonly inputArtifactId?: ArtifactId;
}

export interface AgenticMapInput extends OperatorMapInputBase {
  readonly taskPrompt: string;
  readonly delegatedScope: DelegatedScopeInput;
  readonly keptWork: KeptWorkInput;
}

export interface AgenticMapOutput {
  /**
   * Submit-only API: callers receive a durable runId immediately and inspect
   * final ordered results later via getOperatorRun().
   */
  readonly runId: string;
  readonly status: OperatorRunStatus;
  readonly inputArtifactId?: ArtifactId;
}

export interface GetOperatorRunInput {
  readonly runId: string;
}

export interface OperatorFailureMetadata {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly attemptCount?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type OperatorResultEntry =
  | {
      readonly itemIndex: number;
      readonly status: 'succeeded';
      readonly output: unknown;
      readonly childConversationId?: ConversationId;
    }
  | {
      readonly itemIndex: number;
      readonly status: 'failed';
      readonly error: OperatorFailureMetadata;
      readonly childConversationId?: ConversationId;
    };

export interface OperatorTaskInspection {
  readonly taskId: string;
  readonly itemIndex: number;
  readonly status: OperatorTaskStatus;
  readonly attemptCount: number;
  readonly childConversationId?: ConversationId;
  readonly resultArtifactId?: ArtifactId;
  readonly terminalFailure?: OperatorFailureMetadata;
}

export interface GetOperatorRunOutput {
  /**
   * Canonical inspection API for durable operator execution state.
   */
  readonly runId: string;
  readonly conversationId: ConversationId;
  readonly operatorKind: OperatorKind;
  readonly status: OperatorRunStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly inputArtifactId?: ArtifactId;
  readonly outputArtifactId?: ArtifactId;
  readonly taskCount: number;
  readonly succeededTaskCount: number;
  readonly failedTaskCount: number;
  readonly retryableFailureTaskCount: number;
  readonly runningTaskCount: number;
  readonly pendingTaskCount: number;
  readonly terminalFailureSummary?: OperatorFailureMetadata;
  /**
   * Ordered finalized results are only inlined when they fit under the
   * configured maxInlineRunResultsBytes ceiling; otherwise callers should use
   * outputArtifactId.
   */
  readonly inlineResults?: readonly OperatorResultEntry[];
  readonly tasks: readonly OperatorTaskInspection[];
}
