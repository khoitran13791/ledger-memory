import {
  classifyPgError,
  createRetryExhaustedError,
  isAmbiguousCommitFailure,
  mapPgError,
} from './errors';
import { isPgPoolLike, type PgExecutor, type PgPoolClientLike } from './types';

const DEFAULT_MAX_ATTEMPTS = 3;

export interface PgTransactionRetryPolicy {
  readonly maxAttempts?: number;
}

const resolveMaxAttempts = (policy?: PgTransactionRetryPolicy): number => {
  const configured = policy?.maxAttempts;

  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 1) {
    return DEFAULT_MAX_ATTEMPTS;
  }

  return configured;
};

export const withPgTransaction = async <T>(
  executor: PgExecutor,
  work: (client: PgPoolClientLike) => Promise<T>,
  retryPolicy?: PgTransactionRetryPolicy,
): Promise<T> => {
  if (!isPgPoolLike(executor)) {
    return work(executor);
  }

  const maxAttempts = resolveMaxAttempts(retryPolicy);
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;

    let client: PgPoolClientLike | null = null;
    let commitStarted = false;

    try {
      client = await executor.connect();
      await client.query('BEGIN');
      const result = await work(client);
      commitStarted = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      const classification = classifyPgError(error);

      if (commitStarted && isAmbiguousCommitFailure(classification)) {
        throw classification.cause;
      }

      if (client !== null) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors and preserve original failure behavior.
        }
      }

      if (classification.retryability === 'retryable') {
        if (attempts < maxAttempts) {
          continue;
        }

        throw createRetryExhaustedError(error, attempts);
      }

      mapPgError(error);
    } finally {
      client?.release();
    }
  }

  throw createRetryExhaustedError(new Error('Retry attempts exhausted.'), maxAttempts);
};
