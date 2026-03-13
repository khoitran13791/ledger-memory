import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryConversationStore } from '@ledgermind/adapters';
import { UnauthorizedExpandError } from '@ledgermind/application';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createMimeType,
  createTokenCount,
  type MessageRole,
} from '@ledgermind/domain';
import { createInMemoryMemoryEngine } from '@ledgermind/sdk';

interface HarnessConfig {
  readonly suffix: string;
  readonly contextWindow: number;
  readonly softThreshold: number;
  readonly hardThreshold: number;
}

const createHarness = (config: HarnessConfig) => {
  const conversationId = createConversationId(`conv_e2e_${config.suffix}`);
  const conversation = createConversation({
    id: conversationId,
    config: createConversationConfig({
      modelName: 'e2e-test-model',
      contextWindow: createTokenCount(config.contextWindow),
      thresholds: createCompactionThresholds(config.softThreshold, config.hardThreshold),
    }),
  });

  vi.spyOn(InMemoryConversationStore.prototype, 'get').mockImplementation(async (id) => {
    return id === conversationId ? conversation : null;
  });

  return {
    conversationId,
    engine: createInMemoryMemoryEngine(),
  };
};

const createEvent = (
  role: MessageRole,
  content: string,
  tokenCount: number,
) => {
  return {
    role,
    content,
    tokenCount: createTokenCount(tokenCount),
  };
};

