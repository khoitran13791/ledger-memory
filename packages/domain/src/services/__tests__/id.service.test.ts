import { describe, expect, it } from 'vitest';

import { createLedgerEvent } from '../../entities/ledger-event';
import { InvariantViolationError } from '../../errors/domain-errors';
import {
  createConversationId,
  createEventId,
  createSequenceNumber,
  type ConversationId,
  type SequenceNumber,
} from '../../value-objects/ids';
import type { MessageRole } from '../../value-objects/message-role';
import { createTimestamp } from '../../value-objects/timestamp';
import { createTokenCount } from '../../value-objects/token-count';
import { createIdService, serializeCanonicalJson, type HashPort } from '../id.service';

type EventIdInput = {
  readonly content: string;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly sequence: SequenceNumber;
};

const deterministicHashPort: HashPort = {
  sha256: (input) => {
    let acc = 2166136261;

    for (const byte of input) {
      acc ^= byte;
      acc = Math.imul(acc, 16777619) >>> 0;
    }

    return acc.toString(16).padStart(8, '0').repeat(8);
  },
};

describe('id service', () => {
  it('generates deterministic event IDs for repeated identical input', () => {
    const service = createIdService(deterministicHashPort);
    const input = {
      content: 'hello world',
      conversationId: createConversationId('conv_1'),
      role: 'assistant' as const,
      sequence: createSequenceNumber(1),
    };

    const first = service.generateEventId(input);
    const second = service.generateEventId(input);

    expect(first).toBe(second);
    expect(first.startsWith('evt_')).toBe(true);
  });

  it('keeps event ID stable when excluded ledger-event fields change', () => {
    const service = createIdService(deterministicHashPort);
    const conversationId = createConversationId('conv_2');
    const sequence = createSequenceNumber(7);

    const eventA = createLedgerEvent({
      id: createEventId('evt_a'),
      conversationId,
      sequence,
      role: 'user',
      content: 'same content',
      tokenCount: createTokenCount(5),
      occurredAt: createTimestamp(new Date('2026-02-27T00:00:00.000Z')),
      metadata: { requestId: 'req_a' },
    });

    const eventB = createLedgerEvent({
      id: createEventId('evt_b'),
      conversationId,
      sequence,
      role: 'user',
      content: 'same content',
      tokenCount: createTokenCount(5),
      occurredAt: createTimestamp(new Date('2026-02-28T00:00:00.000Z')),
      metadata: { requestId: 'req_b', source: 'test' },
    });

    const idA = service.generateEventId({
      content: eventA.content,
      conversationId: eventA.conversationId,
      role: eventA.role,
      sequence: eventA.sequence,
    });
    const idB = service.generateEventId({
      content: eventB.content,
      conversationId: eventB.conversationId,
      role: eventB.role,
      sequence: eventB.sequence,
    });

    expect(idA).toBe(idB);
  });

  const eventIdVarianceCases: readonly [string, EventIdInput, EventIdInput][] = [
    [
      'conversation changes',
      {
        content: 'hash me',
        conversationId: createConversationId('conv_3'),
        role: 'user',
        sequence: createSequenceNumber(1),
      },
      {
        content: 'hash me',
        conversationId: createConversationId('conv_4'),
        role: 'user',
        sequence: createSequenceNumber(1),
      },
    ],
    [
      'content changes',
      {
        content: 'hash me',
        conversationId: createConversationId('conv_3'),
        role: 'user',
        sequence: createSequenceNumber(1),
      },
      {
        content: 'hash me differently',
        conversationId: createConversationId('conv_3'),
        role: 'user',
        sequence: createSequenceNumber(1),
      },
    ],
    [
      'role changes',
      {
        content: 'hash me',
        conversationId: createConversationId('conv_3'),
        role: 'user',
        sequence: createSequenceNumber(1),
      },
      {
        content: 'hash me',
        conversationId: createConversationId('conv_3'),
        role: 'assistant',
        sequence: createSequenceNumber(1),
      },
    ],
    [
      'sequence changes',
      {
        content: 'hash me',
        conversationId: createConversationId('conv_3'),
        role: 'user',
        sequence: createSequenceNumber(1),
      },
      {
        content: 'hash me',
        conversationId: createConversationId('conv_3'),
        role: 'user',
        sequence: createSequenceNumber(2),
      },
    ],
  ];

  it.each(eventIdVarianceCases)('changes event IDs when hashed %s', (_, left, right) => {
    const service = createIdService(deterministicHashPort);

    expect(service.generateEventId(left)).not.toBe(service.generateEventId(right));
  });

  it('changes summary IDs by summary kind and normalizes artifact content hash casing', () => {
    const service = createIdService(deterministicHashPort);
    const conversationId = createConversationId('conv_3');

    const leafSummaryId = service.generateSummaryId({
      content: 'summary payload',
      conversationId,
      kind: 'leaf',
    });
    const condensedSummaryId = service.generateSummaryId({
      content: 'summary payload',
      conversationId,
      kind: 'condensed',
    });

    const artifactLower = service.generateArtifactId({
      contentHashHex: 'a1b2c3',
    });
    const artifactUpper = service.generateArtifactId({
      contentHashHex: 'A1B2C3',
    });

    expect(leafSummaryId).not.toBe(condensedSummaryId);
    expect(artifactLower).toBe(artifactUpper);
  });

  it('serializes canonical JSON deterministically with Unicode and sorted keys', () => {
    const payloadA = {
      z: 3,
      message: 'xin chào 👋',
      nested: { b: 2, a: 1 },
      ignored: undefined,
    };
    const payloadB = {
      nested: { a: 1, b: 2 },
      message: 'xin chào 👋',
      z: 3,
    };

    const canonicalA = serializeCanonicalJson(payloadA);
    const canonicalB = serializeCanonicalJson(payloadB);

    expect(canonicalA).toBe(canonicalB);
    expect(canonicalA).toBe('{"message":"xin chào 👋","nested":{"a":1,"b":2},"z":3}');
  });

  it('rejects invalid hash output from HashPort', () => {
    const service = createIdService({
      sha256: () => 'not-hex',
    });

    expect(() =>
      service.generateSummaryId({
        content: 'summary',
        conversationId: createConversationId('conv_4'),
        kind: 'leaf',
      }),
    ).toThrow(InvariantViolationError);
  });
});
