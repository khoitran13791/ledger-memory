import { describe, expect, it } from 'vitest';

import { InvariantViolationError } from '@ledgermind/domain';

import { PgRetryExhaustedError } from '../errors';
import { withPgTransaction } from '../transaction';
import type { PgPoolClientLike, PgPoolLike } from '../types';

class FakeClient implements PgPoolClientLike {
  readonly queries: string[] = [];
  private readonly handlers: Array<() => Promise<void> | void>;

  constructor(handlers: Array<() => Promise<void> | void> = []) {
    this.handlers = handlers;
  }

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }> {
    this.queries.push(text);
    void params;

    const handler = this.handlers.shift();
    if (handler) {
      await handler();
    }

    return { rows: [], rowCount: 0 };
  }

  release(): void {
    // no-op for test doubles
  }
}

class FakePool implements PgPoolLike {
  private readonly connectHandlers: Array<() => Promise<PgPoolClientLike> | PgPoolClientLike>;

  constructor(client: PgPoolClientLike, connectHandlers: Array<() => Promise<PgPoolClientLike> | PgPoolClientLike> = []) {
    this.connectHandlers = connectHandlers;

    if (this.connectHandlers.length === 0) {
      this.connectHandlers.push(() => client);
    }
  }

  async connect(): Promise<PgPoolClientLike> {
    const next = this.connectHandlers.shift();

    if (!next) {
      throw new Error('No fake connect handler available.');
    }

    return next();
  }

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }> {
    void text;
    void params;
    return { rows: [], rowCount: 0 };
  }
}

