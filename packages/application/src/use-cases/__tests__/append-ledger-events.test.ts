import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  ContextItem,
  ContextVersion,
  Conversation,
  ConversationConfig,
  ConversationId,
  DomainEvent,
  EventId,
  HashPort,
  LedgerEvent,
  SequenceNumber,
  SummaryNode,
} from '@ledgermind/domain';
import {
  createContextItem,
  createContextVersion,
  createConversation,
  createConversationConfig,
  createConversationId,
  createIdService,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type { Job, JobId, JobQueuePort } from '../../ports/driven/jobs/job-queue.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerAppendPort } from '../../ports/driven/persistence/ledger-append.port';
import type { LedgerReadPort, SequenceRange } from '../../ports/driven/persistence/ledger-read.port';
import type { IntegrityReport, SummaryDagPort } from '../../ports/driven/persistence/summary-dag.port';
import type { UnitOfWork, UnitOfWorkPort } from '../../ports/driven/persistence/unit-of-work.port';
import { IdempotencyConflictError } from '../../errors/application-errors';
import type { EventPublisherPort } from '../../ports/driven/events/event-publisher.port';
import type { AppendLedgerEventsInput } from '../../ports/driving/memory-engine.port';
import { AppendLedgerEventsUseCase } from '../append-ledger-events';

const conversationId = createConversationId('conv_append_uc');

const createTestConversation = (
  overrides?: Partial<{
    contextWindow: number;
    softThreshold: number;
    hardThreshold: number;
  }>,
): Conversation => {
  const config: ConversationConfig = createConversationConfig({
    modelName: 'claude-opus-4-6',
    contextWindow: createTokenCount(overrides?.contextWindow ?? 100),
    thresholds: {
      soft: overrides?.softThreshold ?? 0.6,
      hard: overrides?.hardThreshold ?? 1,
    },
  });

  return createConversation({
    id: conversationId,
    config,
    createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
  });
};

type MutableState = {
  conversation: Conversation | null;
  events: LedgerEvent[];
  contextEventIds: EventId[];
  contextVersion: ContextVersion;
};

const cloneState = (state: MutableState): MutableState => {
  return {
    conversation: state.conversation,
    events: [...state.events],
    contextEventIds: [...state.contextEventIds],
    contextVersion: createContextVersion(state.contextVersion),
  };
};

const applyState = (target: MutableState, source: MutableState): void => {
  target.conversation = source.conversation;
  target.events = [...source.events];
  target.contextEventIds = [...source.contextEventIds];
  target.contextVersion = source.contextVersion;
};

class DeterministicHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
}

class DeterministicClock implements ClockPort {
  private tick = 0;

  now() {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick));
    this.tick += 1;
    return createTimestamp(date);
  }
}

class TestLedgerStore implements LedgerAppendPort {
  constructor(private readonly state: MutableState) {}

  async appendEvents(conversationIdInput: ConversationId, events: readonly LedgerEvent[]): Promise<void> {
    const next = [...this.state.events];

    for (const event of events) {
      if (event.conversationId !== conversationIdInput) {
        throw new Error('conversation mismatch');
      }

      if (next.some((existing) => existing.id === event.id)) {
        continue;
      }

      const expectedSequence = next.length + 1;
      if (event.sequence !== expectedSequence) {
        throw new Error(`expected sequence ${expectedSequence}, received ${event.sequence}`);
      }

      next.push(event);
    }

    this.state.events = next;
  }

  async getNextSequence(conversationIdInput: ConversationId): Promise<SequenceNumber> {
    const events = this.state.events.filter((e) => e.conversationId === conversationIdInput);
    return createSequenceNumber(events.length + 1);
  }
}

class TestLedgerRead implements LedgerReadPort {
  constructor(private readonly state: MutableState) {}

  async getEvents(conversationIdInput: ConversationId, range?: SequenceRange): Promise<readonly LedgerEvent[]> {
    const ordered = this.state.events
      .filter((event) => event.conversationId === conversationIdInput)
      .sort((left, right) => left.sequence - right.sequence);

    if (range === undefined) {
      return ordered;
    }

    return ordered.filter((event) => {
      if (range.start !== undefined && event.sequence < range.start) {
        return false;
      }

      if (range.end !== undefined && event.sequence > range.end) {
        return false;
      }

      return true;
    });
  }

