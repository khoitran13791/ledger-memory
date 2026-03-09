import { describe, expect, it } from 'vitest';

import { InvariantViolationError, NonMonotonicSequenceError } from '../../errors/domain-errors';
import { createConversationId, createEventId, createSequenceNumber } from '../../value-objects/ids';
import { createTokenCount } from '../../value-objects/token-count';
import { createLedgerEvent } from '../ledger-event';

describe('ledger event entity', () => {
  it('creates immutable ledger event for valid input', () => {
    const event = createLedgerEvent({
      id: createEventId('evt_1'),
      conversationId: createConversationId('conv_1'),
      sequence: createSequenceNumber(1),
      role: 'user',
      content: 'hello',
      tokenCount: createTokenCount(5),
      metadata: { requestId: 'req_1' },
    });

    expect(event.id).toBe('evt_1');
    expect(event.sequence).toBe(1);
    expect(event.role).toBe('user');
    expect(event.tokenCount.value).toBe(5);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
  });

  it('rejects non-positive sequence', () => {
    expect(() =>
      createLedgerEvent({
        id: createEventId('evt_1'),
        conversationId: createConversationId('conv_1'),
        sequence: 0 as ReturnType<typeof createSequenceNumber>,
        role: 'assistant',
        content: 'ok',
        tokenCount: createTokenCount(1),
      }),
    ).toThrow(NonMonotonicSequenceError);
  });

  it('rejects invalid role', () => {
    expect(() =>
      createLedgerEvent({
        id: createEventId('evt_2'),
        conversationId: createConversationId('conv_1'),
        sequence: createSequenceNumber(1),
        role: 'invalid' as 'user',
        content: 'hello',
        tokenCount: createTokenCount(1),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects invalid token count payload', () => {
    expect(() =>
      createLedgerEvent({
        id: createEventId('evt_2'),
        conversationId: createConversationId('conv_1'),
        sequence: createSequenceNumber(1),
        role: 'tool',
        content: 'result',
        tokenCount: { value: -1 },
      }),
    ).toThrow(InvariantViolationError);
  });
});
