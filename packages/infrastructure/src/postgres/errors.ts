import { StaleContextVersionError } from '@ledgermind/application';
import {
  InvariantViolationError,
  NonMonotonicSequenceError,
  type ContextVersion,
} from '@ledgermind/domain';

interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly message: string;
}

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01', '55P03']);
const RETRYABLE_DRIVER_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);

export type PgRetryability = 'retryable' | 'non_retryable';

export interface PgErrorClassification {
  readonly retryability: PgRetryability;
  readonly cause: Error;
  readonly sqlState?: string;
  readonly driverCode?: string;
  readonly constraint?: string;
  readonly detail?: string;
}

export class PgRetryExhaustedError extends Error {
  readonly code = 'PERSISTENCE_RETRY_EXHAUSTED';
  readonly retryability: PgRetryability = 'retryable';
  readonly attempts: number;
  readonly sqlState?: string;
  readonly driverCode?: string;
  readonly lastError: Error;

  constructor(
    attempts: number,
    lastError: Error,
    sqlState?: string,
    driverCode?: string,
  ) {
    super(
      `PostgreSQL retry attempts exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
    );
    this.name = 'PgRetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;

    if (sqlState !== undefined) {
      this.sqlState = sqlState;
    }

    if (driverCode !== undefined) {
      this.driverCode = driverCode;
    }
  }
}

const asPgErrorLike = (error: unknown): PgErrorLike | null => {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return null;
  }

  const candidate = error as {
    readonly code?: unknown;
    readonly constraint?: unknown;
    readonly detail?: unknown;
    readonly message: unknown;
  };

  if (typeof candidate.message !== 'string') {
    return null;
  }

  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
    ...(typeof candidate.detail === 'string' ? { detail: candidate.detail } : {}),
    message: candidate.message,
  };
};

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  return new Error('Unknown PostgreSQL persistence error.');
};

const isSqlState = (value: string): boolean => {
  return /^[0-9A-Z]{5}$/.test(value);
};

const isRetryableSqlState = (value: string): boolean => {
  return RETRYABLE_SQL_STATES.has(value) || (isSqlState(value) && value.startsWith('08'));
};

const withOptionalMetadata = (
  base: {
    readonly retryability: PgRetryability;
    readonly cause: Error;
    readonly sqlState?: string;
    readonly driverCode?: string;
  },
  pgError: PgErrorLike,
): PgErrorClassification => {
  return {
    ...base,
    ...(pgError.constraint !== undefined ? { constraint: pgError.constraint } : {}),
    ...(pgError.detail !== undefined ? { detail: pgError.detail } : {}),
  };
};

export const classifyPgError = (error: unknown): PgErrorClassification => {
  const pgError = asPgErrorLike(error);
  const cause = toError(error);

  if (!pgError || !pgError.code) {
    return {
      retryability: 'non_retryable',
      cause,
    };
  }

  if (isRetryableSqlState(pgError.code)) {
    return withOptionalMetadata(
      {
        retryability: 'retryable',
        cause,
        sqlState: pgError.code,
      },
      pgError,
    );
  }

  if (RETRYABLE_DRIVER_CODES.has(pgError.code)) {
    return withOptionalMetadata(
      {
        retryability: 'retryable',
        cause,
        driverCode: pgError.code,
      },
      pgError,
    );
  }

  if (isSqlState(pgError.code)) {
    return withOptionalMetadata(
      {
        retryability: 'non_retryable',
        cause,
        sqlState: pgError.code,
      },
      pgError,
    );
  }

  return withOptionalMetadata(
    {
      retryability: 'non_retryable',
      cause,
      driverCode: pgError.code,
    },
    pgError,
  );
};

export const isRetryablePgError = (error: unknown): boolean => {
  return classifyPgError(error).retryability === 'retryable';
};

export const isAmbiguousCommitFailure = (classification: PgErrorClassification): boolean => {
  if (classification.retryability !== 'retryable') {
    return false;
  }

  if (classification.driverCode !== undefined) {
    return true;
  }

  return classification.sqlState !== undefined && classification.sqlState.startsWith('08');
};

export const createRetryExhaustedError = (
  error: unknown,
  attempts: number,
): PgRetryExhaustedError => {
  const classification = classifyPgError(error);

  return new PgRetryExhaustedError(
    attempts,
    classification.cause,
    classification.sqlState,
    classification.driverCode,
  );
};

const buildConstraintMessage = (
  prefix: string,
  error: PgErrorLike,
  fallback: string,
): string => {
  if (error.constraint) {
    return `${prefix} (${error.constraint}).`;
  }

  return `${prefix} ${fallback}`.trim();
};

export const mapPgError = (error: unknown): never => {
  const pgError = asPgErrorLike(error);
  if (!pgError) {
    throw error;
  }

  if (pgError.code === '23505') {
    if (pgError.constraint === 'ledger_events_conversation_id_seq_key') {
      throw new NonMonotonicSequenceError(
        buildConstraintMessage(
          'LedgerEvent sequence must remain gap-free and unique per conversation',
          pgError,
          pgError.message,
        ),
      );
    }

    throw new InvariantViolationError(
      buildConstraintMessage('Unique constraint violation during PostgreSQL persistence', pgError, pgError.message),
    );
  }

  if (pgError.code === '23503') {
    throw new InvariantViolationError(
      buildConstraintMessage('Invalid PostgreSQL reference during persistence', pgError, pgError.message),
    );
  }

  if (pgError.code === '23514' || pgError.code === '22P02') {
    throw new InvariantViolationError(
      buildConstraintMessage('PostgreSQL constraint validation failed', pgError, pgError.message),
    );
  }

  throw error;
};

export const createStaleContextError = (
  expectedVersion: ContextVersion,
  actualVersion: ContextVersion,
): StaleContextVersionError => {
  return new StaleContextVersionError(expectedVersion, actualVersion);
};
