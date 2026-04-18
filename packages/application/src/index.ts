export type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  ArtifactReference,
  ArtifactSource,
  CheckIntegrityInput,
  CheckIntegrityOutput,
  DescribeArtifactPlanningSignals,
  DescribeInput,
  DescribeOutput,
  DescribeSummaryPlanningSignals,
  ExpandInput,
  ExpandOutput,
  ExploreArtifactInput,
  ExploreArtifactOutput,
  ExplorerHints,
  GrepGroup,
  GrepInput,
  GrepMatch,
  GrepOutput,
  GrepPageInfo,
  MaterializeContextInput,
  MaterializeContextOutput,
  MemoryEngine,
  Metadata,
  ModelMessage,
  NewLedgerEvent,
  PinRule,
  RetrievalHint,
  RetrievalHintDiagnostics,
  RetrievalStageLabel,
  RetrievalStageQueryDiagnostics,
  RetrievalCandidateDecisionReason,
  RetrievalCandidateDecisionDiagnostics,
  RunCompactionInput,
  RunCompactionOutput,
  StoreArtifactInput,
  StoreArtifactOutput,
  SummaryReference,
} from './ports/driving/memory-engine.port';
export type {
  AgenticMapInput,
  AgenticMapOutput,
  DelegatedScopeInput,
  GetOperatorRunInput,
  GetOperatorRunOutput,
  KeptWorkInput,
  LLMMapInput,
  LLMMapOutput,
  OperatorBootstrapState,
  OperatorFailureMetadata,
  OperatorFinalizationStage,
  OperatorKind,
  OperatorResultEntry,
  OperatorRunStatus,
  OperatorTaskInspection,
  OperatorTaskStatus,
  RetryPolicy,
} from './ports/driving/operator-execution.port';

export type { DomainEventSubscriber } from './ports/driving/event-subscriber.port';
export type {
  ToolAccessLevel,
  ToolDefinition,
  ToolPolicyMetadata,
  ToolProviderPort,
  ToolRuntimeContextProvider,
} from './ports/driving/tool-provider.port';

export type { ArtifactStorePort } from './ports/driven/persistence/artifact-store.port';
export type { ContextProjectionPort } from './ports/driven/persistence/context-projection.port';
export { StaleContextVersionError } from './ports/driven/persistence/context-projection.port';
export type { ConversationPort } from './ports/driven/persistence/conversation.port';
export type { LedgerAppendPort } from './ports/driven/persistence/ledger-append.port';
export type {
  GrepMatch as LedgerReadGrepMatch,
  LedgerReadPort,
  RegexSearchPageInput,
  RegexSearchPageOutput,
  SequenceRange,
} from './ports/driven/persistence/ledger-read.port';
export type {
  IntegrityCheckResult,
  IntegrityReport,
  SummaryDagPort,
} from './ports/driven/persistence/summary-dag.port';
export type {
  AdvanceFinalizationStageInput,
  AssignTaskChildConversationInput,
  ClaimRunForFinalizationRetryInput,
  ClaimTaskLeaseInput,
  CreateOperatorRunWithTasksInput,
  FinalizeRunInput,
  MarkTaskRetryableFailureInput,
  OperatorExecutionPort,
  OperatorSubmissionInput,
  RecordTaskFailureInput,
  RecordTaskSuccessInput,
  StoredOperatorRun,
  StoredOperatorTask,
} from './ports/driven/persistence/operator-execution.port';
export { createNoopOperatorExecutionPort } from './ports/driven/persistence/noop-operator-execution.port';
export type { UnitOfWork, UnitOfWorkPort } from './ports/driven/persistence/unit-of-work.port';

export type {
  StructuredGenerationInput,
  StructuredGenerationPort,
  StructuredGenerationResult,
} from './ports/driven/llm/structured-generation.port';
export type {
  SummarizationInput,
  SummarizationMessage,
  SummarizationMode,
  SummarizationOutput,
  SummarizerPort,
} from './ports/driven/llm/summarizer.port';
export type { TokenizerPort } from './ports/driven/llm/tokenizer.port';

