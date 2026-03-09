import type { UnitOfWork, UnitOfWorkPort } from '@ledgermind/application';

import type { PgTransactionRetryPolicy } from './transaction';

import { PgArtifactStore } from './pg-artifact-store';
import { PgContextProjection } from './pg-context-projection';
import { PgConversationStore } from './pg-conversation-store';
import { PgLedgerStore } from './pg-ledger-store';
import { PgSummaryDag } from './pg-summary-dag';
import type { Pool } from 'pg';

import { withPgTransaction } from './transaction';
import { asPgExecutor, type PgExecutor } from './types';

const createUnitOfWork = (executor: PgExecutor): UnitOfWork => {
  return {
    ledger: new PgLedgerStore(executor),
    context: new PgContextProjection(executor),
    dag: new PgSummaryDag(executor),
    artifacts: new PgArtifactStore(executor),
    conversations: new PgConversationStore(executor),
  };
};

export class PgUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly executor: PgExecutor) {}

  async execute<T>(
    work: (uow: UnitOfWork) => Promise<T>,
    retryPolicy?: PgTransactionRetryPolicy,
  ): Promise<T> {
    return withPgTransaction(
      this.executor,
      async (client) => {
        const unitOfWork = createUnitOfWork(client);
        return work(unitOfWork);
      },
      retryPolicy,
    );
  }
}

export const createPgUnitOfWork = (executor: PgExecutor): PgUnitOfWork => {
  return new PgUnitOfWork(executor);
};

export const createPgUnitOfWorkFromPool = (pool: Pool): PgUnitOfWork => {
  return new PgUnitOfWork(asPgExecutor(pool));
};
