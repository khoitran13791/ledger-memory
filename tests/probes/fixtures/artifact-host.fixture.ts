import type { ArtifactProbeFixture } from '../shared/probe-fixture';

export const artifactHostFixture: ArtifactProbeFixture = {
  name: 'artifact-database-host',
  type: 'artifact',
  setup: {
    events: [
      { role: 'system', content: 'Track artifact references explicitly in the memory timeline.' },
      { role: 'user', content: 'Store this database configuration artifact for deployment checks.' },
      {
        role: 'assistant',
        content: 'Parsed config/database.json and confirmed host db.prod with port 5432.',
      },
      { role: 'assistant', content: 'Stored. I will preserve the artifact host details during compaction.' },
    ],
    artifacts: [
      {
        path: 'config/database.json',
        content: '{"host":"db.prod","port":5432}',
        mimeType: 'application/json',
      },
    ],
  },
  question: 'What database host is configured?',
  expectedAnswer: 'db.prod',
  requiresArtifactReference: true,
  contextWindow: 260,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 180,
  overheadTokens: 20,
  runCompactionTargetTokens: 85,
};