export type {
  DelegationScopeArtifactPayload,
  DelegationScopeResolution,
  DelegationScopeResolverPort,
} from './ports/driven/agents/delegation-scope-resolver.port';
export type {
  SubAgentExecutorInput,
  SubAgentExecutorPort,
  SubAgentExecutorResult,
} from './ports/driven/agents/sub-agent-executor.port';
export type { AuthorizationPort, CallerContext } from './ports/driven/auth/authorization.port';
export type { ClockPort } from './ports/driven/clock/clock.port';
export type { FileReaderPort } from './ports/driven/filesystem/file-reader.port';
export type {
  ExplorerHints as ExplorerPortHints,
  ExplorerInput,
  ExplorerOutput,
  ExplorerPort,
} from './ports/driven/explorer/explorer.port';
export type { ExplorerRegistryPort } from './ports/driven/explorer/explorer-registry.port';
// eslint-disable-next-line no-restricted-imports -- local application contract path, not Node.js crypto module
export type { HashPort } from './ports/driven/crypto/hash.port';
export type { EventPublisherPort } from './ports/driven/events/event-publisher.port';
export type {
  Job,
  JobHandler,
  JobId,
  JobPriority,
  JobQueuePort,
  JobSubscription,
} from './ports/driven/jobs/job-queue.port';

export {
  ApplicationError,
  ArtifactContentUnavailableError,
  ArtifactExplorationFailedError,
  ArtifactNotFoundError,
  ConversationNotFoundError,
  ExplorerResolutionError,
  IdempotencyConflictError,
  IntegrityCheckExecutionError,
  InvalidReferenceError,
  InvalidTokenizerOutputError,
  OperatorBootstrapStateError,
  OperatorFinalizationError,
  OperatorInputValidationError,
  OperatorRunNotFoundError,
  TokenizerConfigurationError,
  UnauthorizedExpandError,
  type InvalidReferenceKind,
  type TokenizerOperation,
} from './errors/application-errors';

export {
  AppendLedgerEventsUseCase,
  type AppendLedgerEventsUseCaseDeps,
} from './use-cases/append-ledger-events';
export {
  MaterializeContextUseCase,
  type MaterializeContextUseCaseDeps,
} from './use-cases/materialize-context';
export {
  RunCompactionUseCase,
  type RunCompactionUseCaseDeps,
  type RunCompactionConfig,
} from './use-cases/run-compaction';
export {
  CheckIntegrityUseCase,
  type CheckIntegrityUseCaseDeps,
} from './use-cases/check-integrity';
export {
  GrepUseCase,
  type GrepUseCaseDeps,
} from './use-cases/grep';
export {
  DescribeUseCase,
  type DescribeUseCaseDeps,
} from './use-cases/describe';
export {
  ExpandUseCase,
  type ExpandUseCaseDeps,
} from './use-cases/expand';
export {
  StoreArtifactUseCase,
  type StoreArtifactUseCaseDeps,
} from './use-cases/store-artifact';
export {
  ExploreArtifactUseCase,
  type ExploreArtifactUseCaseDeps,
} from './use-cases/explore-artifact';
export {
  LLMMapUseCase,
  type LLMMapUseCaseDeps,
} from './use-cases/llm-map';
export {
  AgenticMapUseCase,
  type AgenticMapUseCaseDeps,
} from './use-cases/agentic-map';
export {
  GetOperatorRunUseCase,
  type GetOperatorRunUseCaseDeps,
} from './use-cases/get-operator-run';
export {
  ExecuteOperatorTaskUseCase,
  type ExecuteOperatorTaskUseCaseDeps,
} from './use-cases/execute-operator-task';
export {
  FinalizeOperatorRunUseCase,
  type FinalizeOperatorRunInput,
  type FinalizeOperatorRunUseCaseDeps,
} from './use-cases/finalize-operator-run';
export {
  InvalidOperatorConfigError,
  createOperatorConfig,
  type OperatorConfig,
} from './use-cases/operators/shared/operator-config';
export { loadOperatorDataset, validateOperatorDatasetSource } from './use-cases/operators/shared/input-dataset';
export {
  createFailedResultEntry,
  createSucceededResultEntry,
} from './use-cases/operators/shared/result-entry';
