import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  DomainError,
  HashMismatchError,
  InvalidDagEdgeError,
  InvariantViolationError,
  NonMonotonicSequenceError,
} from '../index';

type ErrorCase = {
  readonly ctor: new (message: string) => DomainError;
  readonly expectedCode: string;
  readonly expectedName: string;
};

describe('domain errors taxonomy', () => {
  it('defines specialized errors with stable codes and inheritance', () => {
    const cases: readonly ErrorCase[] = [
      {
        ctor: InvariantViolationError,
        expectedCode: 'INVARIANT_VIOLATION',
        expectedName: 'InvariantViolationError',
      },
      {
        ctor: HashMismatchError,
        expectedCode: 'HASH_MISMATCH',
        expectedName: 'HashMismatchError',
      },
      {
        ctor: InvalidDagEdgeError,
        expectedCode: 'INVALID_DAG_EDGE',
        expectedName: 'InvalidDagEdgeError',
      },
      {
        ctor: NonMonotonicSequenceError,
        expectedCode: 'NON_MONOTONIC_SEQUENCE',
        expectedName: 'NonMonotonicSequenceError',
      },
      {
        ctor: BudgetExceededError,
        expectedCode: 'BUDGET_EXCEEDED',
        expectedName: 'BudgetExceededError',
      },
    ];

    for (const testCase of cases) {
      const error = new testCase.ctor('domain failure');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(testCase.ctor);
      expect(error.message).toBe('domain failure');
      expect(error.code).toBe(testCase.expectedCode);
      expect(error.name).toBe(testCase.expectedName);
    }
  });

  it('allows downstream domain-specific subclasses via DomainError contract', () => {
    class TestDomainError extends DomainError {
      readonly code = 'TEST_ERROR';

      constructor(message: string) {
        super(message);
      }
    }

    const error = new TestDomainError('test');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('TEST_ERROR');
    expect(error.name).toBe('TestDomainError');
  });
});