const requireFirstId = <T>(values: readonly T[], label: string): T => {
  const first = values[0];
  expect(first, `Expected first ${label}.`).toBeDefined();

  if (first === undefined) {
    throw new Error(`Expected first ${label}.`);
  }

  return first;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sdk lifecycle e2e', () => {
  it('executes append → store/explore artifact → compact → materialize → grep → expand → integrity flow end-to-end', async () => {
    const { engine, conversationId } = createHarness({
      suffix: 'full_lifecycle',
      contextWindow: 240,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    });

    const appended = await engine.append({
      conversationId,
      events: [
        createEvent('system', 'You are a memory-preserving coding assistant.', 12),
        createEvent('user', 'Decision: use PostgreSQL for primary storage.', 18),
        createEvent('assistant', 'Confirmed. PostgreSQL selected with idempotent migrations.', 18),
        createEvent('user', 'Track migration checklist artifact for implementation.', 18),
        createEvent('tool', 'Generated SQL checklist and rollback notes.', 18),
        createEvent('assistant', 'Next step is implementing high-value end-to-end tests.', 18),
        createEvent('user', 'Remember grep scope validation for summaries.', 18),
      ],
    });

    expect(appended.appendedEvents).toHaveLength(7);

    const stored = await engine.storeArtifact({
      conversationId,
      source: {
        kind: 'text',
        content: 'migration checklist artifact payload',
      },
      mimeType: createMimeType('text/plain'),
    });

    const explored = await engine.exploreArtifact({
      artifactId: stored.artifactId,
    });
    expect(explored.summary.length).toBeGreaterThan(0);

    const compaction = await engine.runCompaction({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(110),
    });

    expect(compaction.rounds).toBeGreaterThan(0);
    expect(compaction.nodesCreated.length).toBeGreaterThan(0);

    const context = await engine.materializeContext({
      conversationId,
      budgetTokens: 220,
      overheadTokens: 20,
    });

    expect(context.budgetUsed.value).toBeLessThanOrEqual(200);
    expect(context.summaryReferences.length).toBeGreaterThan(0);

    const grep = await engine.grep({
      conversationId,
      pattern: 'PostgreSQL',
    });
    expect(grep.matches.length).toBeGreaterThan(0);

    const summaryReference = requireFirstId(context.summaryReferences, 'summary reference');
    const expanded = await engine.expand({
      summaryId: summaryReference.id,
      callerContext: {
        conversationId,
        isSubAgent: true,
      },
    });

    expect(expanded.messages.length).toBeGreaterThan(0);
    expect(expanded.messages.some((message) => message.content.includes('PostgreSQL'))).toBe(true);

    const integrity = await engine.checkIntegrity({ conversationId });
    expect(integrity.report.passed).toBe(true);
    expect(integrity.report.checks.every((check) => check.passed)).toBe(true);
  });

  it('triggers blocking hard compaction during materialization when context is over hard threshold', async () => {
    const { engine, conversationId } = createHarness({
      suffix: 'hard_materialize',
      contextWindow: 120,
      softThreshold: 0.5,
      hardThreshold: 0.6,
    });

    await engine.append({
      conversationId,
      events: [
        createEvent('user', 'alpha context item', 20),
        createEvent('assistant', 'beta context item', 20),
        createEvent('user', 'gamma context item', 20),
        createEvent('assistant', 'delta context item', 20),
        createEvent('user', 'epsilon context item', 20),
        createEvent('assistant', 'zeta context item', 20),
      ],
    });

    const context = await engine.materializeContext({
      conversationId,
      budgetTokens: 120,
      overheadTokens: 10,
    });

    expect(context.summaryReferences.length).toBeGreaterThan(0);
    expect(context.budgetUsed.value).toBeLessThanOrEqual(110);
  });

  it('supports scoped grep after compaction so matches stay within summary lineage', async () => {
    const { engine, conversationId } = createHarness({
      suffix: 'scoped_grep',
      contextWindow: 240,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    });

    const appended = await engine.append({
      conversationId,
      events: [
        createEvent('user', 'scope-only alpha decision captured', 15),
        createEvent('assistant', 'scope-only beta constraint logged', 15),
        createEvent('user', 'general planning note one', 15),
        createEvent('assistant', 'general planning note two', 15),
        createEvent('user', 'tail message should stay raw', 15),
        createEvent('assistant', 'another tail message', 15),
        createEvent('user', 'final tail checkpoint', 15),
      ],
    });

    const compaction = await engine.runCompaction({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(90),
    });

    const summaryId = requireFirstId(compaction.nodesCreated, 'summary node id');

    const unscoped = await engine.grep({ conversationId, pattern: 'scope-only' });
    const scoped = await engine.grep({
      conversationId,
      pattern: 'scope-only',
      scope: summaryId,
    });

    const firstScopedEvent = requireFirstId(appended.appendedEvents, 'first scoped event');
    const secondScopedEvent = appended.appendedEvents[1];
    expect(secondScopedEvent, 'Expected second scoped event.').toBeDefined();
    if (secondScopedEvent === undefined) {
      throw new Error('Expected second scoped event.');
    }

    const expectedIds = [firstScopedEvent.id, secondScopedEvent.id];
    expect(unscoped.matches.map((match) => match.eventId)).toEqual(expectedIds);
    expect(scoped.matches.map((match) => match.eventId)).toEqual(expectedIds);
    expect(scoped.matches.every((match) => match.coveringSummaryId === summaryId)).toBe(true);
  });

  it('round-trips artifact store → explore → describe via SDK integration', async () => {
    const { engine, conversationId } = createHarness({
      suffix: 'artifact_roundtrip',
      contextWindow: 256,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    });

    const stored = await engine.storeArtifact({
      conversationId,
      source: {
        kind: 'text',
        content: '{"auth":{"provider":"jwt"},"tokenLimit":128000}',
      },
      mimeType: createMimeType('application/json'),
    });

    const explored = await engine.exploreArtifact({
      artifactId: stored.artifactId,
    });

    const described = await engine.describe({
      id: stored.artifactId,
    });

    expect(stored.artifactId.startsWith('file_')).toBe(true);
    expect(explored.explorerUsed).toBe('json-explorer');
    expect(explored.summary.length).toBeGreaterThan(0);

    expect(described.kind).toBe('artifact');
    expect(described.tokenCount).toEqual(stored.tokenCount);
    expect(described.metadata).toEqual({ explorerUsed: explored.explorerUsed });
    expect(described.planningSignals).toEqual({
      explorerUsed: explored.explorerUsed,
      hasExplorationSummary: true,
      lexicalAnchors: [],
      evidenceIds: [],
    });
    expect(described.explorationSummary).toBe(explored.summary);
  });

  it('keeps append idempotency stable at SDK level for repeated same-key payloads', async () => {
    const { engine, conversationId } = createHarness({
      suffix: 'idempotency',
      contextWindow: 200,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    });

    const input = {
      conversationId,
      idempotencyKey: 'idem_sdk_lifecycle_1',
      events: [createEvent('user', 'idempotent payload signature', 12)],
    } as const;

    const first = await engine.append(input);
    const second = await engine.append(input);

    expect(first.appendedEvents).toHaveLength(1);
    expect(second.appendedEvents).toHaveLength(0);

    const matches = await engine.grep({
      conversationId,
      pattern: 'idempotent payload signature',
    });

    expect(matches.matches).toHaveLength(1);
  });

  it('enforces expand authorization boundary for non-sub-agent callers', async () => {
    const { engine, conversationId } = createHarness({
      suffix: 'expand_authz',
      contextWindow: 180,
      softThreshold: 0.6,
      hardThreshold: 0.9,
    });

    await engine.append({
      conversationId,
      events: [
        createEvent('user', 'auth decision one', 20),
        createEvent('assistant', 'auth decision two', 20),
        createEvent('user', 'auth decision three', 20),
        createEvent('assistant', 'auth decision four', 20),
        createEvent('user', 'auth decision five', 20),
        createEvent('assistant', 'auth decision six', 20),
      ],
    });

    const compaction = await engine.runCompaction({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(90),
    });

    const summaryId = requireFirstId(compaction.nodesCreated, 'summary node id');

    await expect(
      engine.expand({
        summaryId,
        callerContext: {
          conversationId,
          isSubAgent: false,
        },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExpandError);
  });
});
