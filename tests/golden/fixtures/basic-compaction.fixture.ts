import type { CoreUseCasesFixture } from '../../shared/fixtures';

export const basicCompactionFixture: CoreUseCasesFixture = {
  name: 'basic-compaction',
  conversation: {
    modelName: 'test-model',
    contextWindow: 4_000,
    thresholds: {
      soft: 0.6,
      hard: 1.0,
    },
  },
  events: [
    { role: 'user', content: 'Help me design a deterministic test harness.' },
    { role: 'assistant', content: 'I will propose deterministic stubs and fixture contracts.' },
    { role: 'user', content: 'Ensure replay stability across repeated runs.' },
    { role: 'assistant', content: 'We will enforce stable fixtures and fixed deterministic dependencies.' },
    { role: 'user', content: 'Add deterministic hash coverage for content-addressed IDs.' },
    { role: 'assistant', content: 'Acknowledged. IDs will remain stable for replay verification.' },
    { role: 'user', content: 'Keep the tail context untouched for latest-step continuity.' },
  ],
  actions: [
    { type: 'runCompaction', trigger: 'soft', targetTokens: 70 },
    { type: 'materialize', budgetTokens: 1_000, overheadTokens: 200 },
    { type: 'checkIntegrity' },
  ],
  expected: {
    dagNodeCount: 1,
    dagNodeKinds: ['leaf'],
    contextItemCount: 4,
    budgetUsedLessThan: 260,
    integrityPassed: true,
    summaryIdPrefix: 'sum_',
    expandRecoveryCount: 4,
  },
};
