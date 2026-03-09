import {
  DeterministicSummarizer,
  FixedClock,
  SimpleTokenizer,
} from '@ledgermind/adapters';
import {
  createIdService,
  type HashPort,
  type IdService,
} from '@ledgermind/domain';

export interface DeterministicTestDeps {
  readonly tokenizer: SimpleTokenizer;
  readonly summarizer: DeterministicSummarizer;
  readonly clock: FixedClock;
  readonly hashPort: HashPort;
  readonly idService: IdService;
}

export interface DeterministicTestDepsOptions {
  readonly fixedDate?: Date;
}

const deterministicHashPort: HashPort = {
  sha256: (input) => {
    let acc = 2166136261;

    for (const byte of input) {
      acc ^= byte;
      acc = Math.imul(acc, 16777619) >>> 0;
    }

    return acc.toString(16).padStart(8, '0').repeat(8);
  },
};

/**
 * Creates deterministic runtime dependencies for golden/property/regression suites.
 */
export const createDeterministicTestDeps = (
  options: DeterministicTestDepsOptions = {},
): DeterministicTestDeps => {
  const tokenizer = new SimpleTokenizer();
  const summarizer = new DeterministicSummarizer(tokenizer);
  const clock = new FixedClock(options.fixedDate);

  return {
    tokenizer,
    summarizer,
    clock,
    hashPort: deterministicHashPort,
    idService: createIdService(deterministicHashPort),
  };
};
