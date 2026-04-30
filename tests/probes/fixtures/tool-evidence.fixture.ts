import type { VerificationProbeFixture } from '../shared/probe-fixture';

export const toolEvidenceFixture: VerificationProbeFixture = {
  name: 'tool-evidence',
  type: 'verification',
  setup: {
    events: [
      { role: 'user', content: 'Preserve command and file provenance for verification evidence.' },
      { role: 'assistant', content: 'I will cite the command and changed file when asked.' },
    ],
    continuityRecords: [
      {
        kind: 'verification',
        title: 'Bash verification: pnpm --filter @ledgermind/claude-code test -- post-tool-use',
        content:
          'Command passed for the tool evidence hook change in packages/claude-code/src/commands/post-tool-use.ts.',
        provenance: {
          command: 'pnpm --filter @ledgermind/claude-code test -- post-tool-use',
          transcriptPath: 'packages/claude-code/src/commands/post-tool-use.ts',
        },
        idempotencyKey: 'verification:post-tool-use',
      },
    ],
  },
  question: 'Which verification command proves the tool evidence hook change?',
  expectedAnswer:
    'pnpm --filter @ledgermind/claude-code test -- post-tool-use in packages/claude-code/src/commands/post-tool-use.ts',
  gradingCriteria: 'blocking_evidence',
  contextWindow: 280,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 260,
  overheadTokens: 20,
  runCompactionTargetTokens: 130,
};
