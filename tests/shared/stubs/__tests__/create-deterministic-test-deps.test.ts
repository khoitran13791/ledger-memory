import { describe, expect, it } from 'vitest';

import { createDeterministicTestDeps } from '../create-deterministic-test-deps';

describe('createDeterministicTestDeps', () => {
  it('returns deterministic dependency instances', () => {
    const deps = createDeterministicTestDeps();

    expect(deps.tokenizer.countTokens('abcd')).toEqual({ value: 1 });
    expect(deps.summarizer).toBeDefined();
    expect(deps.clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts custom fixed date for deterministic clock', () => {
    const deps = createDeterministicTestDeps({ fixedDate: new Date('2026-02-02T02:02:02.000Z') });
    expect(deps.clock.now().toISOString()).toBe('2026-02-02T02:02:02.000Z');
  });
});
