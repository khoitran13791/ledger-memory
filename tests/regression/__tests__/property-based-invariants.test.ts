import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AppendLedgerEventsUseCase,
  CheckIntegrityUseCase,
  MaterializeContextUseCase,
  RunCompactionUseCase,
  StaleContextVersionError,
} from '@ledgermind/application';
import {
  createInMemoryPersistenceState,
  InMemoryArtifactStore,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversationConfig,
  createEventId,
  createIdService,
  createTokenBudgetService,
  createTokenCount,
  type ConversationId,
  type HashPort,
  type MessageRole,
} from '@ledgermind/domain';

import { createDeterministicTestDeps } from '../../shared/stubs';

type EventFixture = {
  readonly role: MessageRole;
  readonly content: string;
};

type ConversationFixture = {
  readonly contextWindow: number;
  readonly softThreshold: number;
  readonly hardThreshold: number;
};

type BudgetFixture = {
  readonly budgetTokens: number;
  readonly overheadTokens: number;
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

const eventArbitrary = fc.record({
  role: fc.constantFrom<MessageRole>('user', 'assistant', 'tool'),
  content: fc
    .string({ minLength: 1, maxLength: 240 })
    .filter((value) => value.trim().length > 0),
});

const conversationArbitrary: fc.Arbitrary<ConversationFixture> = fc
  .tuple(
    fc.integer({ min: 320, max: 960 }),
    fc.integer({ min: 40, max: 85 }),
    fc.integer({ min: 86, max: 100 }),
  )
  .map(([contextWindow, softBasis, hardBasis]) => ({
    contextWindow,
    softThreshold: softBasis / 100,
    hardThreshold: hardBasis / 100,
  }));

const budgetArbitrary: fc.Arbitrary<BudgetFixture> = fc.record({
  budgetTokens: fc.integer({ min: 320, max: 960 }),
  overheadTokens: fc.integer({ min: 0, max: 120 }),
});

const ensureDistinctByContent = (events: readonly EventFixture[]): readonly EventFixture[] => {
  const seen = new Set<string>();
  const unique: EventFixture[] = [];

  for (const event of events) {
    const key = `${event.role}|${event.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(event);
    }
  }

  return unique;
};

const sanitizeConversation = (fixture: ConversationFixture): ConversationFixture => {
  const softThreshold = Math.min(fixture.softThreshold, fixture.hardThreshold - 0.05);
  const hardThreshold = Math.max(fixture.hardThreshold, softThreshold + 0.05);

  return {
    contextWindow: fixture.contextWindow,
    softThreshold,
    hardThreshold: Math.min(hardThreshold, 1),
  };
};

const sanitizeBudget = (fixture: BudgetFixture): BudgetFixture => {
  const overheadTokens = Math.min(fixture.overheadTokens, fixture.budgetTokens - 1);

  return {
    budgetTokens: fixture.budgetTokens,
    overheadTokens: Math.max(0, overheadTokens),
  };
};

interface Runtime {
  readonly appendUseCase: AppendLedgerEventsUseCase;
  readonly runCompactionUseCase: RunCompactionUseCase;
  readonly materializeUseCase: MaterializeContextUseCase;
  readonly checkIntegrityUseCase: CheckIntegrityUseCase;
  readonly ledgerRead: InMemoryLedgerStore;
  readonly contextProjection: InMemoryContextProjection;
  readonly conversationId: ConversationId;
}

const createRuntime = async (fixture: ConversationFixture): Promise<Runtime> => {
  const state = createInMemoryPersistenceState();

  const unitOfWork = new InMemoryUnitOfWork(state);
  const ledgerRead = new InMemoryLedgerStore(state);
  const contextProjection = new InMemoryContextProjection(state);
  const summaryDag = new InMemorySummaryDag(state);
  const artifactStore = new InMemoryArtifactStore(state);
  const conversations = new InMemoryConversationStore(state);

  const deterministicDeps = createDeterministicTestDeps({
    fixedDate: new Date('2026-03-01T00:00:00.000Z'),
  });
  const tokenizer = deterministicDeps.tokenizer;
  const summarizer = deterministicDeps.summarizer;
  const clock = deterministicDeps.clock;
  const idService = createIdService(deterministicHashPort);

  const conversationConfig = createConversationConfig({
    modelName: 'property-test-model',
    contextWindow: createTokenCount(fixture.contextWindow),
    thresholds: createCompactionThresholds(fixture.softThreshold, fixture.hardThreshold),
  });

  const conversation = await conversations.create(conversationConfig);

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork,
    ledgerRead,
    summarizer,
    tokenizer,
    idService,
    clock,
  });

  return {
    appendUseCase: new AppendLedgerEventsUseCase({
      unitOfWork,
      ledgerRead,
      idService,
      hashPort: deterministicHashPort,
      clock,
    }),
    runCompactionUseCase,
    materializeUseCase: new MaterializeContextUseCase({
      conversations,
      contextProjection,
      summaryDag,
      ledgerRead,
      artifactStore,
      runCompaction: (input) => runCompactionUseCase.execute(input),
    }),
    checkIntegrityUseCase: new CheckIntegrityUseCase({
      conversations,
      summaryDag,
    }),
    ledgerRead,
    contextProjection,
    conversationId: conversation.id,
  };
};

const appendEvents = async (
  runtime: Runtime,
  events: readonly EventFixture[],
): Promise<void> => {
  const deterministicDeps = createDeterministicTestDeps({
    fixedDate: new Date('2026-03-01T00:00:00.000Z'),
  });

  await runtime.appendUseCase.execute({
    conversationId: runtime.conversationId,
    events: events.map((event, index) => ({
      role: event.role,
      content: event.content,
      tokenCount: deterministicDeps.tokenizer.countTokens(event.content),
      occurredAt: deterministicDeps.clock.now(),
      metadata: {
        eventId: createEventId(`evt_property_${String(index + 1).padStart(6, '0')}`),
      },
    })),
  });
};

const getAcyclicCheck = (checks: readonly { readonly name: string; readonly passed: boolean }[]) => {
  return checks.find((check) => check.name === 'acyclic_dag');
};

const computeAvailableBudget = (fixture: ConversationFixture): number => {
  const budgetService = createTokenBudgetService();
  const config = createConversationConfig({
    modelName: 'property-test-model',
    contextWindow: createTokenCount(fixture.contextWindow),
    thresholds: createCompactionThresholds(fixture.softThreshold, fixture.hardThreshold),
  });

  return budgetService.computeBudget(config, createTokenCount(0)).available.value;
};

describe('property-based invariants', () => {
  it('keeps DAG acyclic after random append + compaction sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        fc.array(eventArbitrary, { minLength: 6, maxLength: 40 }),
        fc.integer({ min: 1, max: 6 }),
        async (rawConversation, rawEvents, compactionCount) => {
          const conversation = sanitizeConversation(rawConversation);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          await appendEvents(runtime, events);

          for (let index = 0; index < compactionCount; index += 1) {
            await runtime.runCompactionUseCase.execute({
              conversationId: runtime.conversationId,
              trigger: 'hard',
            });
          }

          const integrity = await runtime.checkIntegrityUseCase.execute({
            conversationId: runtime.conversationId,
          });

          const acyclic = getAcyclicCheck(integrity.report.checks);
          expect(acyclic).toBeDefined();
          expect(acyclic?.passed).toBe(true);
          expect(integrity.report.passed).toBe(true);
        },
      ),
      {
        numRuns: 100,
      },
    );
  });

  it('preserves append-only event identity for previously persisted events', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        fc.array(eventArbitrary, { minLength: 4, maxLength: 24 }),
        async (rawConversation, rawEvents) => {
          const conversation = sanitizeConversation(rawConversation);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          const splitIndex = Math.ceil(events.length / 2);
          const firstHalf = events.slice(0, splitIndex);
          const secondHalf = events.slice(splitIndex);

          await appendEvents(runtime, firstHalf);
          const firstSnapshot = await runtime.ledgerRead.getEvents(runtime.conversationId);

          if (secondHalf.length > 0) {
            await appendEvents(runtime, secondHalf);
          }

          await runtime.runCompactionUseCase.execute({
            conversationId: runtime.conversationId,
            trigger: 'hard',
          });

          const afterSnapshot = await runtime.ledgerRead.getEvents(runtime.conversationId);
          const originalPrefix = afterSnapshot.slice(0, firstSnapshot.length);

          expect(originalPrefix).toEqual(firstSnapshot);
        },
      ),
      {
        numRuns: 100,
      },
    );
  });

  it('always converges within maxRounds for hard-trigger compaction', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        fc.array(eventArbitrary, { minLength: 10, maxLength: 50 }),
        async (rawConversation, rawEvents) => {
          const conversation = sanitizeConversation(rawConversation);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          await appendEvents(runtime, events);

          const result = await runtime.runCompactionUseCase.execute({
            conversationId: runtime.conversationId,
            trigger: 'hard',
          });

          expect(result.rounds).toBeLessThanOrEqual(10);
          expect(result.converged).toBe(true);

          const contextTokens = await runtime.contextProjection.getContextTokenCount(runtime.conversationId);
          const availableBudget = computeAvailableBudget(conversation);
          expect(contextTokens.value).toBeLessThanOrEqual(availableBudget);
        },
      ),
      {
        numRuns: 80,
      },
    );
  });

  it('never exceeds materialization budget (budgetTokens - overheadTokens)', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        budgetArbitrary,
        fc.array(eventArbitrary, { minLength: 5, maxLength: 35 }),
        async (rawConversation, rawBudget, rawEvents) => {
          const conversation = sanitizeConversation(rawConversation);
          const budget = sanitizeBudget(rawBudget);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          await appendEvents(runtime, events);

          const output = await runtime.materializeUseCase.execute({
            conversationId: runtime.conversationId,
            budgetTokens: budget.budgetTokens,
            overheadTokens: budget.overheadTokens,
          });

          expect(output.budgetUsed.value).toBeLessThanOrEqual(budget.budgetTokens - budget.overheadTokens);
        },
      ),
      {
        numRuns: 100,
      },
    );
  });

  it('does not leak mutable references from in-memory context snapshots', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        fc.array(eventArbitrary, { minLength: 3, maxLength: 15 }),
        async (rawConversation, rawEvents) => {
          const conversation = sanitizeConversation(rawConversation);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          await appendEvents(runtime, events);

          const before = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
          const syntheticItem = {
            conversationId: runtime.conversationId,
            position: 999,
            ref: {
              type: 'message' as const,
              messageId: 'evt_fake' as never,
            },
          };

          const mutableItems = before.items as unknown as unknown[];
          mutableItems.push(syntheticItem);

          const after = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
          expect(after.items).toHaveLength(events.length);
        },
      ),
      {
        numRuns: 80,
      },
    );
  });

  it('stale-version-causes-retry-not-corruption', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        fc.array(eventArbitrary, { minLength: 4, maxLength: 16 }),
        async (rawConversation, rawEvents) => {
          const conversation = sanitizeConversation(rawConversation);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          await appendEvents(runtime, events);

          const before = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
          const firstRef = before.items[0]?.ref;
          if (firstRef === undefined) {
            return;
          }

          const replacement = {
            conversationId: runtime.conversationId,
            position: 0,
            ref: firstRef,
          } as const;

          const first = runtime.contextProjection.replaceContextItems(
            runtime.conversationId,
            before.version,
            [0],
            replacement,
          );
          const second = runtime.contextProjection.replaceContextItems(
            runtime.conversationId,
            before.version,
            [0],
            replacement,
          );

          const [firstResult, secondResult] = await Promise.allSettled([first, second]);

          const rejected = [firstResult, secondResult].filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          const fulfilledCount = [firstResult, secondResult].filter(
            (result) => result.status === 'fulfilled',
          ).length;

          expect(fulfilledCount).toBe(1);
          expect(rejected).toHaveLength(1);
          expect(rejected[0]?.reason).toBeInstanceOf(StaleContextVersionError);

          const after = await runtime.contextProjection.getCurrentContext(runtime.conversationId);
          expect(after.items.map((item) => item.position)).toEqual(
            Array.from({ length: after.items.length }, (_, index) => index),
          );
        },
      ),
      {
        numRuns: 80,
      },
    );
  });

  it('parallel-compaction-maintains-dag-integrity', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationArbitrary,
        fc.array(eventArbitrary, { minLength: 12, maxLength: 36 }),
        async (rawConversation, rawEvents) => {
          const conversation = sanitizeConversation(rawConversation);
          const events = ensureDistinctByContent(rawEvents);
          const runtime = await createRuntime(conversation);

          await appendEvents(runtime, events);

          const first = runtime.runCompactionUseCase.execute({
            conversationId: runtime.conversationId,
            trigger: 'hard',
          });
          const second = runtime.runCompactionUseCase.execute({
            conversationId: runtime.conversationId,
            trigger: 'hard',
          });

          await Promise.all([first, second]);

          const integrity = await runtime.checkIntegrityUseCase.execute({
            conversationId: runtime.conversationId,
          });

          expect(integrity.report.passed).toBe(true);
          const acyclic = getAcyclicCheck(integrity.report.checks);
          expect(acyclic?.passed).toBe(true);
          const orphanEdges = integrity.report.checks.find((check) => check.name === 'no_orphan_edges');
          expect(orphanEdges?.passed).toBe(true);
        },
      ),
      {
        numRuns: 80,
      },
    );
  });
});
