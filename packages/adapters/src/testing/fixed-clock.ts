import type { ClockPort } from '@ledgermind/application';
import { createTimestamp, type Timestamp } from '@ledgermind/domain';

const DEFAULT_FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/**
 * Deterministic clock for stable tests and fixtures.
 */
export class FixedClock implements ClockPort {
  private readonly value: Timestamp;

  constructor(date: Date = DEFAULT_FIXED_DATE) {
    this.value = createTimestamp(date);
  }

  now(): Timestamp {
    return this.value;
  }
}
