import type { ProbeFixture } from '../shared/probe-fixture';

import { artifactHostFixture } from './artifact-host.fixture';
import { continuationNextStepFixture } from './continuation-next-step.fixture';
import { decisionConstraintFixture } from './decision-constraint.fixture';
import { recallTimeoutFixture } from './recall-timeout.fixture';
import { toolUsageExpandFixture } from './tool-usage-expand.fixture';

export {
  artifactHostFixture,
  continuationNextStepFixture,
  decisionConstraintFixture,
  recallTimeoutFixture,
  toolUsageExpandFixture,
};

export const probeFixtures: readonly ProbeFixture[] = Object.freeze([
  recallTimeoutFixture,
  artifactHostFixture,
  continuationNextStepFixture,
  decisionConstraintFixture,
  toolUsageExpandFixture,
]);