  async searchEvents(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async regexSearchEvents() {
    return [];
  }
}

class TestContextProjection implements ContextProjectionPort {
  constructor(
    private readonly state: MutableState,
    private readonly options: { failOnAppend: boolean },
  ) {}

  async getCurrentContext(conversationIdInput: ConversationId): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ContextVersion;
  }> {
    return {
      items: this.state.contextEventIds.map((eventId, position) =>
        createContextItem({
          conversationId: conversationIdInput,
          position,
          ref: createMessageContextItemRef(eventId),
        }),
      ),
      version: this.state.contextVersion,
    };
  }

  async getContextTokenCount(): Promise<ReturnType<typeof createTokenCount>> {
    const eventsById = new Map(this.state.events.map((event) => [event.id, event] as const));

    let total = 0;
    for (const eventId of this.state.contextEventIds) {
      const event = eventsById.get(eventId);
      if (event !== undefined) {
        total += event.tokenCount.value;
      }
    }

    return createTokenCount(total);
  }

  async appendContextItems(
    conversationIdInput: ConversationId,
    items: readonly ContextItem[],
  ): Promise<ContextVersion> {
    if (this.options.failOnAppend) {
      throw new Error('context append failure');
    }

    for (const item of items) {
      if (item.conversationId !== conversationIdInput || item.ref.type !== 'message') {
        throw new Error('unexpected context item shape');
      }

      this.state.contextEventIds.push(item.ref.messageId);
    }

    this.state.contextVersion = createContextVersion(this.state.contextVersion + 1);
    return this.state.contextVersion;
  }

  async replaceContextItems(): Promise<ContextVersion> {
    throw new Error('not implemented in test double');
  }
}

class TestConversationStore implements ConversationPort {
  constructor(private readonly state: MutableState) {}

  async create(config: ConversationConfig): Promise<Conversation> {
    const conversation = createConversation({
      id: createConversationId('conv_created_for_test'),
      config,
    });

    this.state.conversation = conversation;
    return conversation;
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    if (this.state.conversation?.id === id) {
      return this.state.conversation;
    }

    return null;
  }

  async getAncestorChain(): Promise<readonly ConversationId[]> {
    return [];
  }
}

class NoopSummaryDagStore implements SummaryDagPort {
  async createNode(): Promise<void> {
    return;
  }

  async getNode(): Promise<SummaryNode | null> {
    return null;
  }

  async addLeafEdges(): Promise<void> {
    return;
  }

  async addCondensedEdges(): Promise<void> {
    return;
  }

  async getParentSummaryIds(): Promise<readonly SummaryNode['id'][]> {
    return [];
  }

  async expandToMessages(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async searchSummaries(): Promise<readonly SummaryNode[]> {
    return [];
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    return {
      passed: true,
      checks: [],
    };
  }
}

class NoopArtifactStore implements ArtifactStorePort {
  async store(): Promise<void> {
    return;
  }

  async getMetadata(): Promise<Artifact | null> {
    return null;
  }

  async getContent(): Promise<string | Uint8Array | null> {
    return null;
  }

  async updateExploration(): Promise<void> {
    return;
  }
}

class TestUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly state: MutableState,
    private readonly options: { failContextAppend: boolean },
  ) {}

  async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const workingState = cloneState(this.state);

    const uow: UnitOfWork = {
      ledger: new TestLedgerStore(workingState),
      context: new TestContextProjection(workingState, {
        failOnAppend: this.options.failContextAppend,
      }),
      dag: new NoopSummaryDagStore(),
      artifacts: new NoopArtifactStore(),
      conversations: new TestConversationStore(workingState),
    };

    const result = await work(uow);
    applyState(this.state, workingState);
    return result;
  }
}

class TestJobQueue implements JobQueuePort {
  readonly jobs: Job[] = [];
  readonly attemptedJobs: Job[] = [];

  constructor(private readonly options: { failEnqueue?: boolean } = {}) {}

  async enqueue<TPayload>(job: Job<TPayload>): Promise<JobId> {
    this.attemptedJobs.push(job);

    if (this.options.failEnqueue === true) {
      throw new Error('job enqueue failure');
    }

    this.jobs.push(job);
    return `job_${this.jobs.length}` as JobId;
  }

  onComplete(): void {
    return;
  }
}

