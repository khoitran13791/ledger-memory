import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryArtifactStore,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  type InMemoryJobQueueAdapter,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createTimestamp,
  createTokenCount,
  type Artifact,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type LedgerEvent,
} from '@ledgermind/domain';
import { createInMemoryMemoryEngine } from '@ledgermind/sdk';

const createRootConversation = (id: ConversationId): Conversation => {
  return createConversation({
    id,
    config: createConversationConfig({
      modelName: 'operator-recursion-e2e',
      contextWindow: createTokenCount(16_384),
      thresholds: createCompactionThresholds(0.6, 0.9),
    }),
    createdAt: createTimestamp(new Date('2026-04-13T00:00:00.000Z')),
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('operator recursion e2e', () => {
  it('executes recursive agenticMap runs, writes ordered JSONL results, and appends a compact parent handle', async () => {
    const rootConversationId = createConversationId('conv_operator_recursion_root');
    const conversations = new Map<ConversationId, Conversation>([[rootConversationId, createRootConversation(rootConversationId)]]);
    const ledgerByConversation = new Map<ConversationId, LedgerEvent[]>();
    const artifactContents = new Map<Artifact['id'], string | Uint8Array>();
    let nextConversationOrdinal = 1;

    const originalGet = InMemoryConversationStore.prototype.get;
    const originalCreate = InMemoryConversationStore.prototype.create;
    const originalAppendEvents = InMemoryLedgerStore.prototype.appendEvents;
    const originalStoreArtifact = InMemoryArtifactStore.prototype.store;

    vi.spyOn(InMemoryConversationStore.prototype, 'get').mockImplementation(async function (
      this: InMemoryConversationStore,
      id,
    ) {
      return conversations.get(id) ?? (await originalGet.call(this, id));
    });

    vi.spyOn(InMemoryConversationStore.prototype, 'create').mockImplementation(async function (
      this: InMemoryConversationStore,
      config: ConversationConfig,
      parentId?: ConversationId,
    ) {
      const conversation = createConversation({
        id: createConversationId(`conv_operator_child_${String(nextConversationOrdinal).padStart(4, '0')}`),
        parentId: parentId ?? null,
        config,
        createdAt: createTimestamp(new Date(`2026-04-13T00:00:${String(nextConversationOrdinal).padStart(2, '0')}.000Z`)),
      });
      nextConversationOrdinal += 1;
      conversations.set(conversation.id, conversation);
      return conversation;
    });

    vi.spyOn(InMemoryLedgerStore.prototype, 'appendEvents').mockImplementation(async function (
      this: InMemoryLedgerStore,
      conversationId,
      events,
    ) {
      const existing = ledgerByConversation.get(conversationId) ?? [];
      ledgerByConversation.set(conversationId, [...existing, ...events]);
      await originalAppendEvents.call(this, conversationId, events);
    });

    vi.spyOn(InMemoryArtifactStore.prototype, 'store').mockImplementation(async function (
      this: InMemoryArtifactStore,
      artifact,
      content,
    ) {
      if (content !== undefined) {
        artifactContents.set(artifact.id, content);
      }
      await originalStoreArtifact.call(this, artifact, content);
    });

    const nestedRunIds: string[] = [];

    const engine = createInMemoryMemoryEngine({
      operators: {
        executionMode: 'inline',
        structuredGeneration: {
          async generate() {
            return {
              status: 'succeeded',
              output: { summary: 'llm-map-unused' },
            };
          },
        },
        delegationScopeResolver: {
          async resolve() {
            return {
              bootstrapEvents: [],
              childArtifacts: [],
              sourceReferenceIds: [],
            };
          },
        },
        subAgentExecutor: {
          execute: async ({ childConversationId }) => {
            const bootstrapEvent = (ledgerByConversation.get(childConversationId) ?? []).find(
              (event) => event.role === 'user' && event.content.includes('"item"'),
            );
            expect(bootstrapEvent).toBeDefined();
            if (bootstrapEvent === undefined) {
              throw new Error(`Missing bootstrap payload for ${childConversationId}.`);
            }

            const payload = JSON.parse(bootstrapEvent.content) as {
              readonly item: {
                readonly label: string;
                readonly depth: number;
              };
            };

            if (payload.item.depth > 0) {
              const nested = await engine.agenticMap({
                conversationId: childConversationId,
                taskPrompt: `nested task for ${payload.item.label}`,
                items: [
                  { label: `${payload.item.label}-alpha`, depth: payload.item.depth - 1 },
                  { label: `${payload.item.label}-beta`, depth: payload.item.depth - 1 },
                ],
                delegatedScope: {
                  note: `nested scope for ${payload.item.label}`,
                },
                keptWork: {
                  description: `nested kept work for ${payload.item.label}`,
                  expectedOutput: 'Return structured JSON.',
                },
                outputSchema: {
                  type: 'object',
                  required: ['summary', 'itemLabel'],
                },
                concurrencyLimit: 1,
                retryPolicy: {
                  maxRetries: 0,
                  retryBackoffSeconds: 1,
                },
              });

              nestedRunIds.push(nested.runId);
              return {
                status: 'succeeded',
                output: {
                  summary: `delegated:${payload.item.label}`,
                  itemLabel: payload.item.label,
                  nestedRunId: nested.runId,
                },
              };
            }

            return {
              status: 'succeeded',
              output: {
                summary: `leaf:${payload.item.label}`,
                itemLabel: payload.item.label,
              },
            };
          },
        },
      },
    });

    const submitted = await engine.agenticMap({
      conversationId: rootConversationId,
      taskPrompt: 'Process each root item and recurse when depth is positive.',
      items: [
        { label: 'first', depth: 1 },
        { label: 'second', depth: 0 },
      ],
      delegatedScope: {
        note: 'Root delegated scope.',
      },
      keptWork: {
        description: 'Keep outputs compact at the parent level.',
        expectedOutput: 'Return structured JSON.',
      },
      outputSchema: {
        type: 'object',
        required: ['summary', 'itemLabel'],
      },
      concurrencyLimit: 1,
      retryPolicy: {
        maxRetries: 0,
        retryBackoffSeconds: 1,
      },
    });

    expect(submitted.status).toBe('completed');
    expect(nestedRunIds).toHaveLength(1);

    const rootRun = await engine.getOperatorRun({ runId: submitted.runId });
    expect(rootRun.status).toBe('completed');
    expect(rootRun.tasks).toHaveLength(2);
    expect(rootRun.tasks.every((task) => task.childConversationId !== undefined)).toBe(true);

    const outputArtifactId = rootRun.outputArtifactId;
    expect(outputArtifactId).toBeDefined();
    if (outputArtifactId === undefined) {
      throw new Error('Expected outputArtifactId to be defined.');
    }

    const outputContent = artifactContents.get(outputArtifactId);
    expect(typeof outputContent).toBe('string');
    if (typeof outputContent !== 'string') {
      throw new Error('Expected string JSONL output artifact content.');
    }

    const jsonlEntries = outputContent
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { readonly itemIndex: number; readonly output?: { readonly nestedRunId?: string } });

    expect(jsonlEntries.map((entry) => entry.itemIndex)).toEqual([0, 1]);
    expect(jsonlEntries[0]?.output?.nestedRunId).toBe(nestedRunIds[0]);

    const handleEvent = (ledgerByConversation.get(rootConversationId) ?? []).find(
      (event) => event.role === 'assistant' && event.content.includes('"type":"operator_run_handle"'),
    );
    expect(handleEvent).toBeDefined();
    if (handleEvent === undefined) {
      throw new Error('Expected compact operator handle event.');
    }

    const handle = JSON.parse(handleEvent.content) as {
      readonly type: string;
      readonly operator: string;
      readonly runId: string;
      readonly outputArtifactId: string;
    };

    expect(handle).toMatchObject({
      type: 'operator_run_handle',
      operator: 'agenticMap',
      runId: submitted.runId,
      outputArtifactId,
    });
    expect(handleEvent.content).not.toContain('leaf:first');
    expect(handleEvent.content).not.toContain('leaf:second');
    expect(handleEvent.content).not.toContain('delegated:first');
  });
});
