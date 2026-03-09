import type { DecisionProbeFixture } from '../shared/probe-fixture';

export const decisionConstraintFixture: DecisionProbeFixture = {
  name: 'decision-no-new-dependencies',
  type: 'decision',
  setup: [
    { role: 'user', content: 'We must not add any new npm dependencies.' },
    { role: 'assistant', content: 'Understood. I will use only built-in Node.js modules.' },
    { role: 'user', content: 'Keep this constraint visible during compaction and task continuation.' },
    { role: 'assistant', content: 'Constraint preserved: no new npm packages.' },
  ],
  question: 'Can we use lodash for this utility function?',
  expectedAnswer: 'No — we decided not to add new npm dependencies',
  gradingCriteria: 'constraint_adherence',
  contextWindow: 220,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 160,
  overheadTokens: 20,
  runCompactionTargetTokens: 80,
};
