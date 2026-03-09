import type { Timestamp } from '@ledgermind/domain';

export interface ClockPort {
  now(): Timestamp;
}
