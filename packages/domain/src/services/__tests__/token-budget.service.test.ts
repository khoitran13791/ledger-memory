import { describe, expect, it } from 'vitest';

import { createConversationConfig } from '../../entities/conversation';
import { InvariantViolationError } from '../../errors/domain-errors';
import { createCompactionThresholds } from '../../value-objects/compaction-thresholds';
import { createTokenBudget } from '../../value-objects/token-budget';
import { createTokenCount } from '../../value-objects/token-count';
import { createTokenBudgetService } from '../token-budget.service';

describe('token budget service', () => {
  const baseConfig = createConversationConfig({
    modelName: 'claude-opus-4-6',
    contextWindow: createTokenCount(1_000),
    thresholds: createCompactionThresholds(0.5, 0.7),
  });

  it('computes budget from conversation config and overhead', () => {
    const service = createTokenBudgetService();
    const budget = service.computeBudget(baseConfig, createTokenCount(100));

    expect(budget.contextWindow.value).toBe(1_000);
    expect(budget.reserve.value).toBe(250);
    expect(budget.available.value).toBe(650);
  });

  it('uses conversation thresholds for soft and hard checks when budget is service-computed', () => {
    const service = createTokenBudgetService();
    const budget = service.computeBudget(baseConfig, createTokenCount(100));

    expect(service.isOverSoftThreshold(createTokenCount(400), budget)).toBe(false);
    expect(service.isOverSoftThreshold(createTokenCount(401), budget)).toBe(true);

    expect(service.isOverHardThreshold(createTokenCount(600), budget)).toBe(false);
    expect(service.isOverHardThreshold(createTokenCount(601), budget)).toBe(true);
  });

  it('falls back to default soft threshold and available hard threshold for plain TokenBudget values', () => {
    const service = createTokenBudgetService();
    const budget = createTokenBudget({
      contextWindow: createTokenCount(1_000),
      overhead: createTokenCount(100),
      reserve: createTokenCount(250),
    });

    expect(service.isOverSoftThreshold(createTokenCount(500), budget)).toBe(false);
    expect(service.isOverSoftThreshold(createTokenCount(501), budget)).toBe(true);

    expect(service.isOverHardThreshold(createTokenCount(650), budget)).toBe(false);
    expect(service.isOverHardThreshold(createTokenCount(651), budget)).toBe(true);
  });

  it('computes target free tokens from available budget', () => {
    const service = createTokenBudgetService();
    const budget = service.computeBudget(baseConfig, createTokenCount(100));

    const targetFree = service.computeTargetFreeTokens(budget, 0.15);
    expect(targetFree.value).toBe(97);
  });

  it('rejects invalid service configuration and free-percentage input', () => {
    expect(() => createTokenBudgetService({ softThresholdFraction: 1.1 })).toThrow(
      InvariantViolationError,
    );
    expect(() => createTokenBudgetService({ reserveFraction: -0.1 })).toThrow(
      InvariantViolationError,
    );
    expect(() => createTokenBudgetService({ maxReserveTokens: 0 })).toThrow(InvariantViolationError);

    const service = createTokenBudgetService();
    const budget = service.computeBudget(baseConfig, createTokenCount(100));

    expect(() => service.computeTargetFreeTokens(budget, -0.01)).toThrow(InvariantViolationError);
    expect(() => service.computeTargetFreeTokens(budget, 1.01)).toThrow(InvariantViolationError);
  });
});
