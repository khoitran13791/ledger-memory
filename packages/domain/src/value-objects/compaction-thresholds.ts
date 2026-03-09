import { InvariantViolationError } from '../errors/domain-errors';

export interface CompactionThresholds {
  readonly soft: number;
  readonly hard: number;
}

export const createCompactionThresholds = (
  soft: number,
  hard: number,
): CompactionThresholds => {
  if (!Number.isFinite(soft) || !Number.isFinite(hard)) {
    throw new InvariantViolationError('Compaction thresholds must be finite numbers.');
  }

  if (soft <= 0 || hard <= 0) {
    throw new InvariantViolationError('Compaction thresholds must be greater than zero.');
  }

  if (soft >= hard) {
    throw new InvariantViolationError('Compaction soft threshold must be lower than hard threshold.');
  }

  return Object.freeze({ soft, hard });
};
