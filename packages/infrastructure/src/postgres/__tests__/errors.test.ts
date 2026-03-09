import { describe, expect, it } from 'vitest';

import { InvariantViolationError, NonMonotonicSequenceError } from '@ledgermind/domain';

import {
  classifyPgError,
  createRetryExhaustedError,
  isAmbiguousCommitFailure,
  isRetryablePgError,
  mapPgError,
  PgRetryExhaustedError,
} from '../errors';

describe('postgres error classification', () => {
  it.each([
    { code: '40001' },
    { code: '40P01' },
    { code: '55P03' },
    { code: '08006' },
    { code: '08P01' },
    { code: 'ECONNRESET' },
    { code: 'ECONNREFUSED' },
    { code: 'ETIMEDOUT' },
    { code: 'EPIPE' },
  ])('classifies $code as retryable', ({ code }) => {
    const err = Object.assign(new Error('transient failure'), { code });

    const classification = classifyPgError(err);

    expect(classification.retryability).toBe('retryable');
    expect(isRetryablePgError(err)).toBe(true);
  });

  it.each([
    { code: '23505' },
    { code: '23503' },
    { code: '23514' },
    { code: '22P02' },
    { code: 'P0001' },
    { code: undefined },
  ])('classifies $code as non-retryable', ({ code }) => {
    const err = code
      ? Object.assign(new Error('non transient failure'), { code })
      : new Error('non transient failure');

    const classification = classifyPgError(err);

    expect(classification.retryability).toBe('non_retryable');
    expect(isRetryablePgError(err)).toBe(false);
  });

  it('includes sqlState metadata for SQLSTATE values', () => {
    const err = Object.assign(new Error('serialization failure'), { code: '40001' });

    const classification = classifyPgError(err);

    expect(classification.sqlState).toBe('40001');
    expect(classification.driverCode).toBeUndefined();
  });

  it('includes driverCode metadata for retryable driver error codes', () => {
    const err = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });

    const classification = classifyPgError(err);

    expect(classification.driverCode).toBe('ECONNRESET');
    expect(classification.sqlState).toBeUndefined();
  });
});

describe('postgres error mapping', () => {
  it('maps sequence unique violation to NonMonotonicSequenceError', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'ledger_events_conversation_id_seq_key',
    });

    expect(() => mapPgError(err)).toThrow(NonMonotonicSequenceError);
  });

  it.each([
    {
      name: 'generic unique violation',
      error: Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'other_constraint',
      }),
    },
    {
      name: 'foreign key violation',
      error: Object.assign(new Error('insert or update violates foreign key'), {
        code: '23503',
      }),
    },
    {
      name: 'check violation',
      error: Object.assign(new Error('check constraint violated'), {
        code: '23514',
      }),
    },
    {
      name: 'invalid text representation',
      error: Object.assign(new Error('invalid input syntax for type integer'), {
        code: '22P02',
      }),
    },
  ])('maps $name to InvariantViolationError', ({ error }) => {
    expect(() => mapPgError(error)).toThrow(InvariantViolationError);
  });

  it('rethrows unknown SQLSTATE errors unchanged', () => {
    const err = Object.assign(new Error('unknown state'), { code: '57P01' });

    try {
      mapPgError(err);
      throw new Error('expected mapPgError to throw');
    } catch (caught) {
      expect(caught).toBe(err);
    }
  });

  it('rethrows non-pg-like errors unchanged', () => {
    const err = new TypeError('bad input');

    try {
      mapPgError(err);
      throw new Error('expected mapPgError to throw');
    } catch (caught) {
      expect(caught).toBe(err);
    }
  });
});

describe('ambiguous commit failure detection', () => {
  it.each([
    {
      name: 'driver retryable classification',
      classification: classifyPgError(Object.assign(new Error('socket closed during commit'), { code: 'ECONNRESET' })),
      expected: true,
    },
    {
      name: 'sqlstate connection classification',
      classification: classifyPgError(
        Object.assign(new Error('connection failure during commit'), { code: '08006' }),
      ),
      expected: true,
    },
    {
      name: 'retryable non-connection sqlstate classification',
      classification: classifyPgError(Object.assign(new Error('serialization failure'), { code: '40001' })),
      expected: false,
    },
    {
      name: 'non-retryable classification',
      classification: classifyPgError(Object.assign(new Error('check constraint violation'), { code: '23514' })),
      expected: false,
    },
  ])('returns $expected for $name', ({ classification, expected }) => {
    expect(isAmbiguousCommitFailure(classification)).toBe(expected);
  });
});

describe('retry exhaustion typing', () => {
  it('creates typed retry exhausted error with attempt and sqlState metadata', () => {
    const err = Object.assign(new Error('serialization failure'), { code: '40001' });

    const exhausted = createRetryExhaustedError(err, 3);

    expect(exhausted).toBeInstanceOf(PgRetryExhaustedError);
    expect(exhausted.code).toBe('PERSISTENCE_RETRY_EXHAUSTED');
    expect(exhausted.retryability).toBe('retryable');
    expect(exhausted.attempts).toBe(3);
    expect(exhausted.sqlState).toBe('40001');
    expect(exhausted.driverCode).toBeUndefined();
    expect(exhausted.lastError).toBe(err);
  });

  it('creates typed retry exhausted error with driverCode metadata', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

    const exhausted = createRetryExhaustedError(err, 2);

    expect(exhausted).toBeInstanceOf(PgRetryExhaustedError);
    expect(exhausted.attempts).toBe(2);
    expect(exhausted.sqlState).toBeUndefined();
    expect(exhausted.driverCode).toBe('ECONNRESET');
  });

  it('normalizes non-Error inputs into Error cause', () => {
    const exhausted = createRetryExhaustedError('socket timeout', 1);

    expect(exhausted).toBeInstanceOf(PgRetryExhaustedError);
    expect(exhausted.attempts).toBe(1);
    expect(exhausted.lastError).toBeInstanceOf(Error);
    expect(exhausted.lastError.message).toBe('socket timeout');
  });
});
