import type { UnitOfWork, UnitOfWorkPort } from '@ledgermind/application';
import type { DatabaseSync } from 'node:sqlite';

import { SqliteArtifactStore } from './sqlite-artifact-store';
import { SqliteContextProjection } from './sqlite-context-projection';
import { SqliteConversationStore } from './sqlite-conversation-store';
import { SqliteLedgerStore } from './sqlite-ledger-store';
import { SqliteOperatorExecutionStore } from './sqlite-operator-execution-store';
import { SqliteSummaryDag } from './sqlite-summary-dag';

const createUnitOfWork = (db: DatabaseSync): UnitOfWork => {
  return {
    ledger: new SqliteLedgerStore(db),
    context: new SqliteContextProjection(db),
    dag: new SqliteSummaryDag(db),
    artifacts: new SqliteArtifactStore(db),
    conversations: new SqliteConversationStore(db),
    operators: new SqliteOperatorExecutionStore(db),
  };
};

export class SqliteUnitOfWork implements UnitOfWorkPort {
  private active = false;

  constructor(private readonly db: DatabaseSync) {}

  async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    if (this.active) {
      throw new Error('Nested SQLite unit of work is not supported.');
    }

    this.active = true;
    let began = false;

    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = await work(createUnitOfWork(this.db));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (began) {
        this.db.exec('ROLLBACK');
      }

      throw error;
    } finally {
      this.active = false;
    }
  }
}

export const createSqliteUnitOfWork = (db: DatabaseSync): SqliteUnitOfWork => {
  return new SqliteUnitOfWork(db);
};
