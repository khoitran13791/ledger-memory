import { ApplicationError } from '../../../errors/application-errors';

export interface OperatorConfig {
  readonly maxConcurrencyLimit: number;
  readonly maxInlineOperatorInputBytes: number;
  readonly maxKeptWorkChars: number;
  readonly maxInlineRunResultsBytes: number;
  readonly executionTimeoutSeconds: number;
  readonly leaseDurationSeconds: number;
  readonly retryBackoffSeconds: number;
}

const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  maxConcurrencyLimit: 32,
  maxInlineOperatorInputBytes: 256_000,
  maxKeptWorkChars: 4_000,
  maxInlineRunResultsBytes: 64_000,
  executionTimeoutSeconds: 300,
  leaseDurationSeconds: 360,
  retryBackoffSeconds: 30,
};

export class InvalidOperatorConfigError extends ApplicationError {
  readonly code = 'OPERATOR_CONFIG_INVALID';

  constructor(message: string) {
    super(message);
  }
}

const assertPositiveSafeInteger = (value: number, field: keyof OperatorConfig): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidOperatorConfigError(`${field} must be a positive safe integer.`);
  }
};

export const createOperatorConfig = (overrides: Partial<OperatorConfig> = {}): OperatorConfig => {
  const config: OperatorConfig = {
    ...DEFAULT_OPERATOR_CONFIG,
    ...overrides,
  };

  assertPositiveSafeInteger(config.maxConcurrencyLimit, 'maxConcurrencyLimit');
  assertPositiveSafeInteger(config.maxInlineOperatorInputBytes, 'maxInlineOperatorInputBytes');
  assertPositiveSafeInteger(config.maxKeptWorkChars, 'maxKeptWorkChars');
  assertPositiveSafeInteger(config.maxInlineRunResultsBytes, 'maxInlineRunResultsBytes');
  assertPositiveSafeInteger(config.executionTimeoutSeconds, 'executionTimeoutSeconds');
  assertPositiveSafeInteger(config.leaseDurationSeconds, 'leaseDurationSeconds');
  assertPositiveSafeInteger(config.retryBackoffSeconds, 'retryBackoffSeconds');

  return Object.freeze(config);
};
