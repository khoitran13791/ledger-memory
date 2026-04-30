import { describe, expect, it } from 'vitest';

import {
  createConversationId,
  createEventId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import type {
  ContinuityRecord,
  RecordContinuityInput,
  RecordContinuityOutput,
} from '../../ports/driving/continuity.port';
import { MarkContinuityRecordUseCase } from '../mark-continuity-record';

const conversationId = createConversationId('conv_mark_continuity_record');
const createdAt = createTimestamp(new Date('2026-04-28T12:30:00.000Z'));

const createRecord = (input: RecordContinuityInput): ContinuityRecord => ({
  recordId: input.idempotencyKey ?? `${input.kind}:${input.title.toLowerCase()}`,
  conversationId: input.conversationId,
  kind: input.kind,
  status: input.status ?? 'active',
  title: input.title.trim(),
  content: input.content.trim(),
  importance: input.importance ?? 'normal',
  provenance: input.provenance ?? {},
  relatedRecordIds: input.relatedRecordIds ?? [],
  supersedesRecordIds: input.supersedesRecordIds ?? [],
  ...(input.supersededByRecordId === undefined
    ? {}
    : { supersededByRecordId: input.supersededByRecordId }),
  createdAt,
  eventId: createEventId('evt_mark_continuity_record_1'),
});

const createUseCase = () => {
  const recordContinuityCalls: RecordContinuityInput[] = [];

  const useCase = new MarkContinuityRecordUseCase({
    recordContinuity: async (input): Promise<RecordContinuityOutput> => {
      recordContinuityCalls.push(input);

      return {
        record: createRecord(input),
        contextTokenCount: createTokenCount(5),
      };
    },
  });

  return { recordContinuityCalls, useCase };
};

describe('MarkContinuityRecordUseCase', () => {
  it('writes a session-summary lifecycle marker for stale records', async () => {
    const { recordContinuityCalls, useCase } = createUseCase();

    const output = await useCase.execute({
      conversationId,
      recordId: 'decision:old-approach',
      status: 'stale',
      reason: 'The implementation moved to a typed projection.',
      idempotencyKey: 'mark:decision:old-approach:stale',
    });

    expect(recordContinuityCalls).toEqual([
      {
        conversationId,
        kind: 'session_summary',
        title: 'Mark decision:old-approach stale',
        content:
          'Record decision:old-approach marked stale: The implementation moved to a typed projection.',
        status: 'stale',
        relatedRecordIds: ['decision:old-approach'],
        supersedesRecordIds: ['decision:old-approach'],
        idempotencyKey: 'mark:decision:old-approach:stale',
      },
    ]);
    expect(output.marker).toMatchObject({
      kind: 'session_summary',
      status: 'stale',
      relatedRecordIds: ['decision:old-approach'],
      supersedesRecordIds: ['decision:old-approach'],
    });
  });

  it('includes supersededByRecordId in marker metadata input', async () => {
    const { recordContinuityCalls, useCase } = createUseCase();

    const output = await useCase.execute({
      conversationId,
      recordId: 'decision:old-storage',
      status: 'superseded',
      reason: 'Ledger projection is the current architecture.',
      supersededByRecordId: 'decision:ledger-projection',
    });

    expect(recordContinuityCalls[0]).toMatchObject({
      supersededByRecordId: 'decision:ledger-projection',
      supersedesRecordIds: ['decision:old-storage'],
    });
    expect(output.marker.supersededByRecordId).toBe('decision:ledger-projection');
  });
});