class SpyEventPublisher implements EventPublisherPort {
  readonly events: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.events.push(event);
  }
}

const createState = (input?: {
  readonly conversation?: Conversation | null;
  readonly events?: readonly LedgerEvent[];
  readonly contextEventIds?: readonly EventId[];
}): MutableState => {
  return {
    conversation: input?.conversation ?? createTestConversation(),
    events: [...(input?.events ?? [])],
    contextEventIds: [...(input?.contextEventIds ?? [])],
    contextVersion: createContextVersion(0),
  };
};

const createUseCase = (input?: {
  readonly state?: MutableState;
  readonly failContextAppend?: boolean;
  readonly jobQueue?: TestJobQueue;
  readonly eventPublisher?: SpyEventPublisher;
}) => {
  const state = input?.state ?? createState();
  const hashPort = new DeterministicHashPort();

  return {
    state,
    useCase: new AppendLedgerEventsUseCase({
      unitOfWork: new TestUnitOfWork(state, {
        failContextAppend: input?.failContextAppend ?? false,
      }),
      ledgerRead: new TestLedgerRead(state),
      idService: createIdService(hashPort),
      hashPort,
      clock: new DeterministicClock(),
      ...(input?.jobQueue === undefined ? {} : { jobQueue: input.jobQueue }),
      ...(input?.eventPublisher === undefined ? {} : { eventPublisher: input.eventPublisher }),
    }),
  };
};

