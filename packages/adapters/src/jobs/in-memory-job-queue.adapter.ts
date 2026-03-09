import type { Job, JobId, JobQueuePort } from '@ledgermind/application';
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
 * Jobs are recorded in enqueue order and completion callbacks can be triggered manually.
 */
export class InMemoryJobQueueAdapter implements JobQueuePort {
  private nextOrdinal = 1;
  private readonly completionCallbacks = new Map<JobId, Array<(result: unknown) => void>>();
  private readonly enqueuedJobsInternal: EnqueuedJobRecord[] = [];

  get enqueuedJobs(): readonly EnqueuedJobRecord[] {
    return [...this.enqueuedJobsInternal];
  }

  async enqueue<TPayload>(job: Job<TPayload>): Promise<JobId> {
    const jobId = createJobId(this.nextOrdinal);
    this.nextOrdinal += 1;
    this.enqueuedJobsInternal.push({ id: jobId, job });
    return jobId;
  }

  onComplete(jobId: JobId, callback: (result: unknown) => void): void {
    const existingCallbacks = this.completionCallbacks.get(jobId) ?? [];
    this.completionCallbacks.set(jobId, [...existingCallbacks, callback]);
  }

  complete(jobId: JobId, result: unknown): void {
    const callbacks = this.completionCallbacks.get(jobId) ?? [];
    for (const callback of callbacks) {
      callback(result);
    }
  }
}

export type { EnqueuedJobRecord };
