import { describe, expect, it } from 'vitest';

import {
  AppendLedgerEventsUseCase,
  GrepUseCase,
  IdempotencyConflictError,
  RunCompactionUseCase,
  StaleContextVersionError,
  type SummarizationInput,
  type SummarizerPort,
} from '@ledgermind/application';
import type { ConversationId, HashPort } from '@ledgermind/domain';
import {
  createArtifactId,
  createCompactionThresholds,
  createContextItem,
  createConversationConfig,
  createEventId,
  createIdService,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import { FixedClock, SimpleTokenizer } from '@ledgermind/adapters';

import { createPostgresTestHarness } from '../../packages/infrastructure/src/postgres/__tests__/postgres-test-harness';

const createEvent = (
  conversationId: ConversationId,
  sequence: number,
  content: string,
  metadata: Record<string, unknown> = {},
) => {
  return createLedgerEvent({
    id: createEventId(`evt_pg_reg_${sequence}`),
    conversationId,
    sequence: createSequenceNumber(sequence),
    role: 'user',
    content,
    tokenCount: createTokenCount(Math.max(1, content.length)),
    occurredAt: createTimestamp(new Date(`2026-02-05T00:00:${String(sequence).padStart(2, '0')}.000Z`)),
    metadata,
  });
};

const INTEGRITY_CHECK_NAMES = [
  'no_orphan_edges',
  'no_orphan_context_refs',
  'acyclic_dag',
  'leaf_coverage',
  'condensed_coverage',
  'contiguous_positions',
  'monotonic_sequence',
  'artifact_propagation',
] as const;

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

class NonShrinkingSummarizer implements SummarizerPort {
  constructor(private readonly tokenizer: { countTokens(text: string): { value: number } }) {}

  async summarize(input: SummarizationInput) {
    const joined = input.messages.map((message) => message.content).join('\n');
    const content =
      input.mode === 'normal'
        ? `[Summary] ${joined} ${joined}`
        : `[Aggressive Summary] ${joined} ${joined}`;

    return {
      content,
      tokenCount: this.tokenizer.countTokens(content),
      preservedArtifactIds: input.artifactIdsToPreserve,
    };
  }
}

const createRunCompactionUseCase = (input: {
  readonly harness: Awaited<ReturnType<typeof createPostgresTestHarness>>;
  readonly summarizer: SummarizerPort;
}) => {
  const { harness, summarizer } = input;
  const tokenizer = new SimpleTokenizer();

  return new RunCompactionUseCase({
    unitOfWork: harness.unitOfWork,
    ledgerRead: harness.ledger,
    summarizer,
    tokenizer,
    idService: createIdService(deterministicHashPort),
    clock: new FixedClock(new Date('2026-03-01T00:00:00.000Z')),
    config: {
      maxRounds: 1,
      tailWindowSize: 0,
      minBlockSize: 1,
      blockTokenTargetFraction: 1,
      targetFreePercentage: 0.1,
      deterministicFallbackMaxTokens: 512,
    },
  });
};

const createAppendUseCase = (harness: Awaited<ReturnType<typeof createPostgresTestHarness>>) => {
  return new AppendLedgerEventsUseCase({
    unitOfWork: harness.unitOfWork,
    ledgerRead: harness.ledger,
    idService: createIdService(deterministicHashPort),
    hashPort: deterministicHashPort,
    clock: new FixedClock(new Date('2026-03-01T00:00:00.000Z')),
  });
};

describe('regression catalog 8.3 + 8.4 + 8.5 + 8.6 (postgres)', () => {
  it('condensed-node-requires-parent-edges', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, dag } = harness;

      const condensed = createSummaryNode({
        id: createSummaryNodeId('sum_pg_reg_orphan_condensed'),
        conversationId,
        kind: 'condensed',
        content: 'condensed node missing parent edge',
        tokenCount: createTokenCount(9),
        artifactIds: [],
        createdAt: createTimestamp(new Date('2026-02-05T00:05:00.000Z')),
      });

      await dag.createNode(condensed);

      const integrity = await dag.checkIntegrity(conversationId);
      const condensedCoverage = integrity.checks.find((check) => check.name === 'condensed_coverage');

      expect(condensedCoverage).toBeDefined();
      expect(condensedCoverage?.passed).toBe(false);
      expect(integrity.passed).toBe(false);
    } finally {
      await harness.destroy();
    }
  });

  it('artifact-ids-survive-condensation', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, ledger, dag, context } = harness;

      const events = [
        createEvent(conversationId, 1, 'architecture decision with artifact', { artifactIds: ['file_spec_001'] }),
        createEvent(conversationId, 2, 'follow-up implementation detail', { artifactIds: ['file_sql_001'] }),
        createEvent(conversationId, 3, 'latest user clarification'),
      ] as const;

      await ledger.appendEvents(conversationId, events);

      const leaf = createSummaryNode({
        id: createSummaryNodeId('sum_pg_reg_leaf'),
        conversationId,
        kind: 'leaf',
        content: '[Summary] Captured architecture and SQL artifacts.',
        tokenCount: createTokenCount(20),
        artifactIds: [createArtifactId('file_spec_001'), createArtifactId('file_sql_001')],
        createdAt: createTimestamp(new Date('2026-02-05T00:10:00.000Z')),
      });

      const condensed = createSummaryNode({
        id: createSummaryNodeId('sum_pg_reg_condensed'),
        conversationId,
        kind: 'condensed',
        content: '[Aggressive Summary] Recovery checkpoint.',
        tokenCount: createTokenCount(12),
        artifactIds: [createArtifactId('file_spec_001'), createArtifactId('file_sql_001')],
        createdAt: createTimestamp(new Date('2026-02-05T00:20:00.000Z')),
      });

      await dag.createNode(leaf);
      await dag.createNode(condensed);
      await dag.addLeafEdges(
        leaf.id,
        events.map((event) => event.id),
      );
      await dag.addCondensedEdges(condensed.id, [leaf.id]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(events[0].id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(events[1].id),
        }),
        createContextItem({
          conversationId,
          position: 2,
          ref: createMessageContextItemRef(events[2].id),
        }),
      ]);

      const snapshotBefore = await context.getCurrentContext(conversationId);
      expect(snapshotBefore.items.map((item) => item.position)).toEqual([0, 1, 2]);

      await context.replaceContextItems(
        conversationId,
        snapshotBefore.version,
        [0, 1],
        createContextItem({
          conversationId,
          position: 0,
          ref: createSummaryContextItemRef(condensed.id),
        }),
      );

      const snapshotAfter = await context.getCurrentContext(conversationId);
      expect(snapshotAfter.items.map((item) => item.position)).toEqual([0, 1]);
      expect(snapshotAfter.items[0]?.ref.type).toBe('summary');
      expect(snapshotAfter.items[1]?.ref.type).toBe('message');

      const expanded = await dag.expandToMessages(condensed.id);
      expect(expanded.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(expanded.map((event) => event.id)).toEqual(events.map((event) => event.id));

      const integrity = await dag.checkIntegrity(conversationId);
      expect(integrity.passed).toBe(true);
      expect(integrity.checks.map((check) => check.name)).toEqual(INTEGRITY_CHECK_NAMES);
      expect(integrity.checks.every((check) => check.passed)).toBe(true);
    } finally {
      await harness.destroy();
    }
  });

  it('monotonic-seq-under-concurrent-append', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const appendUseCase = createAppendUseCase(harness);
      const firstBatch = [
        {
          role: 'user' as const,
          content: 'concurrent append batch A1',
          tokenCount: createTokenCount(9),
        },
        {
          role: 'assistant' as const,
          content: 'concurrent append batch A2',
          tokenCount: createTokenCount(9),
        },
      ] as const;
      const secondBatch = [
        {
          role: 'user' as const,
          content: 'concurrent append batch B1',
          tokenCount: createTokenCount(9),
        },
        {
          role: 'assistant' as const,
          content: 'concurrent append batch B2',
          tokenCount: createTokenCount(9),
        },
      ] as const;

      await Promise.all([
        appendUseCase.execute({
          conversationId: harness.conversationId,
          events: firstBatch,
        }),
        appendUseCase.execute({
          conversationId: harness.conversationId,
          events: secondBatch,
        }),
      ]);

      const events = await harness.ledger.getEvents(harness.conversationId);
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    } finally {
      await harness.destroy();
    }
  });

  it('parallel-compaction-maintains-dag-integrity', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { context, dag, conversations } = harness;

      const createdConversation = await conversations.create(
        createConversationConfig({
          modelName: 'parallel-compaction-model',
          contextWindow: createTokenCount(320),
          thresholds: createCompactionThresholds(0.6, 1),
        }),
      );

      const appendUseCase = createAppendUseCase(harness);

      const summarizer = new NonShrinkingSummarizer(new SimpleTokenizer());
      const runCompactionUseCase = createRunCompactionUseCase({
        harness,
        summarizer,
      });

      await appendUseCase.execute({
        conversationId: createdConversation.id,
        events: Array.from({ length: 16 }, (_, index) => ({
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `parallel compaction event ${index + 1}`,
          tokenCount: createTokenCount(18),
        })),
      });

      const compactionResults = await Promise.allSettled([
        runCompactionUseCase.execute({
          conversationId: createdConversation.id,
          trigger: 'hard',
        }),
        runCompactionUseCase.execute({
          conversationId: createdConversation.id,
          trigger: 'hard',
        }),
      ]);

      const successCount = compactionResults.filter((result) => result.status === 'fulfilled').length;
      const failureCount = compactionResults.filter((result) => result.status === 'rejected').length;
      expect(successCount + failureCount).toBe(2);
      expect(successCount).toBeGreaterThan(0);

      const integrity = await dag.checkIntegrity(createdConversation.id);
      expect(integrity.passed).toBe(true);
      expect(integrity.checks.every((check) => check.passed)).toBe(true);

      const snapshot = await context.getCurrentContext(createdConversation.id);
      expect(snapshot.items.map((item) => item.position)).toEqual(
        Array.from({ length: snapshot.items.length }, (_, index) => index),
      );
    } finally {
      await harness.destroy();
    }
  });

  it('stale-version-causes-retry-not-corruption', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, ledger, context } = harness;

      const firstEvent = createEvent(conversationId, 1, 'stale version first');
      const secondEvent = createEvent(conversationId, 2, 'stale version second');
      await ledger.appendEvents(conversationId, [firstEvent, secondEvent]);

      await context.appendContextItems(conversationId, [
        createContextItem({
          conversationId,
          position: 0,
          ref: createMessageContextItemRef(firstEvent.id),
        }),
        createContextItem({
          conversationId,
          position: 1,
          ref: createMessageContextItemRef(secondEvent.id),
        }),
      ]);

      const before = await context.getCurrentContext(conversationId);
      const replacement = createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(firstEvent.id),
      });

      const first = context.replaceContextItems(conversationId, before.version, [0], replacement);
      const second = context.replaceContextItems(conversationId, before.version, [0], replacement);

      const [firstResult, secondResult] = await Promise.allSettled([first, second]);

      const fulfilledCount = [firstResult, secondResult].filter(
        (result) => result.status === 'fulfilled',
      ).length;
      const rejected = [firstResult, secondResult].filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      expect(fulfilledCount).toBe(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(StaleContextVersionError);

      const after = await context.getCurrentContext(conversationId);
      expect(after.items.map((item) => item.position)).toEqual(
        Array.from({ length: after.items.length }, (_, index) => index),
      );
    } finally {
      await harness.destroy();
    }
  });

  it('failed-compaction-leaves-no-orphan-edges', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, dag } = harness;

      const appendUseCase = createAppendUseCase(harness);
      const failingSummarizer: SummarizerPort = {
        async summarize(input: SummarizationInput) {
          void input;
          throw new Error('forced summarizer failure');
        },
      };

      const runCompactionUseCase = createRunCompactionUseCase({
        harness,
        summarizer: failingSummarizer,
      });

      await appendUseCase.execute({
        conversationId,
        events: [
          { role: 'system', content: 'system pinned', tokenCount: createTokenCount(8) },
          { role: 'user', content: 'candidate one', tokenCount: createTokenCount(12) },
          { role: 'assistant', content: 'candidate two', tokenCount: createTokenCount(12) },
          { role: 'user', content: 'candidate three', tokenCount: createTokenCount(12) },
          { role: 'assistant', content: 'tail one', tokenCount: createTokenCount(12) },
          { role: 'user', content: 'tail two', tokenCount: createTokenCount(12) },
          { role: 'assistant', content: 'tail three', tokenCount: createTokenCount(12) },
        ],
      });

      await expect(
        runCompactionUseCase.execute({
          conversationId,
          trigger: 'soft',
          targetTokens: createTokenCount(20),
        }),
      ).rejects.toThrow('forced summarizer failure');

      const integrity = await dag.checkIntegrity(conversationId);
      const orphanCheck = integrity.checks.find((check) => check.name === 'no_orphan_edges');

      expect(orphanCheck).toBeDefined();
      expect(orphanCheck?.passed).toBe(true);
      expect(integrity.passed).toBe(true);
    } finally {
      await harness.destroy();
    }
  });

  it('grep-respects-scope-parameter', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { conversationId, ledger, dag } = harness;

      const alphaOne = createEvent(conversationId, 1, 'auth alpha root event');
      const alphaTwo = createEvent(conversationId, 2, 'auth alpha secondary');
      const betaOne = createEvent(conversationId, 3, 'auth beta isolated');

      await ledger.appendEvents(conversationId, [alphaOne, alphaTwo, betaOne]);

      const alphaLeaf = createSummaryNode({
        id: createSummaryNodeId('sum_scope_alpha_leaf'),
        conversationId,
        kind: 'leaf',
        content: 'alpha scoped summary',
        tokenCount: createTokenCount(9),
        artifactIds: [],
        createdAt: createTimestamp(new Date('2026-02-05T02:00:00.000Z')),
      });
      const betaLeaf = createSummaryNode({
        id: createSummaryNodeId('sum_scope_beta_leaf'),
        conversationId,
        kind: 'leaf',
        content: 'beta scoped summary',
        tokenCount: createTokenCount(9),
        artifactIds: [],
        createdAt: createTimestamp(new Date('2026-02-05T02:00:01.000Z')),
      });
      const alphaCondensed = createSummaryNode({
        id: createSummaryNodeId('sum_scope_alpha_condensed'),
        conversationId,
        kind: 'condensed',
        content: 'alpha condensed summary',
        tokenCount: createTokenCount(8),
        artifactIds: [],
        createdAt: createTimestamp(new Date('2026-02-05T02:00:02.000Z')),
      });

      await dag.createNode(alphaLeaf);
      await dag.createNode(betaLeaf);
      await dag.createNode(alphaCondensed);
      await dag.addLeafEdges(alphaLeaf.id, [alphaOne.id, alphaTwo.id]);
      await dag.addLeafEdges(betaLeaf.id, [betaOne.id]);
      await dag.addCondensedEdges(alphaCondensed.id, [alphaLeaf.id]);

      const grepUseCase = new GrepUseCase({
        ledgerRead: ledger,
        summaryDag: dag,
      });

      const scoped = await grepUseCase.execute({
        conversationId,
        pattern: 'auth',
        scope: alphaCondensed.id,
      });

      expect(scoped.matches.map((match) => match.eventId)).toEqual([alphaOne.id, alphaTwo.id]);
      expect(scoped.matches.every((match) => match.coveringSummaryId === alphaCondensed.id)).toBe(true);
    } finally {
      await harness.destroy();
    }
  });

  it('content-hash-stable-for-unicode', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const appendUseCase = createAppendUseCase(harness);
      const eventPayload = {
        role: 'user' as const,
        content: 'Unicode payload: café 👩🏽\u200d💻 Привет こんにちは مرحبا',
        tokenCount: createTokenCount(24),
      };

      const first = await appendUseCase.execute({
        conversationId: harness.conversationId,
        events: [eventPayload],
      });

      const second = await appendUseCase.execute({
        conversationId: harness.conversationId,
        events: [eventPayload],
      });

      const idService = createIdService(deterministicHashPort);
      const expectedFirstId = idService.generateEventId({
        conversationId: harness.conversationId,
        role: eventPayload.role,
        content: eventPayload.content,
        sequence: createSequenceNumber(1),
      });
      const expectedSecondId = idService.generateEventId({
        conversationId: harness.conversationId,
        role: eventPayload.role,
        content: eventPayload.content,
        sequence: createSequenceNumber(2),
      });

      const firstId = first.appendedEvents[0]?.id;
      const secondId = second.appendedEvents[0]?.id;

      expect(firstId).toBe(expectedFirstId);
      expect(secondId).toBe(expectedSecondId);

      const persisted = await harness.ledger.getEvents(harness.conversationId);
      expect(persisted).toHaveLength(2);
      expect(persisted[0]?.id).toBe(expectedFirstId);
      expect(persisted[1]?.id).toBe(expectedSecondId);
    } finally {
      await harness.destroy();
    }
  });

  it('fulltext-search-finds-partial-words', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const { ledger, conversationId } = harness;

      const events = [
        createEvent(conversationId, 1, 'authentication strategy chosen'),
        createEvent(conversationId, 2, 'authorization matrix pending'),
      ] as const;
      await ledger.appendEvents(conversationId, events);

      const matches = await ledger.searchEvents(conversationId, 'authentication');
      expect(matches.map((event) => event.id)).toEqual([events[0].id]);
      expect(matches[0]?.content.toLowerCase()).toContain('authentication');
      const regexMatches = await ledger.regexSearchEvents(conversationId, 'authen');
      expect(regexMatches.map((match) => match.eventId)).toEqual([events[0].id]);
    } finally {
      await harness.destroy();
    }
  });

  it('different-keys-same-content-both-appended', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const appendUseCase = createAppendUseCase(harness);
      const first = await appendUseCase.execute({
        conversationId: harness.conversationId,
        idempotencyKey: 'idem_a',
        events: [
          {
            role: 'user',
            content: 'identical content payload',
            tokenCount: createTokenCount(9),
            metadata: {},
          },
        ],
      });

      const second = await appendUseCase.execute({
        conversationId: harness.conversationId,
        idempotencyKey: 'idem_b',
        events: [
          {
            role: 'user',
            content: 'identical content payload',
            tokenCount: createTokenCount(9),
            metadata: {},
          },
        ],
      });

      expect(first.appendedEvents).toHaveLength(1);
      expect(second.appendedEvents).toHaveLength(1);

      const events = await harness.ledger.getEvents(harness.conversationId);
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    } finally {
      await harness.destroy();
    }
  });

  it('same-key-different-content-rejected', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const appendUseCase = createAppendUseCase(harness);

      await appendUseCase.execute({
        conversationId: harness.conversationId,
        idempotencyKey: 'idem_conflict',
        events: [
          {
            role: 'user',
            content: 'idempotency alpha',
            tokenCount: createTokenCount(8),
            metadata: {},
          },
        ],
      });

      await expect(
        appendUseCase.execute({
          conversationId: harness.conversationId,
          idempotencyKey: 'idem_conflict',
          events: [
            {
              role: 'user',
              content: 'idempotency beta',
              tokenCount: createTokenCount(8),
              metadata: {},
            },
          ],
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);

      const events = await harness.ledger.getEvents(harness.conversationId);
      expect(events).toHaveLength(1);
    } finally {
      await harness.destroy();
    }
  });

  it('duplicate-key-same-content-is-noop', async () => {
    const harness = await createPostgresTestHarness();

    try {
      const appendUseCase = createAppendUseCase(harness);
      const input = {
        conversationId: harness.conversationId,
        idempotencyKey: 'idem_noop',
        events: [
          {
            role: 'user' as const,
            content: 'idempotency stable payload',
            tokenCount: createTokenCount(8),
            metadata: {},
          },
        ],
      };

      const first = await appendUseCase.execute(input);
      const second = await appendUseCase.execute(input);

      expect(first.appendedEvents).toHaveLength(1);
      expect(second.appendedEvents).toHaveLength(0);

      const events = await harness.ledger.getEvents(harness.conversationId);
      expect(events).toHaveLength(1);
    } finally {
      await harness.destroy();
    }
  });
});
