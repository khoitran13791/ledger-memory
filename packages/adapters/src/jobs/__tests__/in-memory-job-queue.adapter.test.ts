import { describe, expect, it, vi } from 'vitest';

import { InMemoryJobQueueAdapter } from '@ledgermind/adapters';
import type { JobId } from '@ledgermind/application';

describe('InMemoryJobQueueAdapter', () => {
  it('enqueues jobs in order with deterministic IDs', async () => {
    const queue = new InMemoryJobQueueAdapter();

    const jobId1 = await queue.enqueue({
      type: 'run-compaction',
      payload: { conversationId: 'conv_1', trigger: 'soft' },
      priority: 'normal',
    });

    const jobId2 = await queue.enqueue({
      type: 'run-compaction',
      payload: { conversationId: 'conv_2', trigger: 'soft' },
      priority: 'high',
    });

    expect(jobId1).toBe('job_1' as JobId);
    expect(jobId2).toBe('job_2' as JobId);
    expect(queue.enqueuedJobs).toHaveLength(2);
    expect(queue.enqueuedJobs[0]?.job.type).toBe('run-compaction');
    expect(queue.enqueuedJobs[1]?.job.priority).toBe('high');
  });

  it('invokes completion callbacks when completed manually', async () => {
    const queue = new InMemoryJobQueueAdapter();
    const callback = vi.fn<(result: unknown) => void>();

    const jobId = await queue.enqueue({
      type: 'run-compaction',
      payload: { conversationId: 'conv_3', trigger: 'soft' },
    });

    queue.onComplete(jobId, callback);
    queue.complete(jobId, { ok: true });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ ok: true });
  });

  it('supports multiple callbacks per job', async () => {
    const queue = new InMemoryJobQueueAdapter();
    const callbackA = vi.fn<(result: unknown) => void>();
    const callbackB = vi.fn<(result: unknown) => void>();

    const jobId = await queue.enqueue({
      type: 'run-compaction',
      payload: { conversationId: 'conv_4', trigger: 'soft' },
    });

    queue.onComplete(jobId, callbackA);
    queue.onComplete(jobId, callbackB);
    queue.complete(jobId, 'done');

    expect(callbackA).toHaveBeenCalledWith('done');
    expect(callbackB).toHaveBeenCalledWith('done');
  });
});
