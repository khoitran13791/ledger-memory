import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBaselineStrategies } from './baselines.js';
import type { LocomoBenchmarkConfig } from './config.js';
import type { LocomoConversationSample, LocomoExample } from './types.js';

const sample: LocomoConversationSample = {
  sample_id: 'sample-oracle',
  conversation: {
    speaker_a: 'Caroline',
    speaker_b: 'Melanie',
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      {
        speaker: 'Caroline',
        dia_id: 'D1:1',
        text: 'I went to a LGBTQ support group yesterday and it was powerful.',
      },
      {
        speaker: 'Melanie',
        dia_id: 'D1:2',
        text: 'That sounds meaningful and encouraging.',
      },
    ],
  },
  qa: [
    {
      question: 'When did Caroline go to the support group?',
      answer: '7 May 2023',
      evidence: ['D1:1'],
      category: 2,
    },
  ],
};

const example: LocomoExample = {
  sampleId: 'sample-oracle',
  qaIndex: 0,
  category: 2,
  question: 'When did Caroline go to the support group?',
  answer: '7 May 2023',
  evidence: ['D1:1'],
};

const makeConfig = (predictionMode: 'heuristic' | 'llm'): LocomoBenchmarkConfig => ({
  runId: 'run-1',
  datasetPath: 'benchmarks/locomo/data/locomo10.json',
  outputDir: '.tmp/locomo-baselines-test',
  baselines: ['oracle_evidence'],
  seeds: [0],
  smoke: true,
  canary: false,
  fairness: {
    modelName: 'gpt-4o-mini',
    promptTemplate: 'Answer from the provided conversation context only.',
    temperature: 0,
    topP: 1,
    tokenBudget: 3_000,
    overheadTokens: 300,
    maxAnswerTokens: 50,
  },
  predictionMode,
  seedMode: predictionMode === 'llm' ? 'forwarded' : 'ignored',
  llmBaseUrl: 'https://example.test/v1',
  llmApiKey: 'test-key',
  llmTimeoutMs: 1_000,
  maxExamples: undefined,
  scorerPath: 'benchmarks/locomo/vendor/locomo/task_eval/evaluation.py',
  scorerVersion: 'test',
  smokeExampleIdsPath: 'benchmarks/locomo/config/smoke-example-ids.json',
  canaryExampleIdsPath: 'benchmarks/locomo/config/canary-example-ids.json',
  retrievedSummaryLimit: 6,
  ragTopK: 8,
  ledgermindRawTurnInjectionTopK: 4,
  ledgermindRawTurnInjectionMaxTokens: 256,
  ledgermindToolLoopMaxSteps: 6,
  ledgermindToolLoopMaxDescribeCalls: 3,
  ledgermindToolLoopMaxExploreArtifactCalls: 2,
  ledgermindToolLoopMaxExpandCalls: 2,
  ledgermindToolLoopMaxGrepCalls: 2,
  ledgermindToolLoopMaxAddedTokens: 256,
  includeLedgermindDiagnostics: false,
  fairnessFingerprintInputs: {
    ledgermindRetrievalReserveFraction: 0.2,
    ledgermindRetrievalReserveMaxTokens: 256,
    ledgermindSummaryFormatter: 'structured_head_tail_v1',
    summarySearchScoring: 'staged_candidate_selection_v1',
    predictionExtractorVersion: 'llm_completion_v1',
    category5PromptVersion: 'no_answer_choices_v1',
    rawTurnInjectionFormatterVersion: 'plain_lines_v2',
    rawTurnInjectionSelectionVersion: 'question_overlap_topk_v2',
    ledgermindToolLoopMaxSteps: 6,
    ledgermindToolLoopMaxDescribeCalls: 3,
    ledgermindToolLoopMaxExploreArtifactCalls: 2,
    ledgermindToolLoopMaxExpandCalls: 2,
    ledgermindToolLoopMaxGrepCalls: 2,
    ledgermindToolLoopMaxAddedTokens: 256,
    locomoArtifactMappingVersion: 'blip_caption_text_artifact_v1',
  },
  runtimeMode: 'static_materialize',
  summarizerType: 'locomo_deterministic_head_tail_v1',
  artifactsEnabled: true,
  fairnessFingerprint: 'fp',
  promptHash: 'prompt-hash',
  costPer1kPromptUsd: 0,
  costPer1kCompletionUsd: 0,
});

const toJsonResponse = (payload: unknown): Response => {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
};

