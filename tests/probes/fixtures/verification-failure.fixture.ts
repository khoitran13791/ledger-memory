import type { VerificationProbeFixture } from '../shared/probe-fixture';

export const verificationFailureFixture: VerificationProbeFixture = {
  name: 'verification-failure',
  type: 'verification',
  setup: {
    events: [
      { role: 'user', content: 'Before continuing, remember whether verification is blocking.' },
      { role: 'assistant', content: 'I will keep failed checks visible in current state.' },
    ],
    continuityRecords: [
      {
        kind: 'failure',
        title: 'pnpm test -- tests/probes failed',
        content: 'Probe evaluation failed because session handoff recall omitted Task 15.',
        provenance: {
          command: 'pnpm test -- tests/probes',
        },
        idempotencyKey: 'failure:probe-tests',
      },
    ],
  },
  question: 'Is there any failed verification blocking continuation?',
  expectedAnswer: 'Yes, pnpm test -- tests/probes failed and blocks continuation.',
  gradingCriteria: 'blocking_evidence',
  contextWindow: 260,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 190,
  overheadTokens: 20,
  runCompactionTargetTokens: 95,
};
