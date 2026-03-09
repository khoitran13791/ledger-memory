import type { RecallProbeFixture } from '../shared/probe-fixture';

export const recallTimeoutFixture: RecallProbeFixture = {
  name: 'recall-redis-timeout',
  type: 'recall',
  setup: [
    { role: 'system', content: 'You are preserving implementation decisions for follow-up work.' },
    { role: 'user', content: 'Set the Redis connection timeout to 30 seconds for production reliability.' },
    { role: 'assistant', content: 'Done. Updated redis.config.ts with timeout: 30000ms.' },
    { role: 'user', content: 'Also keep retry jitter enabled.' },
    { role: 'assistant', content: 'Confirmed: retry jitter remains enabled.' },
  ],
  question: 'What is the Redis connection timeout?',
  expectedAnswer: '30 seconds (30000ms)',
  gradingCriteria: 'exact_value',
  contextWindow: 240,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 180,
  overheadTokens: 20,
  runCompactionTargetTokens: 90,
};
