import type { CoreUseCasesFixture } from '../../shared/fixtures';

/**
 * Regression-oriented fixture seed for escalation-path coverage:
 * non-shrinking normal/aggressive summaries must reach deterministic fallback.
 */
export const escalationNonShrinkFixture: CoreUseCasesFixture = {
  name: 'escalation-non-shrink',
  conversation: {
    modelName: 'test-model',
    contextWindow: 2_048,
    thresholds: {
      soft: 0.6,
      hard: 1.0,
    },
  },
  events: [
    {
      role: 'user',
      content:
        'Repeatable long payload block A A A A A A A A A A A A A A A A A A A A A A A A A A A A A A.',
    },
    {
      role: 'assistant',
      content:
        'Repeatable long payload block B B B B B B B B B B B B B B B B B B B B B B B B B B B B B B.',
    },
    {
      role: 'user',
      content:
        'Repeatable long payload block C C C C C C C C C C C C C C C C C C C C C C C C C C C C C C.',
    },
  ],
  actions: [{ type: 'materialize', budgetTokens: 760, overheadTokens: 120 }],
  expected: {
    dagNodeCount: 1,
    dagNodeKinds: ['leaf'],
    contextItemCount: 3,
    budgetUsedLessThan: 480,
    integrityPassed: true,
    summaryIdPrefix: 'sum_',
    expandRecoveryCount: 3,
  },
};
