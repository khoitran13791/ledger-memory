import type { CoreUseCasesFixture } from '../../shared/fixtures';

import { escalationNonShrinkFixture } from './escalation-non-shrink.fixture';
import { maxRoundNonConvergeFixture } from './max-round-non-converge.fixture';

export { escalationNonShrinkFixture, maxRoundNonConvergeFixture };

export const escalationRegressionFixtures: readonly CoreUseCasesFixture[] = Object.freeze([
  escalationNonShrinkFixture,
  maxRoundNonConvergeFixture,
]);
