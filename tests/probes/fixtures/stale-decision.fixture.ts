import type { StalenessProbeFixture } from '../shared/probe-fixture';

export const staleDecisionFixture: StalenessProbeFixture = {
  name: 'stale-decision',
  type: 'staleness',
  setup: {
    events: [
      {
        role: 'user',
        content: 'Earlier we considered shipping SQLite-backed local durability immediately.',
      },
      { role: 'assistant', content: 'I will keep the decision lifecycle explicit.' },
    ],
    continuityRecords: [
      {
        kind: 'decision',
        title: 'Ship SQLite durability now',
        content: 'Claim local durable memory is ready via SQLite.',
        idempotencyKey: 'decision:sqlite-ready',
      },
      {
        kind: 'decision',
        title: 'Defer SQLite durability claim',
        content:
          'SQLite is not ready yet; warn that in-memory continuity records do not survive process exit and require LEDGERMIND_DB_URL for durability.',
        supersedesRecordIds: ['decision:sqlite-ready'],
        idempotencyKey: 'decision:defer-sqlite',
      },
    ],
  },
  question: 'Should LedgerMind claim SQLite durable local memory is ready?',
  expectedAnswer:
    'No, SQLite durable local memory is not ready; warn that in-memory storage is ephemeral.',
  gradingCriteria: 'stale_record_suppression',
  contextWindow: 260,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 190,
  overheadTokens: 20,
  runCompactionTargetTokens: 95,
};
