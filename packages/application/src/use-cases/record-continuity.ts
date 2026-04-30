import { createTokenCount, type EventMetadata, type LedgerEvent } from '@ledgermind/domain';

import {
  ContinuityInputValidationError,
  ContinuityWriteFailedError,
  type ContinuityInputField,
} from '../errors/application-errors';
import type { ClockPort } from '../ports/driven/clock/clock.port';
import type {
  RecordContinuityInput,
  RecordContinuityOutput,
} from '../ports/driving/continuity.port';
import type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
} from '../ports/driving/memory-engine.port';

export interface RecordContinuityUseCaseDeps {
  readonly append: (input: AppendLedgerEventsInput) => Promise<AppendLedgerEventsOutput>;
  readonly clock: ClockPort;
}

const CONTINUITY_SOURCE = 'ledgermind-continuity';

const assertNonBlank = (value: string, field: ContinuityInputField): string => {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new ContinuityInputValidationError(field);
  }

  return trimmed;
};

const countWords = (value: string): number => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
};

const formatContinuityContent = (
  kind: RecordContinuityInput['kind'],
  title: string,
  content: string,
): string => {
  return `[${kind}] ${title}\n\n${content}`;
};

const getRecordEvent = (events: readonly LedgerEvent[]): LedgerEvent | undefined => events[0];

export class RecordContinuityUseCase {
  constructor(private readonly deps: RecordContinuityUseCaseDeps) {}

  async execute(input: RecordContinuityInput): Promise<RecordContinuityOutput> {
    const title = assertNonBlank(input.title, 'title');
    const content = assertNonBlank(input.content, 'content');
    const formattedContent = formatContinuityContent(input.kind, title, content);
    const importance = input.importance ?? 'normal';
    const status = input.status ?? 'active';
    const provenance = input.provenance ?? {};
    const relatedRecordIds = input.relatedRecordIds ?? [];
    const supersedesRecordIds = input.supersedesRecordIds ?? [];
    const supersededByRecordId = input.supersededByRecordId;
    const recordId = input.idempotencyKey ?? `${input.kind}:${title.toLowerCase()}`;
    const occurredAt =
      input.occurredAt ?? (input.idempotencyKey === undefined ? this.deps.clock.now() : undefined);

    const metadata: EventMetadata = {
      source: CONTINUITY_SOURCE,
      kind: 'continuity_record',
      continuityKind: input.kind,
      recordId,
      status,
      importance,
      provenance,
      supersedesRecordIds,
      relatedRecordIds,
      ...(supersededByRecordId === undefined ? {} : { supersededByRecordId }),
    };

    const appendOutput = await this.deps.append({
      conversationId: input.conversationId,
      events: [
        {
          role: 'assistant',
          content: formattedContent,
          tokenCount: createTokenCount(countWords(formattedContent)),
          metadata,
          ...(occurredAt === undefined ? {} : { occurredAt }),
        },
      ],
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });

    const event =
      getRecordEvent(appendOutput.appendedEvents) ??
      getRecordEvent(appendOutput.existingEvents ?? []);
    if (event === undefined) {
      throw new ContinuityWriteFailedError(input.conversationId, recordId);
    }

    return {
      record: {
        recordId,
        conversationId: input.conversationId,
        kind: input.kind,
        status,
        title,
        content,
        importance,
        provenance,
        relatedRecordIds,
        supersedesRecordIds,
        ...(supersededByRecordId === undefined ? {} : { supersededByRecordId }),
        createdAt: event.occurredAt,
        eventId: event.id,
      },
      contextTokenCount: appendOutput.contextTokenCount,
    };
  }
}
