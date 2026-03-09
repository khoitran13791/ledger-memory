import { describe, expect, it } from 'vitest';

import { basicCompactionFixture, goldenReplayFixtures } from '../fixtures';

describe('golden fixture shape', () => {
  it('keeps basic compaction fixture aligned with deterministic contract', () => {
    expect(basicCompactionFixture.name).toBe('basic-compaction');
    expect(basicCompactionFixture.events.length).toBeGreaterThan(0);
    expect(basicCompactionFixture.actions).toEqual([
      {
        type: 'runCompaction',
        trigger: 'soft',
        targetTokens: 70,
      },
      {
        type: 'materialize',
        budgetTokens: 1_000,
        overheadTokens: 200,
      },
      {
        type: 'checkIntegrity',
      },
    ]);
    expect(basicCompactionFixture.expected.summaryIdPrefix).toBe('sum_');
    expect(basicCompactionFixture.expected.integrityPassed).toBe(true);
  });

  it('keeps replay fixture registry deterministic and non-empty', () => {
    expect(goldenReplayFixtures.length).toBeGreaterThan(0);

    for (const fixture of goldenReplayFixtures) {
      expect(fixture.name.trim().length).toBeGreaterThan(0);
      expect(fixture.events.length).toBeGreaterThan(0);
      expect(fixture.actions.length).toBeGreaterThan(0);
      expect(fixture.expected.summaryIdPrefix).toBe('sum_');
      expect(fixture.expected.integrityPassed).toBe(true);
    }
  });
});
