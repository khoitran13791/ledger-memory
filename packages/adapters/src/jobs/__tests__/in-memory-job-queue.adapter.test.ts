import { describe, expect, it, vi } from 'vitest';

import type { Job, JobId } from '@ledgermind/application';

import { InMemoryJobQueueAdapter } from '../in-memory-job-queue.adapter';

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

  it('delivers enqueued jobs to subscribers in order', async () => {
    const queue = new InMemoryJobQueueAdapter();
    const received: Job[] = [];

    await queue.subscribe('operator-run-created', (job) => {
      received.push(job);
    });

    await queue.enqueue({
      type: 'operator-run-created',
      payload: { runId: 'run_1', conversationId: 'conv_1' },
      priority: 'normal',
    });
    await queue.enqueue({
      type: 'operator-run-created',
      payload: { runId: 'run_2', conversationId: 'conv_2' },
      priority: 'high',
    });

    expect(received).toEqual([
      {
        type: 'operator-run-created',
        payload: { runId: 'run_1', conversationId: 'conv_1' },
        priority: 'normal',
      },
      {
        type: 'operator-run-created',
        payload: { runId: 'run_2', conversationId: 'conv_2' },
        priority: 'high',
      },
    ]);
  });

  it('delivers the same wake-up hint to duplicate subscribers', async () => {
    const queue = new InMemoryJobQueueAdapter();
    const handlerA = vi.fn<(job: Job) => void>();
    const handlerB = vi.fn<(job: Job) => void>();
    const wakeHint = {
      type: 'operator-run-created',
      payload: { runId: 'run_3', conversationId: 'conv_3' },
      priority: 'normal',
    } satisfies Job;

    await queue.subscribe('operator-run-created', handlerA);
    await queue.subscribe('operator-run-created', handlerB);
    await queue.enqueue(wakeHint);

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA).toHaveBeenCalledWith(wakeHint);
    expect(handlerB).toHaveBeenCalledWith(wakeHint);
  });

  it('stops delivering future jobs after unsubscribe', async () => {
    const queue = new InMemoryJobQueueAdapter();
    const handler = vi.fn<(job: Job) => void>();

    const subscription = await queue.subscribe('operator-run-created', handler);
    await queue.enqueue({
      type: 'operator-run-created',
      payload: { runId: 'run_4', conversationId: 'conv_4' },
      priority: 'normal',
    });
    await subscription.close();
    await queue.enqueue({
      type: 'operator-run-created',
      payload: { runId: 'run_5', conversationId: 'conv_5' },
      priority: 'normal',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: 'operator-run-created',
      payload: { runId: 'run_4', conversationId: 'conv_4' },
      priority: 'normal',
    });
  });
});
