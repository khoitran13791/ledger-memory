import type { CoreUseCasesFixture } from '../../shared/fixtures';

import { basicCompactionFixture } from './basic-compaction.fixture';

export { basicCompactionFixture };

export const goldenReplayFixtures: readonly CoreUseCasesFixture[] = Object.freeze([
  basicCompactionFixture,
]);
