import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMimeType } from '@ledgermind/domain';

import type { LocomoConversationSample } from './types.js';
import { createLedgermindRuntime } from './ledgermind-runtime.js';

const sample: LocomoConversationSample = {
  sample_id: 'sample-llm-summary',
  conversation: {
    session_1_date_time: '1:00 pm on 1 Jan, 2026',
    session_1: [
      {
        speaker: 'Alice',
        dia_id: 'D1:1',
        text: 'Alice promised to submit the design draft by 5 Jan 2026.',
      },
      {
        speaker: 'Bob',
        dia_id: 'D1:2',
        text: 'Bob confirmed the review meeting for 6 Jan 2026 at 3pm.',
      },
      {
        speaker: 'Alice',
        dia_id: 'D1:3',
        text: 'Alice shared the codename SilverOtter for the launch plan.',
      },
      {
        speaker: 'Bob',
        dia_id: 'D1:4',
        text: 'Bob noted outcome: checklist approved by legal.',
      },
      {
        speaker: 'Alice',
        dia_id: 'D1:5',
        text: 'Alice reiterated the fallback commitment to notify partners within 24 hours.',
      },
      {
        speaker: 'Bob',
        dia_id: 'D1:6',
        text: 'Bob archived rare anchor token ZX-41 for retrieval tests.',
      },
    ],
  },
  qa: [],
};

const fairness = {
  modelName: 'gpt-4o-mini',
  promptTemplate: 'Answer from context only.',
  temperature: 0,
  topP: 1,
  tokenBudget: 300,
  overheadTokens: 16,
  maxAnswerTokens: 32,
} as const;

