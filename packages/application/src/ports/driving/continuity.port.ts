import type {
  ArtifactId,
  ConversationId,
  EventId,
  SummaryNodeId,
  Timestamp,
  TokenCount,
} from '@ledgermind/domain';

export type ContinuityRecordKind =
  | 'goal'
  | 'decision'
  | 'constraint'
  | 'progress'
  | 'next_step'
  | 'handoff'
  | 'verification'
  | 'failure'
  | 'open_question'
  | 'artifact_change'
  | 'session_summary';

export type ContinuityRecordStatus = 'active' | 'stale' | 'superseded' | 'resolved';
export type ContinuityImportance = 'low' | 'normal' | 'high' | 'critical';

export interface ContinuityProvenance {
  readonly eventIds?: readonly EventId[];
  readonly summaryIds?: readonly SummaryNodeId[];
  readonly artifactIds?: readonly ArtifactId[];
  readonly transcriptPath?: string;
  readonly transcriptLineStart?: number;
  readonly transcriptLineEnd?: number;
  readonly toolUseId?: string;
  readonly command?: string;
}

export interface ContinuityRecord {
  readonly recordId: string;
  readonly conversationId: ConversationId;
  readonly kind: ContinuityRecordKind;
  readonly status: ContinuityRecordStatus;
  readonly title: string;
  readonly content: string;
  readonly importance: ContinuityImportance;
  readonly provenance: ContinuityProvenance;
  readonly relatedRecordIds: readonly string[];
  readonly supersedesRecordIds: readonly string[];
  readonly supersededByRecordId?: string;
  readonly createdAt: Timestamp;
  readonly eventId: EventId;
}

export interface RecordContinuityInput {
  readonly conversationId: ConversationId;
  readonly kind: ContinuityRecordKind;
  readonly title: string;
  readonly content: string;
  readonly importance?: ContinuityImportance;
  readonly status?: ContinuityRecordStatus;
  readonly provenance?: ContinuityProvenance;
  readonly relatedRecordIds?: readonly string[];
  readonly supersedesRecordIds?: readonly string[];
  readonly supersededByRecordId?: string;
  readonly idempotencyKey?: string;
  readonly occurredAt?: Timestamp;
}

export interface RecordContinuityOutput {
  readonly record: ContinuityRecord;
  readonly contextTokenCount: TokenCount;
}

export interface HandoffNextStep {
  readonly title: string;
  readonly content: string;
  readonly importance?: ContinuityImportance;
  readonly provenance?: ContinuityProvenance;
}

export interface CreateHandoffInput {
  readonly conversationId: ConversationId;
  readonly goal: string;
  readonly completed: readonly string[];
  readonly nextSteps: readonly HandoffNextStep[];
  readonly decisions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly verification?: readonly string[];
  readonly risks?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly provenance?: ContinuityProvenance;
  readonly runtimeSessionId?: string;
  readonly idempotencyKey?: string;
}

export interface CreateHandoffOutput {
  readonly handoff: ContinuityRecord;
  readonly nextStepRecords: readonly ContinuityRecord[];
}

export interface GetCurrentStateInput {
  readonly conversationId: ConversationId;
  readonly includeStale?: boolean;
  readonly limitPerKind?: number;
}

export interface GetCurrentStateOutput {
  readonly goalRecords: readonly ContinuityRecord[];
  readonly decisions: readonly ContinuityRecord[];
  readonly constraints: readonly ContinuityRecord[];
  readonly progress: readonly ContinuityRecord[];
  readonly nextSteps: readonly ContinuityRecord[];
  readonly handoffs: readonly ContinuityRecord[];
  readonly verification: readonly ContinuityRecord[];
  readonly failures: readonly ContinuityRecord[];
  readonly openQuestions: readonly ContinuityRecord[];
  readonly artifactChanges: readonly ContinuityRecord[];
  readonly sessionSummaries: readonly ContinuityRecord[];
  readonly activeRecordCount: number;
  readonly staleRecordCount: number;
}

export interface GetNextStepsInput {
  readonly conversationId: ConversationId;
  readonly limit?: number;
}

export interface GetNextStepsOutput {
  readonly nextSteps: readonly ContinuityRecord[];
}

export interface RecallForTaskInput {
  readonly conversationId: ConversationId;
  readonly task: string;
  readonly budgetTokens: number;
  readonly includeHandoff?: boolean;
  readonly includeEvidence?: boolean;
}

export interface RecallForTaskOutput {
  readonly contextBlock: string;
  readonly currentState: GetCurrentStateOutput;
  readonly recalledSummaryIds: readonly SummaryNodeId[];
  readonly recalledArtifactIds: readonly ArtifactId[];
  readonly recalledEventIds: readonly EventId[];
  readonly why: readonly string[];
  readonly budgetUsed: TokenCount;
}

export interface MarkContinuityRecordInput {
  readonly conversationId: ConversationId;
  readonly recordId: string;
  readonly status: Exclude<ContinuityRecordStatus, 'active'>;
  readonly reason: string;
  readonly supersededByRecordId?: string;
  readonly idempotencyKey?: string;
}

export interface MarkContinuityRecordOutput {
  readonly marker: ContinuityRecord;
}
