import { describe, expect, it } from 'vitest';

import {
  createConversationId,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  type ConversationId,
  type EventMetadata,
  type LedgerEvent,
} from '@ledgermind/domain';

import type { LedgerReadPort } from '../../ports/driven/persistence/ledger-read.port';
import { GetCurrentStateUseCase, parseContinuityRecordFromEvent } from '../get-current-state';

const conversationId = createConversationId('conv_get_current_state');

class FakeLedgerRead implements LedgerReadPort {
  constructor(private readonly events: readonly LedgerEvent[]) {}

  async getEvents(requestedConversationId: ConversationId) {
    expect(requestedConversationId).toBe(conversationId);
    return this.events;
  }

  async searchEvents() {
    return [];
  }

  async regexSearchEvents() {
    return {
      matches: [],
      totalMatchCount: 0,
    };
  }
}

const event = (sequence: number, content: string, metadata: EventMetadata = {}): LedgerEvent =>
  createLedgerEvent({
    id: createEventId(`evt_state_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'assistant',
    content,
    tokenCount: createTokenCount(1),
    occurredAt: createTimestamp(new Date('2026-04-28T10:00:00.000Z')),
    metadata,
  });

const continuityEvent = (
  sequence: number,
  kind: string,
  recordId: string,
  title: string,
  content: string,
  metadata: Partial<EventMetadata> = {},
): LedgerEvent =>
  event(sequence, `[${kind}] ${title}\n\n${content}`, {
    source: 'ledgermind-continuity',
    kind: 'continuity_record',
    continuityKind: kind,
    recordId,
    status: 'active',
    importance: 'normal',
    provenance: {},
    relatedRecordIds: [],
    supersedesRecordIds: [],
    ...metadata,
  });

describe('parseContinuityRecordFromEvent', () => {
  it('returns null for non-continuity events', () => {
    expect(parseContinuityRecordFromEvent(event(1, 'ordinary assistant text'))).toBeNull();
  });

  it('returns null for malformed continuity metadata instead of unsafe casts', () => {
    const malformed = event(1, '[decision] Broken\n\nBad metadata', {
      kind: 'continuity_record',
      continuityKind: 'surprise',
      recordId: 42,
      status: 'active',
      importance: 'normal',
    });

    expect(parseContinuityRecordFromEvent(malformed)).toBeNull();
  });

  it('parses deterministic record content and falls back for older content', () => {
    const parsed = parseContinuityRecordFromEvent(
      continuityEvent(1, 'decision', 'decision:parser', 'Use projection', 'Read ledger events.'),
    );

    expect(parsed).toMatchObject({
      recordId: 'decision:parser',
      kind: 'decision',
      status: 'active',
      title: 'Use projection',
      content: 'Read ledger events.',
    });

    const fallback = parseContinuityRecordFromEvent(
      event(2, 'Legacy constraint body without deterministic title prefix.', {
        source: 'ledgermind-continuity',
        kind: 'continuity_record',
        continuityKind: 'constraint',
        recordId: 'constraint:legacy',
        status: 'active',
        importance: 'normal',
        provenance: {},
        relatedRecordIds: [],
        supersedesRecordIds: [],
      }),
    );

    expect(fallback).toMatchObject({
      title: 'Legacy constraint body without deterministic title prefix.',
      content: 'Legacy constraint body without deterministic title prefix.',
    });
  });
});

describe('GetCurrentStateUseCase', () => {
  const events = [
    event(1, 'plain event before continuity'),
    continuityEvent(
      2,
      'decision',
      'decision:old-storage',
      'Use old storage',
      'Superseded decision.',
    ),
    continuityEvent(3, 'progress', 'progress:old-setup', 'Finished setup', 'This is stale now.'),
    continuityEvent(
      4,
      'decision',
      'decision:new-storage',
      'Use ledger projection',
      'Project current state from events.',
      {
        importance: 'high',
        supersedesRecordIds: ['decision:old-storage'],
      },
    ),
    continuityEvent(
      5,
      'constraint',
      'constraint:clean-architecture',
      'Respect Clean Architecture',
      'Application reads through ports.',
    ),
    continuityEvent(
      6,
      'progress',
      'progress:tests-written',
      'Wrote current-state tests',
      'RED coverage exists.',
    ),
    continuityEvent(
      7,
      'next_step',
      'next:write-implementation',
      'Implement use case',
      'Create projection use case.',
    ),
    continuityEvent(8, 'next_step', 'next:wire-sdk', 'Wire SDK', 'Replace temporary stub.'),
    continuityEvent(9, 'handoff', 'handoff:last', 'Task 3 handoff', 'Continue from projection.'),
    continuityEvent(
      10,
      'progress',
      'marker:stale-old-setup',
      'Mark old setup stale',
      'The setup note is no longer current.',
      {
        status: 'stale',
        relatedRecordIds: ['progress:old-setup'],
      },
    ),
    continuityEvent(
      11,
      'decision',
      'marker:supersede-old-storage',
      'Supersede old storage',
      'The ledger projection decision replaces it.',
      {
        status: 'superseded',
        relatedRecordIds: ['decision:old-storage'],
      },
    ),
    continuityEvent(
      12,
      'open_question',
      'question:resolved-api',
      'Clarify API',
      'This question has been answered.',
    ),
    continuityEvent(
      13,
      'open_question',
      'marker:resolved-api',
      'Resolve API question',
      'The API shape is settled.',
      {
        status: 'resolved',
        relatedRecordIds: ['question:resolved-api'],
      },
    ),
  ] as const;

  it('projects active current state and applies lifecycle markers by default', async () => {
    const useCase = new GetCurrentStateUseCase({ ledgerRead: new FakeLedgerRead(events) });

    const state = await useCase.execute({ conversationId });

    expect(state.decisions.map((record) => record.recordId)).toEqual(['decision:new-storage']);
    expect(state.constraints.map((record) => record.recordId)).toEqual([
      'constraint:clean-architecture',
    ]);
    expect(state.progress.map((record) => record.recordId)).toEqual(['progress:tests-written']);
    expect(state.nextSteps.map((record) => record.recordId)).toEqual([
      'next:write-implementation',
      'next:wire-sdk',
    ]);
    expect(state.handoffs.map((record) => record.recordId)).toEqual(['handoff:last']);
    expect(state.openQuestions).toEqual([]);
    expect(state.activeRecordCount).toBe(6);
    expect(state.staleRecordCount).toBe(6);
  });

  it('allows a current record to reappear after an older record with the same id is marked stale', async () => {
    const lifecycleEvents = [
      continuityEvent(20, 'next_step', 'next:reuse-id', 'Call old API', 'Use the legacy path.'),
      continuityEvent(
        21,
        'progress',
        'marker:stale-reuse-id',
        'Mark old next step stale',
        'The old API path is no longer needed.',
        {
          status: 'stale',
          relatedRecordIds: ['next:reuse-id'],
        },
      ),
      continuityEvent(22, 'next_step', 'next:reuse-id', 'Call new API', 'Use the current path.'),
    ] as const;
    const useCase = new GetCurrentStateUseCase({
      ledgerRead: new FakeLedgerRead(lifecycleEvents),
    });

    const state = await useCase.execute({ conversationId });

    expect(state.nextSteps).toHaveLength(1);
    expect(state.nextSteps[0]).toMatchObject({
      recordId: 'next:reuse-id',
      title: 'Call new API',
      content: 'Use the current path.',
    });
    expect(state.activeRecordCount).toBe(1);
    expect(state.staleRecordCount).toBe(2);
  });

  it('includes inactive target records when includeStale is true', async () => {
    const useCase = new GetCurrentStateUseCase({ ledgerRead: new FakeLedgerRead(events) });

    const state = await useCase.execute({ conversationId, includeStale: true });

    expect(state.decisions.map((record) => record.recordId)).toEqual([
      'marker:supersede-old-storage',
      'decision:new-storage',
      'decision:old-storage',
    ]);
    expect(state.progress.map((record) => record.recordId)).toEqual([
      'marker:stale-old-setup',
      'progress:tests-written',
      'progress:old-setup',
    ]);
    expect(state.openQuestions.map((record) => record.recordId)).toEqual([
      'marker:resolved-api',
      'question:resolved-api',
    ]);
  });

  it('sorts newest first except next steps oldest first and caps each bucket', async () => {
    const useCase = new GetCurrentStateUseCase({ ledgerRead: new FakeLedgerRead(events) });

    const state = await useCase.execute({ conversationId, includeStale: true, limitPerKind: 1 });

    expect(state.decisions.map((record) => record.recordId)).toEqual([
      'marker:supersede-old-storage',
    ]);
    expect(state.progress.map((record) => record.recordId)).toEqual(['marker:stale-old-setup']);
    expect(state.nextSteps.map((record) => record.recordId)).toEqual(['next:write-implementation']);
  });
});
