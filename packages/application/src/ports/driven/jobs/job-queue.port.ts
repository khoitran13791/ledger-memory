export type JobPriority = 'low' | 'normal' | 'high';

export type JobId = string & { readonly __brand: 'JobId' };

export interface Job<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly priority?: JobPriority;
}

export type JobHandler<TPayload = unknown> = (job: Job<TPayload>) => void | Promise<void>;

export interface JobSubscription {
  close(): Promise<void> | void;
}

export interface JobQueuePort {
  enqueue<TPayload>(job: Job<TPayload>): Promise<JobId>;
  subscribe<TPayload>(type: string, handler: JobHandler<TPayload>): Promise<JobSubscription>;
}