describe('AppendLedgerEventsUseCase', () => {
  it('appends ordered immutable events and projects them to active context', async () => {
    const { useCase, state } = createUseCase();

    const output = await useCase.execute({
      conversationId,
      events: [
        {
          role: 'user',
          content: 'first message',
          tokenCount: createTokenCount(11),
          metadata: {},
        },
        {
          role: 'assistant',
          content: 'second message',
          tokenCount: createTokenCount(13),
          metadata: {},
        },
      ],
    });

    expect(output.appendedEvents.map((event) => event.sequence)).toEqual([
      createSequenceNumber(1),
      createSequenceNumber(2),
    ]);
    expect(output.contextTokenCount.value).toBe(24);

    expect(state.events).toHaveLength(2);
    expect(state.events[0]).toMatchObject({
      conversationId,
      sequence: createSequenceNumber(1),
      role: 'user',
      content: 'first message',
      tokenCount: createTokenCount(11),
      metadata: {},
    });
    expect(state.events[1]).toMatchObject({
      conversationId,
      sequence: createSequenceNumber(2),
      role: 'assistant',
      content: 'second message',
      tokenCount: createTokenCount(13),
      metadata: {},
    });
    expect(state.contextEventIds).toEqual(state.events.map((event) => event.id));
  });

  it('returns no-op success for same idempotency key with same payload', async () => {
    const { useCase, state } = createUseCase();

    const input: AppendLedgerEventsInput = {
      conversationId,
      idempotencyKey: 'key_repeat',
      events: [
        {
          role: 'user',
          content: 'stable payload',
          tokenCount: createTokenCount(9),
          metadata: {},
        },
      ],
    };

    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(first.appendedEvents).toHaveLength(1);
    expect(second.appendedEvents).toHaveLength(0);
    expect(state.events).toHaveLength(1);
    expect(state.contextEventIds).toHaveLength(1);
  });

  it('throws typed conflict for same idempotency key with different payload', async () => {
    const { useCase, state } = createUseCase();

    await useCase.execute({
      conversationId,
      idempotencyKey: 'shared_key',
      events: [
        {
          role: 'user',
          content: 'payload alpha',
          tokenCount: createTokenCount(10),
          metadata: {},
        },
      ],
    });

    const execution = useCase.execute({
      conversationId,
      idempotencyKey: 'shared_key',
      events: [
        {
          role: 'user',
          content: 'payload beta',
          tokenCount: createTokenCount(9),
          metadata: {},
        },
      ],
    });

    await expect(execution).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(execution).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      conversationId,
      idempotencyKey: 'shared_key',
    });

    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.content).toBe('payload alpha');
    expect(state.contextEventIds).toHaveLength(1);
  });

  it('schedules soft compaction when append crosses soft threshold', async () => {
    const hashPort = new DeterministicHashPort();
    const idService = createIdService(hashPort);

    const existingEvent = createLedgerEvent({
      id: idService.generateEventId({
        content: 'existing',
        conversationId,
        role: 'user',
        sequence: createSequenceNumber(1),
      }),
      conversationId,
      sequence: createSequenceNumber(1),
      role: 'user',
      content: 'existing',
      tokenCount: createTokenCount(40),
      occurredAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
      metadata: {},
    });

    const state = createState({
      conversation: createTestConversation({ contextWindow: 100, softThreshold: 0.6, hardThreshold: 1 }),
      events: [existingEvent],
      contextEventIds: [existingEvent.id],
    });

    const jobQueue = new TestJobQueue();
    const { useCase } = createUseCase({ state, jobQueue });

    await useCase.execute({
      conversationId,
      events: [
        {
          role: 'assistant',
          content: 'cross threshold',
          tokenCount: createTokenCount(25),
          metadata: {},
        },
      ],
    });

    expect(jobQueue.jobs).toHaveLength(1);
    expect(jobQueue.jobs[0]).toMatchObject({
      type: 'run-compaction',
      payload: {
        conversationId,
        trigger: 'soft',
      },
      priority: 'normal',
    });
  });

  it('commits append when soft-compaction enqueue fails', async () => {
    const hashPort = new DeterministicHashPort();
    const idService = createIdService(hashPort);

    const existingEvent = createLedgerEvent({
      id: idService.generateEventId({
        content: 'existing',
        conversationId,
        role: 'user',
        sequence: createSequenceNumber(1),
      }),
      conversationId,
      sequence: createSequenceNumber(1),
      role: 'user',
      content: 'existing',
      tokenCount: createTokenCount(40),
      occurredAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
      metadata: {},
    });

    const state = createState({
      conversation: createTestConversation({ contextWindow: 100, softThreshold: 0.6, hardThreshold: 1 }),
      events: [existingEvent],
      contextEventIds: [existingEvent.id],
    });

    const jobQueue = new TestJobQueue({ failEnqueue: true });
    const { useCase } = createUseCase({ state, jobQueue });

    const output = await useCase.execute({
      conversationId,
      events: [
        {
          role: 'assistant',
          content: 'cross threshold',
          tokenCount: createTokenCount(25),
          metadata: {},
        },
      ],
    });

    await Promise.resolve();

    expect(output.appendedEvents).toHaveLength(1);
    expect(output.contextTokenCount.value).toBe(65);

    expect(state.events).toHaveLength(2);
    expect(state.contextEventIds).toEqual(state.events.map((event) => event.id));

    expect(jobQueue.attemptedJobs).toHaveLength(1);
    expect(jobQueue.jobs).toHaveLength(0);
    expect(jobQueue.attemptedJobs[0]).toMatchObject({
      type: 'run-compaction',
      payload: {
        conversationId,
        trigger: 'soft',
      },
      priority: 'normal',
    });
  });

  it('rolls back ledger mutations when context append fails', async () => {
    const { useCase, state } = createUseCase({
      failContextAppend: true,
    });

    const execution = useCase.execute({
      conversationId,
      events: [
        {
          role: 'user',
          content: 'will rollback',
          tokenCount: createTokenCount(12),
          metadata: {},
        },
      ],
    });

    await expect(execution).rejects.toThrow('context append failure');

    expect(state.events).toHaveLength(0);
    expect(state.contextEventIds).toHaveLength(0);
  });

  it('emits LedgerEventAppended domain events when eventPublisher is provided', async () => {
    const eventPublisher = new SpyEventPublisher();
    const { useCase } = createUseCase({ eventPublisher });

    const output = await useCase.execute({
      conversationId,
      events: [
        {
          role: 'user',
          content: 'first message',
          tokenCount: createTokenCount(10),
          metadata: {},
        },
        {
          role: 'assistant',
          content: 'second message',
          tokenCount: createTokenCount(15),
          metadata: {},
        },
      ],
    });

    expect(eventPublisher.events).toHaveLength(2);

    for (let i = 0; i < output.appendedEvents.length; i++) {
      const event = eventPublisher.events[i];
      const appended = output.appendedEvents[i]!;

      expect(event).toMatchObject({
        type: 'LedgerEventAppended',
        conversationId,
        eventId: appended.id,
        sequence: appended.sequence,
        tokenCount: appended.tokenCount,
      });
    }
  });
});