describe('oracle baselines', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses runtime-labeled ledgermind keys in static mode', () => {
    const config = {
      ...makeConfig('heuristic'),
      baselines: ['ledgermind_static_materialize'],
      runtimeMode: 'static_materialize' as const,
    } satisfies LocomoBenchmarkConfig;

    const baselines = createBaselineStrategies(config);

    expect(baselines.ledgermind_static_materialize.name).toBe('ledgermind_static_materialize');
    expect(baselines.ledgermind_static_materialize_no_precompaction.name).toBe(
      'ledgermind_static_materialize_no_precompaction',
    );
  });

  it('uses runtime-labeled ledgermind keys in agentic mode', () => {
    const config = {
      ...makeConfig('heuristic'),
      baselines: ['ledgermind_agentic_loop'],
      runtimeMode: 'agentic_loop' as const,
    } satisfies LocomoBenchmarkConfig;

    const baselines = createBaselineStrategies(config);

    expect(baselines.ledgermind_agentic_loop.name).toBe('ledgermind_agentic_loop');
    expect(baselines.ledgermind_agentic_loop_no_precompaction.name).toBe('ledgermind_agentic_loop_no_precompaction');
  });

  it('records runtime provenance that matches the baseline runtime mode label', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.91);

    const artifactSample: LocomoConversationSample = {
      sample_id: 'sample-agentic-artifact',
      conversation: {
        session_1_date_time: '1:00 pm on 1 Jan, 2026',
        session_1: [
          {
            speaker: 'Alice',
            dia_id: 'D1:1',
            text: 'Alice shared architecture notes with migration details, sequence diagrams, and rollback checkpoints.',
            blip_caption: '{"artifact":"architecture","version":"v1","topic":"migration"}',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:2',
            text: 'Bob asked which parts of the architecture notes are mandatory for first rollout and which are optional.',
          },
          {
            speaker: 'Alice',
            dia_id: 'D1:3',
            text: 'Alice clarified that retry policy and idempotency safeguards are mandatory for release readiness.',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:4',
            text: 'Bob requested a compact checklist tied to deployment gates and incident response expectations.',
            blip_caption: '{"artifact":"checklist","items":["retry-policy","incident-runbook"]}',
          },
          {
            speaker: 'Alice',
            dia_id: 'D1:5',
            text: 'Alice confirmed the checklist includes rollback windows, observability alerts, and ownership mapping.',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:6',
            text: 'Bob reiterated that architecture notes must stay discoverable during the QA session.',
          },
        ],
      },
      qa: [
        {
          question: 'What did Alice share?',
          answer: 'architecture notes',
          evidence: ['D1:1'],
          category: 3,
        },
      ],
    };

    const artifactExample: LocomoExample = {
      sampleId: 'sample-agentic-artifact',
      qaIndex: 0,
      category: 3,
      question: 'What did Alice share?',
      answer: 'architecture notes',
      evidence: ['D1:1'],
    };

    const constrainedFairness = {
      ...makeConfig('heuristic').fairness,
      tokenBudget: 3000,
      overheadTokens: 16,
    };

    const staticExecution = await createBaselineStrategies({
      ...makeConfig('heuristic'),
      runtimeMode: 'static_materialize',
      baselines: ['ledgermind_static_materialize'],
      fairness: constrainedFairness,
    }).ledgermind_static_materialize.run({
      sample,
      example,
      fairness: constrainedFairness,
      seed: 0,
    });

    const agenticExecution = await createBaselineStrategies({
      ...makeConfig('heuristic'),
      runtimeMode: 'agentic_loop',
      baselines: ['ledgermind_agentic_loop_no_precompaction'],
      fairness: constrainedFairness,
    }).ledgermind_agentic_loop_no_precompaction.run({
      sample: artifactSample,
      example: artifactExample,
      fairness: constrainedFairness,
      seed: 0,
    });

    expect(staticExecution.provenance?.runtime?.runtimeMode).toBe('static_materialize');
    expect(staticExecution.diagnostics?.toolLoop).toBeUndefined();

    expect(agenticExecution.provenance?.runtime?.runtimeMode).toBe('agentic_loop');
    expect(agenticExecution.provenance?.runtime?.artifactBearingExampleCount).toBeGreaterThan(0);
    expect(agenticExecution.diagnostics?.artifactBearingExample).toBe(true);
    expect(agenticExecution.diagnostics?.toolLoop?.enabled).toBe(true);
    expect(agenticExecution.diagnostics?.toolLoop?.stepsUsed ?? 0).toBeLessThanOrEqual(
      makeConfig('heuristic').ledgermindToolLoopMaxSteps,
    );
    expect(agenticExecution.diagnostics?.toolLoop?.describedIds.length ?? 0).toBeLessThanOrEqual(
      makeConfig('heuristic').ledgermindToolLoopMaxDescribeCalls,
    );
    expect(agenticExecution.diagnostics?.toolLoop?.exploredArtifactIds.length ?? 0).toBeLessThanOrEqual(
      makeConfig('heuristic').ledgermindToolLoopMaxExploreArtifactCalls,
    );
    expect(agenticExecution.diagnostics?.toolLoop?.expandedSummaryIds.length ?? 0).toBeLessThanOrEqual(
      makeConfig('heuristic').ledgermindToolLoopMaxExpandCalls,
    );
    expect(agenticExecution.diagnostics?.toolLoop?.grepQueries.length ?? 0).toBeLessThanOrEqual(
      makeConfig('heuristic').ledgermindToolLoopMaxGrepCalls,
    );
    expect(agenticExecution.diagnostics?.toolLoop?.addedTokens ?? 0).toBeLessThanOrEqual(
      makeConfig('heuristic').ledgermindToolLoopMaxAddedTokens,
    );
    expect(agenticExecution.contextResult.context).toContain('DATE:');
    expect(agenticExecution.contextResult.context).toContain('tool: [artifact:file_');
    expect(agenticExecution.contextResult.contextIds.some((id) => id.startsWith('artifact:file_'))).toBe(true);
    expect((agenticExecution.diagnostics?.toolLoop?.exploredArtifactIds.length ?? 0) > 0).toBe(true);
    expect(
      agenticExecution.diagnostics?.toolLoop?.steps.some((step) => step.tool === 'explore_artifact' && step.status === 'ok'),
    ).toBe(true);

    const toolLoopDiagnostics = agenticExecution.diagnostics?.toolLoop;
    expect(toolLoopDiagnostics?.describeSignals?.length ?? 0).toBe(toolLoopDiagnostics?.describedIds.length ?? 0);
    expect(toolLoopDiagnostics?.expandSelection).toBeDefined();
    expect(toolLoopDiagnostics?.artifactSelection).toBeDefined();
    expect(toolLoopDiagnostics?.grepSelection).toBeDefined();

    const firstDescribeSignal = toolLoopDiagnostics?.describeSignals?.[0];
    if (firstDescribeSignal !== undefined) {
      expect(firstDescribeSignal.kind === 'summary' || firstDescribeSignal.kind === 'artifact').toBe(true);
    }

    const firstExpandSelection = toolLoopDiagnostics?.expandSelection?.[0];
    if (firstExpandSelection !== undefined) {
      expect(typeof firstExpandSelection.score).toBe('number');
      expect(Array.isArray(firstExpandSelection.reasons)).toBe(true);
    }
  });

  it('captures deterministic summarization traces for ledgermind runtime', async () => {
    const compactionSample: LocomoConversationSample = {
      sample_id: 'sample-compaction',
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
      qa: [
        {
          question: 'What project did they discuss?',
          answer: 'weekend project',
          evidence: ['D1:1'],
          category: 3,
        },
      ],
    };

    const compactionExample: LocomoExample = {
      sampleId: 'sample-compaction',
      qaIndex: 0,
      category: 3,
      question: 'What project did they discuss?',
      answer: 'weekend project',
      evidence: ['D1:1'],
    };

    const constrainedFairness = {
      ...makeConfig('heuristic').fairness,
      tokenBudget: 300,
      overheadTokens: 16,
    };

    const execution = await createBaselineStrategies({
      ...makeConfig('heuristic'),
      runtimeMode: 'static_materialize',
      baselines: ['ledgermind_static_materialize'],
      summarizerType: 'locomo_deterministic_head_tail_v1',
      fairness: constrainedFairness,
    }).ledgermind_static_materialize.run({
      sample: compactionSample,
      example: compactionExample,
      fairness: constrainedFairness,
      seed: 0,
    });

    expect(execution.diagnostics?.summarizationTrace?.length ?? 0).toBeGreaterThan(0);
    const firstTrace = execution.diagnostics?.summarizationTrace?.[0];
    expect(firstTrace?.summarizerType).toBe('locomo_deterministic_head_tail_v1');
    expect(firstTrace?.mode).toBe('normal');
    expect(firstTrace?.outputContent).toContain('[Summary]');
  });

  it('fails fast when oracle_evidence is run outside llm mode', async () => {
    const baseline = createBaselineStrategies(makeConfig('heuristic')).oracle_evidence;

    await expect(
      baseline.run({
        sample,
        example,
        fairness: makeConfig('heuristic').fairness,
        seed: 0,
      }),
    ).rejects.toThrow('oracle_evidence requires --prediction-mode llm');
  });

  it('fails fast when oracle_full_conversation_llm is run outside llm mode', async () => {
    const baseline = createBaselineStrategies(makeConfig('heuristic')).oracle_full_conversation_llm;

    await expect(
      baseline.run({
        sample,
        example,
        fairness: makeConfig('heuristic').fairness,
        seed: 0,
      }),
    ).rejects.toThrow('oracle_full_conversation_llm requires --prediction-mode llm');
  });

  it('prioritizes gold evidence context ids for oracle_evidence', async () => {
    const fetchMock = vi.fn(async () => toJsonResponse({ output_text: '7 May 2023' }));
    vi.stubGlobal('fetch', fetchMock);

    const baseline = createBaselineStrategies(makeConfig('llm')).oracle_evidence;
    const execution = await baseline.run({
      sample,
      example,
      fairness: makeConfig('llm').fairness,
      seed: 0,
    });

    expect(execution.predictionSource).toBe('llm');
    expect(execution.contextResult.contextIds[0]).toBe('D1:1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('records scoped retrieval and reserved budget diagnostics for agentic runtime', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.11);

    const fetchMock = vi.fn(async () =>
      toJsonResponse({
        output_text: JSON.stringify({
          entities: ['Alice'],
          dates: ['1 Jan 2026'],
          commitments: ['Alice promised status update'],
          outcomes: ['Checklist approved'],
          lexicalAnchors: ['ZX-41'],
          messageFacts: [
            {
              role: 'assistant',
              date: '1 Jan 2026',
              speaker: 'Alice',
              fact: 'Alice promised status update with ID D1:1',
              anchor: 'ZX-41',
            },
          ],
        }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const scopeSample: LocomoConversationSample = {
      sample_id: 'sample-agentic-scope',
      conversation: {
        session_1_date_time: '1:00 pm on 1 Jan, 2026',
        session_1: [
          { speaker: 'Alice', dia_id: 'D1:1', text: 'Alice documented rollout anchor ZX-41 for the migration.' },
          { speaker: 'Bob', dia_id: 'D1:2', text: 'Bob asked for a scope-limited retrieval to summary nodes only.' },
          { speaker: 'Alice', dia_id: 'D1:3', text: 'Alice promised a status update with evidence ID D1:1.' },
          { speaker: 'Bob', dia_id: 'D1:4', text: 'Bob confirmed checklist approval outcome for rollout prep.' },
          { speaker: 'Alice', dia_id: 'D1:5', text: 'Alice reiterated expansion should use describe and expand steps.' },
          { speaker: 'Bob', dia_id: 'D1:6', text: 'Bob requested grep follow-up if exact snippets are needed.' },
        ],
      },
      qa: [
        {
          question: 'Which anchor did Alice document for rollout?',
          answer: 'ZX-41',
          evidence: ['D1:1'],
          category: 3,
        },
      ],
    };

    const scopeExample: LocomoExample = {
      sampleId: 'sample-agentic-scope',
      qaIndex: 0,
      category: 3,
      question: 'Which anchor did Alice document for rollout?',
      answer: 'ZX-41',
      evidence: ['D1:1'],
    };

    const constrainedFairness = {
      ...makeConfig('heuristic').fairness,
      tokenBudget: 320,
      overheadTokens: 16,
    };

    const execution = await createBaselineStrategies({
      ...makeConfig('heuristic'),
      runtimeMode: 'agentic_loop',
      baselines: ['ledgermind_agentic_loop'],
      fairness: constrainedFairness,
    }).ledgermind_agentic_loop.run({
      sample: scopeSample,
      example: scopeExample,
      fairness: constrainedFairness,
      seed: 0,
    });

    expect(execution.diagnostics?.reservedForToolLoopTokens).toBeGreaterThan(0);
    expect(execution.diagnostics?.reservedForRetrievalTokens).toBeGreaterThan(0);

    expect(execution.diagnostics?.retrievalHints?.length ?? 0).toBeGreaterThan(0);
    const firstHint = execution.diagnostics?.retrievalHints?.[0];
    expect(firstHint?.stageQueries.length ?? 0).toBeGreaterThan(0);
  });
});
