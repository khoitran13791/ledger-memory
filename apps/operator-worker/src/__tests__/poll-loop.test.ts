import { describe, expect, it, vi } from 'vitest';

import { createOperatorWorkerPollLoop } from '../poll-loop';

describe('createOperatorWorkerPollLoop', () => {
  it('claims tasks before finalization retries in one poll iteration', async () => {
    const executeNextTask = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const finalizeNextRun = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const loop = createOperatorWorkerPollLoop({
      pollIntervalMs: 100,
      executeNextTask,
      finalizeNextRun,
      wait: async () => undefined,
    });

    await loop.runIteration();

    expect(executeNextTask).toHaveBeenCalledBefore(finalizeNextRun);
    expect(finalizeNextRun).toHaveBeenCalledTimes(1);
  });

  it('keeps claiming until the store reports no more claimable tasks instead of tracking local concurrency', async () => {
    const executeNextTask = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const loop = createOperatorWorkerPollLoop({
      pollIntervalMs: 100,
      executeNextTask,
      finalizeNextRun: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      wait: async () => undefined,
    });

    await loop.runIteration();

    expect(executeNextTask).toHaveBeenCalledTimes(3);
  });

  it('wakes early on queue hints but remains runnable without a queue subscription', async () => {
    let wake: (() => void) | undefined;
    const wait = vi.fn<(ms: number) => Promise<void>>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    );

    const subscribe = vi.fn(async (_type: string, handler: () => void) => {
      return {
        close(): void {
          return;
        },
      };
    });

    const loop = createOperatorWorkerPollLoop({
      pollIntervalMs: 100,
      executeNextTask: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      finalizeNextRun: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      wait,
      subscribeToWakeHints: subscribe,
    });

    const idle = loop.waitForNextCycle();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const handler = subscribe.mock.calls[0]?.[1];
    expect(handler).toBeTypeOf('function');
    handler?.();
    wake?.();
    await idle;

    const noQueueLoop = createOperatorWorkerPollLoop({
      pollIntervalMs: 100,
      executeNextTask: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      finalizeNextRun: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      wait: async () => undefined,
    });

    await expect(noQueueLoop.waitForNextCycle()).resolves.toBeUndefined();
  });
});
