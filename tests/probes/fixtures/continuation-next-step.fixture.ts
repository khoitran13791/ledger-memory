import type { ContinuationProbeFixture } from '../shared/probe-fixture';

export const continuationNextStepFixture: ContinuationProbeFixture = {
  name: 'continuation-next-step',
  type: 'continuation',
  setup: [
    {
      role: 'user',
      content:
        'Plan: 1) Add schema 2) Write migration 3) Add API endpoint 4) Write tests 5) Update docs',
    },
    {
      role: 'assistant',
      content:
        'Step 1: Added User schema. Step 2: Created migration 001. Step 3: Added /users endpoint.',
    },
    {
      role: 'user',
      content: 'Great, preserve progress so we can continue after compaction.',
    },
  ],
  question: 'What should we do next?',
  expectedAnswer: 'Step 4: Write tests (for the /users endpoint)',
  gradingCriteria: 'correct_next_step',
  contextWindow: 260,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 180,
  overheadTokens: 20,
  runCompactionTargetTokens: 90,
};
