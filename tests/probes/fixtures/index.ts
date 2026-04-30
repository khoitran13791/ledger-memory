import type { ProbeFixture } from '../shared/probe-fixture';

import { artifactHostFixture } from './artifact-host.fixture';
import { continuationNextStepFixture } from './continuation-next-step.fixture';
import { decisionConstraintFixture } from './decision-constraint.fixture';
import { recallTimeoutFixture } from './recall-timeout.fixture';
import { sessionResumeHandoffFixture } from './session-resume-handoff.fixture';
import { staleDecisionFixture } from './stale-decision.fixture';
import { toolEvidenceFixture } from './tool-evidence.fixture';
import { toolUsageExpandFixture } from './tool-usage-expand.fixture';
import { verificationFailureFixture } from './verification-failure.fixture';

export {
  artifactHostFixture,
  continuationNextStepFixture,
  decisionConstraintFixture,
  recallTimeoutFixture,
  sessionResumeHandoffFixture,
  staleDecisionFixture,
  toolEvidenceFixture,
  toolUsageExpandFixture,
  verificationFailureFixture,
};

export const probeFixtures: readonly ProbeFixture[] = Object.freeze([
  recallTimeoutFixture,
  artifactHostFixture,
  continuationNextStepFixture,
  decisionConstraintFixture,
  toolUsageExpandFixture,
  sessionResumeHandoffFixture,
  staleDecisionFixture,
  verificationFailureFixture,
  toolEvidenceFixture,
]);
