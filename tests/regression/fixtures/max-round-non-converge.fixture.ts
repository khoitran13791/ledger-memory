import type { CoreUseCasesFixture } from '../../shared/fixtures';

export const maxRoundNonConvergeFixture: CoreUseCasesFixture = {
  name: 'max-round-non-converge',
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
        'Persistent oversized transcript segment alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha.',
    },
    {
      role: 'assistant',
      content:
        'Persistent oversized transcript segment beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta.',
    },
    {
      role: 'user',
      content:
        'Persistent oversized transcript segment gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma.',
    },
    {
      role: 'assistant',
      content:
        'Persistent oversized transcript segment delta delta delta delta delta delta delta delta delta delta delta delta delta delta delta delta.',
    },
  ],
  actions: [{ type: 'materialize', budgetTokens: 220, overheadTokens: 120 }],
  expected: {
    dagNodeCount: 1,
    dagNodeKinds: ['leaf'],
    contextItemCount: 3,
    budgetUsedLessThan: 120,
    integrityPassed: true,
    summaryIdPrefix: 'sum_',
    expandRecoveryCount: 4,
  },
};
