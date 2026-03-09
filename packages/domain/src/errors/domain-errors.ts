export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}

export class HashMismatchError extends DomainError {
  readonly code = 'HASH_MISMATCH';

  constructor(message: string) {
    super(message);
  }
}

export class InvalidDagEdgeError extends DomainError {
  readonly code = 'INVALID_DAG_EDGE';

  constructor(message: string) {
    super(message);
  }
}

export class NonMonotonicSequenceError extends DomainError {
  readonly code = 'NON_MONOTONIC_SEQUENCE';

  constructor(message: string) {
    super(message);
  }
}

export class BudgetExceededError extends DomainError {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(message: string) {
    super(message);
  }
}