describe('createLedgermindRuntime summarizer selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('supports artifact store and exploration round-trip in runtime engine', async () => {
    const artifactSample: LocomoConversationSample = {
      ...sample,
      conversation: {
        ...sample.conversation,
        session_1: [
          {
            speaker: 'Alice',
            dia_id: 'D1:1',
            text: 'Alice shared a new architecture screenshot for the migration plan.',
            blip_caption: '{"image":"architecture","version":"v1"}',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:2',
            text: 'Bob confirmed the screenshot looked clear.',
          },
        ],
      },
    };

    const runtime = await createLedgermindRuntime({
      sample: artifactSample,
      fairness,
      runtimeMode: 'agentic_loop',
      summarizerType: 'locomo_deterministic_head_tail_v1',
      llmBaseUrl: undefined,
      llmApiKey: undefined,
      llmTimeoutMs: 1_000,
      precompact: false,
    });

    const stored = await runtime.engine.storeArtifact({
      conversationId: runtime.conversationId,
      source: {
        kind: 'text',
        content: '{"artifact":"locomo-runtime"}',
      },
      mimeType: createMimeType('application/json'),
    });

    const duplicated = await runtime.engine.storeArtifact({
      conversationId: runtime.conversationId,
      source: {
        kind: 'text',
        content: '{"artifact":"locomo-runtime"}',
      },
      mimeType: createMimeType('application/json'),
    });

    const explored = await runtime.engine.exploreArtifact({
      artifactId: stored.artifactId,
    });

    const described = await runtime.engine.describe({
      id: stored.artifactId,
    });

    expect(String(stored.artifactId).startsWith('file_')).toBe(true);
    expect(duplicated.artifactId).toBe(stored.artifactId);
    expect(explored.explorerUsed).toBe('json-explorer');
    expect(explored.summary).toContain('JSON exploration');
    expect(described.kind).toBe('artifact');
    expect(described.explorationSummary).toBe(explored.summary);
    expect(described.planningSignals).toEqual({
      hasExplorationSummary: true,
      lexicalAnchors: [],
      evidenceIds: [],
      explorerUsed: 'json-explorer',
    });
    expect(runtime.provenance.artifactBearingExampleCount).toBe(1);

    await runtime.destroy();
  });

  it('records deterministic summarizer in runtime provenance', async () => {
    const runtime = await createLedgermindRuntime({
      sample,
      fairness,
      runtimeMode: 'static_materialize',
      summarizerType: 'locomo_deterministic_head_tail_v1',
      llmBaseUrl: undefined,
      llmApiKey: undefined,
      llmTimeoutMs: 1_000,
      precompact: false,
    });

    expect(runtime.provenance.summarizerType).toBe('locomo_deterministic_head_tail_v1');
    expect(runtime.provenance.artifactBearingExampleCount).toBe(0);
    expect(runtime.provenance.artifactsEnabled).toBe(true);
    expect(runtime.flushSummarizationTrace()).toEqual([]);
    await runtime.destroy();
  });

  it('supports disabling artifacts in runtime provenance and context materialization', async () => {
    const artifactSample: LocomoConversationSample = {
      ...sample,
      conversation: {
        ...sample.conversation,
        session_1: [
          {
            speaker: 'Alice',
            dia_id: 'D1:1',
            text: 'Alice shared a migration screenshot.',
            blip_caption: '{"image":"migration","version":"v2"}',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:2',
            text: 'Bob acknowledged the screenshot.',
          },
        ],
      },
    };

    const runtime = await createLedgermindRuntime({
      sample: artifactSample,
      fairness,
      runtimeMode: 'static_materialize',
      summarizerType: 'locomo_deterministic_head_tail_v1',
      llmBaseUrl: undefined,
      llmApiKey: undefined,
      llmTimeoutMs: 1_000,
      precompact: false,
      artifactsEnabled: false,
    });

    const materialized = await runtime.engine.materializeContext({
      conversationId: runtime.conversationId,
      budgetTokens: 256,
      overheadTokens: 32,
    });

    expect(runtime.provenance.artifactsEnabled).toBe(false);
    expect(materialized.artifactReferences).toHaveLength(0);
    expect(materialized.modelMessages.some((message) => message.content.includes('[shared file_'))).toBe(false);

    await runtime.destroy();
  });

  it('records llm structured summarizer in runtime provenance and structured trace entries', async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            entities: ['Alice', 'Bob', 'SilverOtter'],
            dates: ['5 Jan 2026', '6 Jan 2026'],
            commitments: ['Alice submit design draft by 5 Jan 2026'],
            outcomes: ['checklist approved by legal'],
            lexicalAnchors: ['SilverOtter', 'ZX-41'],
            messageFacts: [
              {
                role: 'assistant',
                date: '5 Jan 2026',
                speaker: 'Alice',
                fact: 'Alice promised to submit the design draft by 5 Jan 2026',
                anchor: 'SilverOtter',
              },
            ],
          }),
        }),
      }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const compactionSample: LocomoConversationSample = {
      sample_id: 'sample-compaction-llm',
      conversation: {
        session_1_date_time: '1:00 pm on 1 Jan, 2026',
        session_1: [
          {
            speaker: 'Alice',
            dia_id: 'D1:1',
            text: 'Message 1 about a plan and logistics details for the weekend project.',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:2',
            text: 'Message 2 about a plan and logistics details for the weekend project.',
          },
          {
            speaker: 'Alice',
            dia_id: 'D1:3',
            text: 'Message 3 about a plan and logistics details for the weekend project.',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:4',
            text: 'Message 4 about a plan and logistics details for the weekend project.',
          },
          {
            speaker: 'Alice',
            dia_id: 'D1:5',
            text: 'Message 5 about a plan and logistics details for the weekend project.',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:6',
            text: 'Message 6 about a plan and logistics details for the weekend project.',
          },
        ],
      },
      qa: [],
    };

    const runtime = await createLedgermindRuntime({
      sample: compactionSample,
      fairness,
      runtimeMode: 'static_materialize',
      summarizerType: 'locomo_llm_structured_v1',
      llmBaseUrl: 'https://example.test/v1',
      llmApiKey: 'test-key',
      llmTimeoutMs: 1_000,
      precompact: true,
    });

    const runtimeTrace = runtime.flushSummarizationTrace();

    expect(runtime.provenance.summarizerType).toBe('locomo_llm_structured_v1');
    expect(runtimeTrace.length).toBeGreaterThan(0);
    expect(runtimeTrace[0]?.summarizerType).toBe('locomo_llm_structured_v1');
    expect(runtimeTrace[0]?.outputContent).toContain('[Structured Summary]');
    expect(runtimeTrace[0]?.outputContent).toContain('lexical_anchors');
    expect(runtimeTrace[0]?.outputContent).toContain('SilverOtter');
    expect(runtimeTrace[0]?.outputContent).toContain('ZX-41');
    expect(runtimeTrace[0]?.outputContent).toContain('commitments');
    expect(fetchMock).toHaveBeenCalled();

    await runtime.destroy();
  });
});
