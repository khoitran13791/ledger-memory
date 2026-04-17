export interface OperatorWorkerPollLoop {
  runIteration(): Promise<void>;
  waitForNextCycle(): Promise<void>;
}

export interface CreateOperatorWorkerPollLoopOptions {
  readonly pollIntervalMs: number;
  readonly executeNextTask: () => Promise<boolean>;
  readonly finalizeNextRun: () => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
  readonly subscribeToWakeHints?: (
    type: string,
    handler: () => void,
  ) => Promise<{ close(): Promise<void> | void }>;
}

export const createOperatorWorkerPollLoop = (
  options: CreateOperatorWorkerPollLoopOptions,
): OperatorWorkerPollLoop => {
  let wakeRequested = false;
  let subscribed = false;

  const ensureWakeSubscription = async (): Promise<void> => {
    if (subscribed || options.subscribeToWakeHints === undefined) {
      return;
    }

    subscribed = true;
    await options.subscribeToWakeHints('operator-run-created', () => {
      wakeRequested = true;
    });
  };

  return {
    async runIteration(): Promise<void> {
      while (await options.executeNextTask()) {
        // keep draining claimable tasks until the persistence layer says stop
      }

      await options.finalizeNextRun();
    },

    async waitForNextCycle(): Promise<void> {
      await ensureWakeSubscription();
      if (wakeRequested) {
        wakeRequested = false;
        return;
      }

      await options.wait(options.pollIntervalMs);
      wakeRequested = false;
    },
  };
};
