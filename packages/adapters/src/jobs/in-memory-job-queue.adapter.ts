import type { Job, JobHandler, JobId, JobQueuePort, JobSubscription } from '@ledgermind/application';
import { InvariantViolationError } from '@ledgermind/domain';

interface EnqueuedJobRecord<TPayload = unknown> {
  readonly id: JobId;
  readonly job: Job<TPayload>;
}

const createJobId = (ordinal: number): JobId => {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
    throw new InvariantViolationError('Job ordinal must be a positive safe integer.');
  }

  return `job_${ordinal}` as JobId;
};

/**
 * Minimal in-memory queue for deterministic async scheduling in tests.
 * Jobs are recorded in enqueue order and matching subscribers are notified immediately.
 */
export class InMemoryJobQueueAdapter implements JobQueuePort {
  private nextOrdinal = 1;
  private readonly enqueuedJobsInternal: EnqueuedJobRecord[] = [];
  private readonly subscribers = new Map<string, Set<JobHandler>>();

  get enqueuedJobs(): readonly EnqueuedJobRecord[] {
    return [...this.enqueuedJobsInternal];
  }

  async enqueue<TPayload>(job: Job<TPayload>): Promise<JobId> {
    const jobId = createJobId(this.nextOrdinal);
    this.nextOrdinal += 1;
    this.enqueuedJobsInternal.push({ id: jobId, job });

    const subscribers = this.subscribers.get(job.type);
    if (subscribers !== undefined) {
      for (const handler of subscribers) {
        await handler(job);
      }
    }

    return jobId;
  }

  async subscribe<TPayload>(type: string, handler: JobHandler<TPayload>): Promise<JobSubscription> {
    const subscribers = this.subscribers.get(type) ?? new Set<JobHandler>();
    subscribers.add(handler as JobHandler);
    this.subscribers.set(type, subscribers);

    return {
      close: () => {
        const currentSubscribers = this.subscribers.get(type);
        if (currentSubscribers === undefined) {
          return;
        }

        currentSubscribers.delete(handler as JobHandler);
        if (currentSubscribers.size === 0) {
          this.subscribers.delete(type);
        }
      },
    };
  }
}

export type { EnqueuedJobRecord };
