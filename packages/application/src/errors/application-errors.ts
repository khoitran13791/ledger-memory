import type { ArtifactId, ConversationId, SummaryNodeId } from '@ledgermind/domain';

export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type InvalidReferenceKind =
  | 'summary'
  | 'artifact'
  | 'summary_scope'
  | 'summary_or_artifact';

export type TokenizerOperation = 'countTokens' | 'estimateFromBytes';

export class TokenizerConfigurationError extends ApplicationError {
  readonly code = 'TOKENIZER_CONFIGURATION_INVALID';
  readonly tokenizer: string;
  readonly reason: string;

  constructor(tokenizer: string, reason: string) {
    super(`Invalid tokenizer configuration for "${tokenizer}": ${reason}`);
    this.tokenizer = tokenizer;
    this.reason = reason;
  }
}

export class InvalidTokenizerOutputError extends ApplicationError {
  readonly code = 'TOKENIZER_OUTPUT_INVALID';
  readonly tokenizer: string;
  readonly operation: TokenizerOperation;
  readonly outputDescription: string;

  constructor(tokenizer: string, operation: TokenizerOperation, outputDescription: string) {
    super(`Tokenizer "${tokenizer}" returned invalid output from ${operation}: ${outputDescription}`);
    this.tokenizer = tokenizer;
    this.operation = operation;
    this.outputDescription = outputDescription;
  }
}

export class InvalidReferenceError extends ApplicationError {
  readonly code = 'INVALID_REFERENCE';
  readonly referenceKind: InvalidReferenceKind;
  readonly referenceId: string;

  constructor(referenceKind: InvalidReferenceKind, referenceId: string, message?: string) {
    super(message ?? `Unknown ${referenceKind.replaceAll('_', ' ')} reference: ${referenceId}`);
    this.referenceKind = referenceKind;
    this.referenceId = referenceId;
  }
}

export class UnauthorizedExpandError extends ApplicationError {
  readonly code = 'UNAUTHORIZED_EXPAND';
  readonly conversationId: ConversationId;
  readonly summaryId: SummaryNodeId;

  constructor(conversationId: ConversationId, summaryId: SummaryNodeId) {
    super('Caller is not authorized to expand summaries.');
    this.conversationId = conversationId;
    this.summaryId = summaryId;
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly conversationId: ConversationId;
  readonly idempotencyKey: string;

  constructor(conversationId: ConversationId, idempotencyKey: string) {
    super('Idempotency key was reused with a different payload.');
    this.conversationId = conversationId;
    this.idempotencyKey = idempotencyKey;
  }
}

export class ConversationNotFoundError extends ApplicationError {
  readonly code = 'CONVERSATION_NOT_FOUND';
  readonly conversationId: ConversationId;

  constructor(conversationId: ConversationId) {
    super(`Conversation not found: ${conversationId}`);
    this.conversationId = conversationId;
  }
}

export class ArtifactNotFoundError extends ApplicationError {
  readonly code = 'ARTIFACT_NOT_FOUND';
  readonly artifactId: ArtifactId;

  constructor(artifactId: ArtifactId) {
    super(`Artifact not found: ${artifactId}`);
    this.artifactId = artifactId;
  }
}

export class ArtifactContentUnavailableError extends ApplicationError {
  readonly code = 'ARTIFACT_CONTENT_UNAVAILABLE';
  readonly artifactId: ArtifactId;

  constructor(artifactId: ArtifactId) {
    super(`Artifact content unavailable: ${artifactId}`);
    this.artifactId = artifactId;
  }
}

export class ExplorerResolutionError extends ApplicationError {
  readonly code = 'EXPLORER_RESOLUTION_FAILED';
  readonly artifactId: ArtifactId;
  readonly mimeType: string;
  readonly path: string;

  constructor(artifactId: ArtifactId, mimeType: string, path: string, message?: string) {
    super(message ?? `Failed to resolve explorer for artifact ${artifactId}.`);
    this.artifactId = artifactId;
    this.mimeType = mimeType;
    this.path = path;
  }
}

export class ArtifactExplorationFailedError extends ApplicationError {
  readonly code = 'ARTIFACT_EXPLORATION_FAILED';
  readonly artifactId: ArtifactId;

  constructor(artifactId: ArtifactId, cause?: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : 'Unknown exploration failure.';
    super(`Failed to explore artifact ${artifactId}: ${causeMessage}`);
    this.artifactId = artifactId;
  }
}

export class IntegrityCheckExecutionError extends ApplicationError {
  readonly code = 'INTEGRITY_CHECK_EXECUTION_FAILED';
  readonly conversationId: ConversationId;

  constructor(conversationId: ConversationId, message?: string) {
    super(message ?? `Integrity checks could not be completed for conversation: ${conversationId}`);
    this.conversationId = conversationId;
  }
}
