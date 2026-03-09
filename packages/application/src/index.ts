export type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  ArtifactReference,
  ArtifactSource,
  CheckIntegrityInput,
  CheckIntegrityOutput,
  DescribeInput,
  DescribeOutput,
  ExpandInput,
  ExpandOutput,
  ExploreArtifactInput,
  ExploreArtifactOutput,
  ExplorerHints,
  GrepInput,
  GrepMatch,
  GrepOutput,
  MaterializeContextInput,
  MaterializeContextOutput,
  MemoryEngine,
  Metadata,
  ModelMessage,
  NewLedgerEvent,
  PinRule,
  RetrievalHint,
  RunCompactionInput,
  RunCompactionOutput,
  StoreArtifactInput,
  StoreArtifactOutput,
  SummaryReference,
} from './ports/driving/memory-engine.port';

export type { DomainEventSubscriber } from './ports/driving/event-subscriber.port';
export type { ToolDefinition, ToolProviderPort } from './ports/driving/tool-provider.port';

export type { ArtifactStorePort } from './ports/driven/persistence/artifact-store.port';
export type { ContextProjectionPort } from './ports/driven/persistence/context-projection.port';
export { StaleContextVersionError } from './ports/driven/persistence/context-projection.port';
export type { ConversationPort } from './ports/driven/persistence/conversation.port';
export type { LedgerAppendPort } from './ports/driven/persistence/ledger-append.port';
export type {
  GrepMatch as LedgerReadGrepMatch,
  LedgerReadPort,
  SequenceRange,
} from './ports/driven/persistence/ledger-read.port';
export type {
  IntegrityCheckResult,
  IntegrityReport,
  SummaryDagPort,
} from './ports/driven/persistence/summary-dag.port';
export type { UnitOfWork, UnitOfWorkPort } from './ports/driven/persistence/unit-of-work.port';

export type {
  SummarizationInput,
  SummarizationMessage,
  SummarizationMode,
  SummarizationOutput,
  SummarizerPort,
} from './ports/driven/llm/summarizer.port';
export type { TokenizerPort } from './ports/driven/llm/tokenizer.port';

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
export type { Job, JobId, JobPriority, JobQueuePort } from './ports/driven/jobs/job-queue.port';

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
