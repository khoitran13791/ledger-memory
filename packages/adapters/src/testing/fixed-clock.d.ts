import type { ClockPort } from '@ledgermind/application';
import { type Timestamp } from '@ledgermind/domain';
/**
 * Deterministic clock for stable tests and fixtures.
 */
export declare class FixedClock implements ClockPort {
    private readonly value;
    constructor(date?: Date);
    now(): Timestamp;
}
//# sourceMappingURL=fixed-clock.d.ts.map