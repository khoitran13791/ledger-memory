import {
  createContextItem,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  serializeCanonicalJson,
  type EventMetadata,
  type HashPort,
  type IdService,
  type LedgerEvent,
} from '@ledgermind/domain';

import { ConversationNotFoundError, IdempotencyConflictError } from '../errors/application-errors';
import type { ClockPort } from '../ports/driven/clock/clock.port';
import type { EventPublisherPort } from '../ports/driven/events/event-publisher.port';
import type { JobQueuePort } from '../ports/driven/jobs/job-queue.port';
import type { LedgerReadPort } from '../ports/driven/persistence/ledger-read.port';
import type { UnitOfWorkPort } from '../ports/driven/persistence/unit-of-work.port';
import type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
  NewLedgerEvent,
} from '../ports/driving/memory-engine.port';

const IDEMPOTENCY_KEY_METADATA_FIELD = '__ledgermind_idempotencyKey';
const IDEMPOTENCY_DIGEST_METADATA_FIELD = '__ledgermind_idempotencyDigest';

const textEncoder = new TextEncoder();

type IdempotencyPayload = Readonly<{
  readonly conversationId: AppendLedgerEventsInput['conversationId'];
  readonly events: readonly Readonly<{
    readonly role: NewLedgerEvent['role'];
    readonly content: string;
    readonly tokenCount: number;
    readonly metadata: EventMetadata;
    readonly occurredAt: string | null;
  }>[];
}>;

const createIdempotencyPayload = (input: AppendLedgerEventsInput): IdempotencyPayload => {
  return Object.freeze({
    conversationId: input.conversationId,
    events: input.events.map((event) =>
      Object.freeze({
        role: event.role,
        content: event.content,
        tokenCount: event.tokenCount.value,
        metadata: Object.freeze({ ...(event.metadata ?? {}) }),
        occurredAt: event.occurredAt?.toISOString() ?? null,
      }),
    ),
  });
};

const computeIdempotencyDigest = (hashPort: HashPort, payload: IdempotencyPayload): string => {
  return hashPort.sha256(textEncoder.encode(serializeCanonicalJson(payload)));
};

const getIdempotencyMetadataString = (metadata: EventMetadata, field: string): string | null => {
  const value = metadata[field];
  return typeof value === 'string' ? value : null;
};

const buildPersistedMetadata = (
  metadata: EventMetadata | undefined,
  idempotencyKey: string | undefined,
  idempotencyDigest: string | null,
): EventMetadata => {
  const base = { ...(metadata ?? {}) };

  if (idempotencyKey === undefined || idempotencyDigest === null) {
    return Object.freeze(base);
  }

  return Object.freeze({
    ...base,
    [IDEMPOTENCY_KEY_METADATA_FIELD]: idempotencyKey,
    [IDEMPOTENCY_DIGEST_METADATA_FIELD]: idempotencyDigest,
  });
};

const hasIdempotencyConflict = (
  events: readonly LedgerEvent[],
  idempotencyKey: string,
  expectedDigest: string,
): boolean => {
  const eventsForKey = events.filter((event) => {
    return getIdempotencyMetadataString(event.metadata, IDEMPOTENCY_KEY_METADATA_FIELD) === idempotencyKey;
  });

  if (eventsForKey.length === 0) {
    return false;
  }

  return eventsForKey.some((event) => {
    const digest = getIdempotencyMetadataString(event.metadata, IDEMPOTENCY_DIGEST_METADATA_FIELD);
    return digest !== expectedDigest;
  });
};

const hasIdempotencyMatch = (
  events: readonly LedgerEvent[],
  idempotencyKey: string,
  expectedDigest: string,
): boolean => {
  const eventsForKey = events.filter((event) => {
    return getIdempotencyMetadataString(event.metadata, IDEMPOTENCY_KEY_METADATA_FIELD) === idempotencyKey;
  });

  if (eventsForKey.length === 0) {
    return false;
  }

  return eventsForKey.every((event) => {
    const digest = getIdempotencyMetadataString(event.metadata, IDEMPOTENCY_DIGEST_METADATA_FIELD);
    return digest === expectedDigest;
  });
};

export interface AppendLedgerEventsUseCaseDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly idService: IdService;
  readonly hashPort: HashPort;
  readonly clock: ClockPort;
  readonly jobQueue?: JobQueuePort;
  readonly eventPublisher?: EventPublisherPort;
}

export class AppendLedgerEventsUseCase {
  constructor(private readonly deps: AppendLedgerEventsUseCaseDeps) {}

  async execute(input: AppendLedgerEventsInput): Promise<AppendLedgerEventsOutput> {
    let softCompactionJob:
      | {
          readonly type: 'run-compaction';
          readonly payload: {
            readonly conversationId: AppendLedgerEventsInput['conversationId'];
            readonly trigger: 'soft';
          };
          readonly priority: 'normal';
        }
      | undefined;

    const output = await this.deps.unitOfWork.execute(async (uow) => {
      const conversation = await uow.conversations.get(input.conversationId);
      if (conversation === null) {
        throw new ConversationNotFoundError(input.conversationId);
      }

      if (input.events.length === 0) {
        return {
          appendedEvents: [],
          contextTokenCount: await uow.context.getContextTokenCount(input.conversationId),
        };
      }

      const existingEvents = await this.deps.ledgerRead.getEvents(input.conversationId);

      const idempotencyDigest =
        input.idempotencyKey === undefined
          ? null
          : computeIdempotencyDigest(this.deps.hashPort, createIdempotencyPayload(input));

      if (input.idempotencyKey !== undefined && idempotencyDigest !== null) {
        if (hasIdempotencyConflict(existingEvents, input.idempotencyKey, idempotencyDigest)) {
          throw new IdempotencyConflictError(input.conversationId, input.idempotencyKey);
        }

        if (hasIdempotencyMatch(existingEvents, input.idempotencyKey, idempotencyDigest)) {
          return {
            appendedEvents: [],
            contextTokenCount: await uow.context.getContextTokenCount(input.conversationId),
          };
        }
      }

      const preAppendTokenCount = await uow.context.getContextTokenCount(input.conversationId);
      const baseSequence = await uow.ledger.getNextSequence(input.conversationId);

      const appendedEvents = input.events.map((event, index) => {
        const sequence = createSequenceNumber(baseSequence + index);

        return createLedgerEvent({
          id: this.deps.idService.generateEventId({
            content: event.content,
            conversationId: input.conversationId,
            role: event.role,
            sequence,
          }),
          conversationId: input.conversationId,
          sequence,
          role: event.role,
          content: event.content,
          tokenCount: event.tokenCount,
          occurredAt: event.occurredAt ?? this.deps.clock.now(),
          metadata: buildPersistedMetadata(event.metadata, input.idempotencyKey, idempotencyDigest),
        });
      });

      await uow.ledger.appendEvents(input.conversationId, appendedEvents);

      await uow.context.appendContextItems(
        input.conversationId,
        appendedEvents.map((event, position) =>
          createContextItem({
            conversationId: input.conversationId,
            position,
            ref: createMessageContextItemRef(event.id),
          }),
        ),
      );

      const contextTokenCount = await uow.context.getContextTokenCount(input.conversationId);

      if (this.deps.jobQueue !== undefined) {
        const softThreshold = Math.floor(
          conversation.config.contextWindow.value * conversation.config.thresholds.soft,
        );

        const crossedSoftThreshold =
          preAppendTokenCount.value <= softThreshold && contextTokenCount.value > softThreshold;

        if (crossedSoftThreshold) {
          softCompactionJob = {
            type: 'run-compaction',
            payload: {
              conversationId: input.conversationId,
              trigger: 'soft',
            },
            priority: 'normal',
          };
        }
      }

      return {
        appendedEvents,
        contextTokenCount,
      };
    });

    if (softCompactionJob !== undefined && this.deps.jobQueue !== undefined) {
      void this.deps.jobQueue.enqueue(softCompactionJob).catch(() => undefined);
    }

    if (output.appendedEvents.length > 0 && this.deps.eventPublisher) {
      for (const event of output.appendedEvents) {
        this.deps.eventPublisher.publish({
          type: 'LedgerEventAppended',
          conversationId: input.conversationId,
          eventId: event.id,
          sequence: event.sequence,
          tokenCount: event.tokenCount,
        });
      }
    }

    return output;
  }
}
