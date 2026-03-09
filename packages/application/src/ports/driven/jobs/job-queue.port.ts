export type JobPriority = 'low' | 'normal' | 'high';

export type JobId = string & { readonly __brand: 'JobId' };

export interface Job<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly priority?: JobPriority;
}

export interface JobQueuePort {
  enqueue<TPayload>(job: Job<TPayload>): Promise<JobId>;
  onComplete(jobId: JobId, callback: (result: unknown) => void): void;
}
