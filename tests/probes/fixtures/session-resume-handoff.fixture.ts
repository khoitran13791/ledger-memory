import type { HandoffProbeFixture } from '../shared/probe-fixture';

export const sessionResumeHandoffFixture: HandoffProbeFixture = {
  name: 'session-resume-handoff',
  type: 'handoff',
  setup: {
    sessionA: {
      events: [
        { role: 'user', content: 'We are turning LedgerMind into an agent continuity layer.' },
        {
          role: 'assistant',
          content: 'Task 13 and 14 are done. Next local durability work remains.',
        },
      ],
      stopHandoff: {
        goal: 'Make LedgerMind resumable after context reset',
        completed: ['Captured tool evidence', 'Added PostgreSQL continuity indexes'],
        nextSteps: [
          {
            title: 'Implement Task 15 durability fallback warning',
            content: 'Warn Claude hooks when only in-memory continuity storage is configured.',
          },
          {
            title: 'Implement Task 16 continuity probes',
            content: 'Add handoff, staleness, verification, and tool evidence probes.',
          },
        ],
        decisions: [
          'Do not claim durable local memory until SQLite or equivalent passes conformance.',
        ],
        constraints: ['No new native dependency for the alpha durability path.'],
        verification: ['Task 13 and 14 focused tests passed before handoff.'],
        changedFiles: ['packages/claude-code/src/commands/post-tool-use.ts'],
        idempotencyKey: 'probe:session-resume-handoff',
      },
    },
    sessionB: {
      question: 'After the reset, what should the next task be?',
    },
  },
  question: 'After the reset, what should the next task be?',
  expectedAnswer: 'Implement Task 15 durability fallback warning',
  gradingCriteria: 'handoff_recovery',
  contextWindow: 280,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 220,
  overheadTokens: 20,
  runCompactionTargetTokens: 110,
};
