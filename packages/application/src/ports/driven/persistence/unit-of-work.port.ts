import type { ArtifactStorePort } from './artifact-store.port';
import type { ContextProjectionPort } from './context-projection.port';
import type { ConversationPort } from './conversation.port';
import type { LedgerAppendPort } from './ledger-append.port';
import type { SummaryDagPort } from './summary-dag.port';

export interface UnitOfWork {
  readonly ledger: LedgerAppendPort;
  readonly context: ContextProjectionPort;
  readonly dag: SummaryDagPort;
  readonly artifacts: ArtifactStorePort;
  readonly conversations: ConversationPort;
}

/**
 * Executes work in an atomic persistence boundary.
 *
 * Implementations must commit all mutations on success, or roll back all
 * mutations if the callback throws.
 */
export interface UnitOfWorkPort {
  execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
