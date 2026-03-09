import { createTimestamp } from '@ledgermind/domain';
const DEFAULT_FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
/**
 * Deterministic clock for stable tests and fixtures.
 */
export class FixedClock {
    value;
    constructor(date = DEFAULT_FIXED_DATE) {
        this.value = createTimestamp(date);
    }
    now() {
        return this.value;
    }
}
//# sourceMappingURL=fixed-clock.js.map