describe('withPgTransaction', () => {
  it('retries retryable transaction failure and eventually succeeds', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const pool = new FakePool(firstClient, [() => firstClient, () => secondClient]);

    let workAttempts = 0;

    const result = await withPgTransaction(
      pool,
      async () => {
        workAttempts += 1;
        if (workAttempts === 1) {
          throw Object.assign(new Error('serialization failure'), { code: '40001' });
        }

        return 'ok';
      },
      { maxAttempts: 3 },
    );

    expect(result).toBe('ok');
    expect(workAttempts).toBe(2);
    expect(firstClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(secondClient.queries).toEqual(['BEGIN', 'COMMIT']);
  });

  it('throws PgRetryExhaustedError when retryable failures exhaust attempts', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const pool = new FakePool(firstClient, [() => firstClient, () => secondClient]);

    let workAttempts = 0;

    await expect(
      withPgTransaction(
        pool,
        async () => {
          workAttempts += 1;
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toMatchObject({
      name: 'PgRetryExhaustedError',
      code: 'PERSISTENCE_RETRY_EXHAUSTED',
      attempts: 2,
      sqlState: '40P01',
    });

    expect(workAttempts).toBe(2);
    expect(firstClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(secondClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('does not retry non-retryable failures and preserves typed mapping', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client, [() => client]);

    let workAttempts = 0;

    await expect(
      withPgTransaction(
        pool,
        async () => {
          workAttempts += 1;
          throw Object.assign(new Error('check constraint violated'), { code: '23514' });
        },
        { maxAttempts: 4 },
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    expect(workAttempts).toBe(1);
    expect(client.queries).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('attempts rollback before retrying next attempt', async () => {
    let rollbackCalls = 0;
    const firstClient = new FakeClient([
      () => undefined,
      () => {
        rollbackCalls += 1;
      },
    ]);
    const secondClient = new FakeClient([
      () => undefined,
      () => undefined,
    ]);
    const pool = new FakePool(firstClient, [() => firstClient, () => secondClient]);

    let workAttempts = 0;

    const result = await withPgTransaction(
      pool,
      async () => {
        workAttempts += 1;
        if (workAttempts === 1) {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }

        return 'done';
      },
      { maxAttempts: 3 },
    );

    expect(result).toBe('done');
    expect(rollbackCalls).toBe(1);
    expect(firstClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(secondClient.queries).toEqual(['BEGIN', 'COMMIT']);
  });

  it('retries connect failures when error is retryable', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client, [
      () => {
        throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
      },
      () => client,
    ]);

    let workAttempts = 0;

    const result = await withPgTransaction(
      pool,
      async () => {
        workAttempts += 1;
        return 'connected';
      },
      { maxAttempts: 2 },
    );

    expect(result).toBe('connected');
    expect(workAttempts).toBe(1);
    expect(client.queries).toEqual(['BEGIN', 'COMMIT']);
  });

  it('throws PgRetryExhaustedError when retryable connect failures exhaust attempts', async () => {
    const pool = new FakePool(new FakeClient(), [
      () => {
        throw Object.assign(new Error('connect reset'), { code: 'ECONNRESET' });
      },
      () => {
        throw Object.assign(new Error('connect reset'), { code: 'ECONNRESET' });
      },
    ]);

    await expect(
      withPgTransaction(
        pool,
        async () => {
          throw new Error('work should not run when connect fails');
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toMatchObject({
      name: 'PgRetryExhaustedError',
      code: 'PERSISTENCE_RETRY_EXHAUSTED',
      attempts: 2,
      driverCode: 'ECONNRESET',
    });
  });

  it('executes once for non-pool executors', async () => {
    const client = new FakeClient();
    let workAttempts = 0;

    await expect(
      withPgTransaction(
        client,
        async () => {
          workAttempts += 1;
          throw Object.assign(new Error('serialization failure'), { code: '40001' });
        },
        { maxAttempts: 5 },
      ),
    ).rejects.toMatchObject({ message: 'serialization failure' });

    expect(workAttempts).toBe(1);
    expect(client.queries).toEqual([]);
  });

  it('handles rollback failures by continuing retry logic', async () => {
    const firstClient = new FakeClient([
      () => undefined,
      () => {
        throw new Error('rollback failed');
      },
    ]);
    const secondClient = new FakeClient([
      () => undefined,
      () => undefined,
    ]);
    const pool = new FakePool(firstClient, [() => firstClient, () => secondClient]);

    let workAttempts = 0;

    const result = await withPgTransaction(
      pool,
      async () => {
        workAttempts += 1;
        if (workAttempts === 1) {
          throw Object.assign(new Error('transient network'), { code: 'ETIMEDOUT' });
        }

        return 'recovered';
      },
      { maxAttempts: 2 },
    );

    expect(result).toBe('recovered');
    expect(workAttempts).toBe(2);
    expect(firstClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(secondClient.queries).toEqual(['BEGIN', 'COMMIT']);
  });

  it('defaults to conservative bounded retries when policy omitted', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const thirdClient = new FakeClient();
    const pool = new FakePool(firstClient, [() => firstClient, () => secondClient, () => thirdClient]);

    await expect(
      withPgTransaction(pool, async () => {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }),
    ).rejects.toBeInstanceOf(PgRetryExhaustedError);

    expect(firstClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(secondClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(thirdClient.queries).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('does not retry when COMMIT fails with retryable driver code (ambiguous outcome)', async () => {
    const client = new FakeClient([
      () => undefined,
      () => {
        throw Object.assign(new Error('socket closed during commit'), { code: 'ECONNRESET' });
      },
    ]);
    const pool = new FakePool(client);

    let workAttempts = 0;

    await expect(
      withPgTransaction(
        pool,
        async () => {
          workAttempts += 1;
          return 'ok';
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toMatchObject({ message: 'socket closed during commit' });

    expect(workAttempts).toBe(1);
    expect(client.queries).toEqual(['BEGIN', 'COMMIT']);
  });

  it('does not retry when COMMIT fails with retryable SQLSTATE connection code (ambiguous outcome)', async () => {
    const client = new FakeClient([
      () => undefined,
      () => {
        throw Object.assign(new Error('connection failure during commit'), { code: '08006' });
      },
    ]);
    const pool = new FakePool(client);

    let workAttempts = 0;

    await expect(
      withPgTransaction(
        pool,
        async () => {
          workAttempts += 1;
          return 'ok';
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toMatchObject({ message: 'connection failure during commit' });

    expect(workAttempts).toBe(1);
    expect(client.queries).toEqual(['BEGIN', 'COMMIT']);
  });
});
