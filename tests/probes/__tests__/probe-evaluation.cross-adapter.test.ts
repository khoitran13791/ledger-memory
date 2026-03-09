import { describe, expect, it } from 'vitest';

import { probeFixtures } from '../fixtures';
import { runProbeScenario, type ProbeAdapterName } from '../shared/run-probe-scenario';

const adapters: readonly ProbeAdapterName[] = ['in-memory', 'postgres'];

describe.each(adapters)('probe-based evaluation (%s)', (adapter) => {
  it.each(probeFixtures)('scores and passes probe fixture: $name', async (fixture) => {
    const result = await runProbeScenario({
      fixture,
      adapter,
    });

    expect(result.fixtureName).toBe(fixture.name);
    expect(result.probeType).toBe(fixture.type);
    expect(result.modelMessageCount).toBeGreaterThan(0);
    expect(result.materializedBudgetUsed).toBeLessThanOrEqual(fixture.budgetTokens - fixture.overheadTokens);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.maxScore).toBe(5);
    expect(result.passed).toBe(true);

    if (fixture.type === 'artifact') {
      expect(result.artifactIds.length).toBeGreaterThan(0);
      expect(
        result.answer.includes('file_') ||
          result.answer.toLowerCase().includes('memory.describe') ||
          result.answer.toLowerCase().includes('memory.expand'),
      ).toBe(true);
    }

    if (fixture.type === 'tool_usage') {
      const normalized = result.answer.toLowerCase();
      expect(normalized.includes('memory.expand') || normalized.includes('expand(')).toBe(true);
    }

    expect(result.reasons).toEqual([]);
  });
});
