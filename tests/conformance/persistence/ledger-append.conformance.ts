import { describe, expect, it } from 'vitest';

import {
  AppendLedgerEventsUseCase,
  IdempotencyConflictError,
} from '@ledgermind/application';
import {
  createEventId,
  createIdService,
  createLedgerEvent,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  NonMonotonicSequenceError,
  type ConversationId,
  type HashPort,
  type MessageRole,
} from '@ledgermind/domain';

import { FixedClock } from '@ledgermind/adapters';

import type { ConformanceAdapterDefinition } from '../run-conformance';

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

const createAppendUseCase = (
  runtime: Awaited<ReturnType<ConformanceAdapterDefinition['createRuntime']>>,
) => {
  return new AppendLedgerEventsUseCase({
    unitOfWork: runtime.unitOfWork,
    ledgerRead: runtime.ledger,
    idService: createIdService(deterministicHashPort),
    hashPort: deterministicHashPort,
    clock: new FixedClock(new Date('2026-03-01T00:00:00.000Z')),
  });
};

const createEvent = (input: {
  readonly conversationId: ConversationId;
  readonly sequence: number;
  readonly content: string;
  readonly role?: MessageRole;
}) => {
  const normalizedContent = input.content
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 32);

  return createLedgerEvent({
    id: createEventId(`evt_conf_append_${input.sequence}_${normalizedContent}`),
    conversationId: input.conversationId,
    sequence: createSequenceNumber(input.sequence),
    role: input.role ?? 'user',
    content: input.content,
    tokenCount: createTokenCount(Math.max(1, input.content.length)),
    occurredAt: createTimestamp(new Date(`2026-03-01T00:00:${String(input.sequence).padStart(2, '0')}.000Z`)),
    metadata: {},
  });
};

export const registerLedgerAppendConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('ledger append contract', () => {
    it('rejects non-monotonic sequence writes', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const first = createEvent({
          conversationId: runtime.defaultConversationId,
          sequence: 1,
          content: 'seed append',
        });
        await runtime.ledger.appendEvents(runtime.defaultConversationId, [first]);

        const invalidGap = createEvent({
          conversationId: runtime.defaultConversationId,
          sequence: 3,
          content: 'sequence gap should fail',
        });

        await expect(runtime.ledger.appendEvents(runtime.defaultConversationId, [invalidGap])).rejects.toBeInstanceOf(
          NonMonotonicSequenceError,
        );

        const events = await runtime.ledger.getEvents(runtime.defaultConversationId);
        expect(events.map((event) => event.sequence)).toEqual([1]);
      } finally {
        await runtime.destroy();
      }
    });

    it('applies idempotency no-op for same payload and conflict for changed payload via append use case', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const appendUseCase = createAppendUseCase(runtime);
        const conversationId = runtime.defaultConversationId;

        const stableInput = {
          conversationId,
          idempotencyKey: 'idem-conformance-key',
          events: [
            {
              role: 'user' as const,
              content: 'idempotent payload alpha',
              tokenCount: createTokenCount(9),
              metadata: {},
            },
          ],
        };

        const first = await appendUseCase.execute(stableInput);
        const second = await appendUseCase.execute(stableInput);

        expect(first.appendedEvents).toHaveLength(1);
        expect(second.appendedEvents).toHaveLength(0);

        const afterNoop = await runtime.ledger.getEvents(conversationId);
        expect(afterNoop).toHaveLength(1);

        await expect(
          appendUseCase.execute({
            conversationId,
            idempotencyKey: 'idem-conformance-key',
            events: [
              {
                role: 'user',
                content: 'idempotent payload beta',
                tokenCount: createTokenCount(9),
                metadata: {},
              },
            ],
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);

        const afterConflict = await runtime.ledger.getEvents(conversationId);
        expect(afterConflict).toHaveLength(1);
        expect(afterConflict[0]?.id).toBe(first.appendedEvents[0]?.id);
      } finally {
        await runtime.destroy();
      }
    });
  });
};
