import { describe, expect, it } from 'vitest';

import {
  createConversationId,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import type { ClockPort } from '../../ports/driven/clock/clock.port';
import type {
  AppendLedgerEventsInput,
  AppendLedgerEventsOutput,
} from '../../ports/driving/memory-engine.port';
import {
  ContinuityInputValidationError,
  ContinuityWriteFailedError,
} from '../../errors/application-errors';
import { RecordContinuityUseCase } from '../record-continuity';

const conversationId = createConversationId('conv_record_continuity');
const now = createTimestamp(new Date('2026-04-28T10:00:00.000Z'));

class FixedClock implements ClockPort {
  now() {
    return now;
  }
}

const createUseCase = (
  append?: (input: AppendLedgerEventsInput) => Promise<AppendLedgerEventsOutput>,
) => {
  const appendCalls: AppendLedgerEventsInput[] = [];

  const useCase = new RecordContinuityUseCase({
    append: async (input) => {
      appendCalls.push(input);

      if (append !== undefined) {
        return append(input);
      }

      const [event] = input.events;
      if (event === undefined) {
        throw new Error('Expected recordContinuity to append one event.');
      }

      return {
        appendedEvents: [
          createLedgerEvent({
            id: createEventId('evt_record_continuity_1'),
            conversationId: input.conversationId,
            sequence: createSequenceNumber(1),
            role: event.role,
            content: event.content,
            tokenCount: event.tokenCount,
            ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
            ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
          }),
        ],
        contextTokenCount: createTokenCount(7),
      };
    },
    clock: new FixedClock(),
  });

  return { appendCalls, useCase };
};

describe('RecordContinuityUseCase', () => {
  it('rejects blank title', async () => {
    const { appendCalls, useCase } = createUseCase();

    const promise = useCase.execute({
      conversationId,
      kind: 'decision',
      title: '   ',
      content: 'Keep the append pipeline.',
    });

    await expect(promise).rejects.toBeInstanceOf(ContinuityInputValidationError);
    await expect(promise).rejects.toMatchObject({
      code: 'CONTINUITY_INPUT_INVALID',
      field: 'title',
    });
    await expect(promise).rejects.toThrow('title is required');

    expect(appendCalls).toHaveLength(0);
  });

  it('rejects blank content', async () => {
    const { appendCalls, useCase } = createUseCase();

    const promise = useCase.execute({
      conversationId,
      kind: 'decision',
      title: 'Keep the append pipeline',
      content: '\n\t',
    });

    await expect(promise).rejects.toBeInstanceOf(ContinuityInputValidationError);
    await expect(promise).rejects.toMatchObject({
      code: 'CONTINUITY_INPUT_INVALID',
      field: 'content',
    });
    await expect(promise).rejects.toThrow('content is required');

    expect(appendCalls).toHaveLength(0);
  });

  it('defaults importance and status while appending one deterministic continuity event', async () => {
    const { appendCalls, useCase } = createUseCase();

    const output = await useCase.execute({
      conversationId,
      kind: 'decision',
      title: 'Do not add new npm dependencies',
      content: 'We decided to avoid new npm dependencies for this utility work.',
    });

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toMatchObject({
      conversationId,
      events: [
        {
          role: 'assistant',
          content:
            '[decision] Do not add new npm dependencies\n\nWe decided to avoid new npm dependencies for this utility work.',
          tokenCount: createTokenCount(18),
          occurredAt: now,
          metadata: {
            source: 'ledgermind-continuity',
            kind: 'continuity_record',
            continuityKind: 'decision',
            recordId: 'decision:do not add new npm dependencies',
            status: 'active',
            importance: 'normal',
            provenance: {},
            supersedesRecordIds: [],
            relatedRecordIds: [],
          },
        },
      ],
    });
    expect(appendCalls[0]?.idempotencyKey).toBeUndefined();
    expect(output).toEqual({
      record: {
        recordId: 'decision:do not add new npm dependencies',
        conversationId,
        kind: 'decision',
        status: 'active',
        title: 'Do not add new npm dependencies',
        content: 'We decided to avoid new npm dependencies for this utility work.',
        importance: 'normal',
        provenance: {},
        relatedRecordIds: [],
        supersedesRecordIds: [],
        createdAt: now,
        eventId: createEventId('evt_record_continuity_1'),
      },
      contextTokenCount: createTokenCount(7),
    });
  });

  it('fails when append does not return the persisted continuity event', async () => {
    const { useCase } = createUseCase(async () => ({
      appendedEvents: [],
      contextTokenCount: createTokenCount(0),
    }));

    const promise = useCase.execute({
      conversationId,
      kind: 'decision',
      title: 'Keep real persisted event ids',
      content: 'A continuity record must point at the event that append actually stored.',
    });

    await expect(promise).rejects.toBeInstanceOf(ContinuityWriteFailedError);
    await expect(promise).rejects.toMatchObject({
      code: 'CONTINUITY_WRITE_FAILED',
      conversationId,
      recordId: 'decision:keep real persisted event ids',
    });
  });

  it('returns the existing continuity record for idempotent replays', async () => {
    const persistedEvent = createLedgerEvent({
      id: createEventId('evt_record_continuity_replay'),
      conversationId,
      sequence: createSequenceNumber(3),
      role: 'assistant',
      content: '[decision] Keep stable keys\n\nReplay continuity writes must be no-op successes.',
      tokenCount: createTokenCount(9),
      occurredAt: now,
      metadata: {
        source: 'ledgermind-continuity',
        kind: 'continuity_record',
        continuityKind: 'decision',
        recordId: 'continuity-key-replay',
        status: 'active',
        importance: 'normal',
        provenance: {},
        supersedesRecordIds: [],
        relatedRecordIds: [],
      },
    });
    const { useCase } = createUseCase(async () => ({
      appendedEvents: [],
      contextTokenCount: createTokenCount(9),
      existingEvents: [persistedEvent],
    }));

    await expect(
      useCase.execute({
        conversationId,
        kind: 'decision',
        title: 'Keep stable keys',
        content: 'Replay continuity writes must be no-op successes.',
        idempotencyKey: 'continuity-key-replay',
      }),
    ).resolves.toEqual({
      record: {
        recordId: 'continuity-key-replay',
        conversationId,
        kind: 'decision',
        status: 'active',
        title: 'Keep stable keys',
        content: 'Replay continuity writes must be no-op successes.',
        importance: 'normal',
        provenance: {},
        relatedRecordIds: [],
        supersedesRecordIds: [],
        createdAt: now,
        eventId: createEventId('evt_record_continuity_replay'),
      },
      contextTokenCount: createTokenCount(9),
    });
  });

  it('preserves metadata references and uses the supplied idempotency key', async () => {
    const { appendCalls, useCase } = createUseCase();

    await useCase.execute({
      conversationId,
      kind: 'constraint',
      title: 'No raw SQL in application',
      content: 'Application use cases must call ports instead of infrastructure.',
      importance: 'high',
      status: 'active',
      provenance: {
        eventIds: [createEventId('evt_source_1')],
        summaryIds: [createSummaryNodeId('sum_source_1')],
        transcriptPath: '/tmp/transcript.jsonl',
        transcriptLineStart: 12,
        transcriptLineEnd: 18,
        toolUseId: 'toolu_123',
        command: 'pnpm typecheck',
      },
      supersedesRecordIds: ['constraint:old-sql-rule'],
      relatedRecordIds: ['decision:clean-architecture'],
      idempotencyKey: 'continuity-key-123',
    });

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.idempotencyKey).toBe('continuity-key-123');
    expect(appendCalls[0]?.events).toHaveLength(1);
    expect(appendCalls[0]?.events[0]?.occurredAt).toBeUndefined();
    expect(appendCalls[0]?.events[0]?.metadata).toEqual({
      source: 'ledgermind-continuity',
      kind: 'continuity_record',
      continuityKind: 'constraint',
      recordId: 'continuity-key-123',
      status: 'active',
      importance: 'high',
      provenance: {
        eventIds: [createEventId('evt_source_1')],
        summaryIds: [createSummaryNodeId('sum_source_1')],
        transcriptPath: '/tmp/transcript.jsonl',
        transcriptLineStart: 12,
        transcriptLineEnd: 18,
        toolUseId: 'toolu_123',
        command: 'pnpm typecheck',
      },
      supersedesRecordIds: ['constraint:old-sql-rule'],
      relatedRecordIds: ['decision:clean-architecture'],
    });
  });
});
