# LoCoMo Benchmark Validity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore LoCoMo benchmark validity by fixing subset scoring, de-duplicating the raw-turn ablation, isolating the artifact toggle, and reporting parity truthfully.

**Architecture:** Keep the benchmark package thin and suite-local. Fix the existing seams instead of redesigning the harness: scorer payload construction, baseline registry configuration, runtime event/context formatting, and run-summary aggregation. Each fix starts with a regression test so the benchmark cannot silently drift back into invalid reporting.

**Tech Stack:** TypeScript, Vitest, Node.js 22+, pnpm workspace scripts, existing `@ledgermind/benchmark-locomo` harness code

---

## File Map

- Create: `benchmarks/locomo/src/scorer.test.ts` - regression tests for selected-QA scorer payloads.
- Modify: `benchmarks/locomo/src/scorer.ts` - official scorer payload construction for subset runs.
- Modify: `benchmarks/locomo/src/baselines.ts` - raw-turn diagnostic baseline wiring.
- Modify: `benchmarks/locomo/src/baselines.test.ts` - focused baseline-registry regressions.
- Modify: `benchmarks/locomo/src/conversation.ts` - optional artifact-text formatting for runtime-owned context lines.
- Modify: `benchmarks/locomo/src/ledgermind-runtime.ts` - artifact-safe event/context formatting in LedgerMind runtime assembly.
- Modify: `benchmarks/locomo/src/ledgermind-runtime.test.ts` - runtime artifact on/off regressions.
- Modify: `benchmarks/locomo/src/runner.ts` - parity aggregation logic for full-context summaries.
- Modify: `benchmarks/locomo/src/runner.test.ts` - parity-summary regression coverage.
- Modify: `tests/quality/__tests__/locomo-smoke.test.ts` - smoke guardrails that keep diagnostic baselines distinct.
- Modify: `benchmarks/locomo/README.md` - operator-facing contract for raw-turn defaults, artifact semantics, and parity wording.

### Task 1: Restrict Official Scoring To Selected QA Rows

**Files:**
- Create: `benchmarks/locomo/src/scorer.test.ts`
- Modify: `benchmarks/locomo/src/scorer.ts`
- Test: `benchmarks/locomo/src/scorer.test.ts`

- [ ] **Step 1: Write the failing scorer regression test**

```ts
import { mkdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { scoreSeedWithOfficialScorer } from './scorer.js';
import type { LocomoConversationSample, LocomoExample, PerExampleRecord } from './types.js';

const sample: LocomoConversationSample = {
  sample_id: 'sample-scorer-subset',
  conversation: {
    session_1_date_time: '9:00 am on 1 Apr, 2026',
    session_1: [
      {
        speaker: 'Alice',
        dia_id: 'D1:1',
        text: 'Alice packed the blue notebook.',
      },
      {
        speaker: 'Bob',
        dia_id: 'D1:2',
        text: 'Bob packed the orange folder.',
      },
    ],
  },
  qa: [
    {
      question: 'What color was the notebook?',
      answer: 'blue',
      evidence: ['D1:1'],
      category: 3,
    },
    {
      question: 'What color was the folder?',
      answer: 'orange',
      evidence: ['D1:2'],
      category: 3,
    },
  ],
};

const selectedExamples: readonly LocomoExample[] = [
  {
    sampleId: 'sample-scorer-subset',
    qaIndex: 0,
    category: 3,
    question: 'What color was the notebook?',
    answer: 'blue',
    evidence: ['D1:1'],
  },
];

const rows: readonly PerExampleRecord[] = [
  {
    runId: 'run-scorer-subset',
    baseline: 'truncation',
    parityMode: 'parity',
    seed: 0,
    sampleId: 'sample-scorer-subset',
    qaIndex: 0,
    category: 3,
    question: 'What color was the notebook?',
    answer: 'blue',
    evidence: ['D1:1'],
    prediction: 'blue',
    predictionKey: 'locomo_truncation_seed_0_prediction',
    officialScore: 1,
    latencyMs: 1,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    contextTokenEstimate: 1,
    contextIds: ['D1:1'],
    evidenceInContext: {
      goldEvidenceIds: ['D1:1'],
      matchedEvidenceIds: ['D1:1'],
      missingEvidenceIds: [],
      recall: 1,
      hasGoldEvidenceInContext: true,
      hasAllGoldEvidenceInContext: true,
    },
    costUsd: 0,
    fairnessFingerprint: 'fp',
    provenance: {
      requestedPredictionMode: 'heuristic',
      actualPredictionSource: 'heuristic',
    },
    status: 'ok',
  },
];

describe('scoreSeedWithOfficialScorer subset payload', () => {
  it('serializes only the selected QA rows into the scorer payload artifacts', async () => {
    const outputDir = `${process.cwd()}/.tmp/locomo-scorer-subset-test`;
    await mkdir(outputDir, { recursive: true });

    await scoreSeedWithOfficialScorer({
      scorerPath: 'missing.py',
      outputDir,
      baseline: 'truncation',
      seed: 0,
      allSamples: [sample],
      examples: selectedExamples,
      rows,
    });

    const modelPayload = JSON.parse(
      await readFile(`${outputDir}/locomo_truncation_seed_0.json`, 'utf8'),
    ) as readonly { readonly qa: readonly { readonly question: string }[] }[];
    const flatPayload = JSON.parse(
      await readFile(`${outputDir}/locomo_truncation_seed_0_qa_flat.json`, 'utf8'),
    ) as readonly { readonly question: string }[];

    expect(modelPayload).toHaveLength(1);
    expect(modelPayload[0]?.qa).toHaveLength(1);
    expect(modelPayload[0]?.qa[0]?.question).toBe('What color was the notebook?');
    expect(flatPayload).toHaveLength(1);
    expect(flatPayload[0]?.question).toBe('What color was the notebook?');
  });
});
```

- [ ] **Step 2: Run the focused scorer test and confirm it fails**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/scorer.test.ts`

Expected: FAIL because the emitted scorer payload still contains both QA rows from the conversation.

- [ ] **Step 3: Implement selected-QA filtering in the scorer payload builder**

```ts
const toSampleQaForScoring = (input: {
  readonly sample: LocomoConversationSample;
  readonly selectedQaIndexes: ReadonlySet<number>;
  readonly exampleMap: ReadonlyMap<string, PerExampleRecord>;
  readonly predictionKey: string;
  readonly modelKey: string;
}): { readonly sample_id: string; readonly qa: readonly Record<string, unknown>[] } => {
  const qa = input.sample.qa
    .map((qa, qaIndex) => ({ qa, qaIndex }))
    .filter(({ qaIndex }) => input.selectedQaIndexes.has(qaIndex))
    .map(({ qa, qaIndex }) => {
      const mapKey = `${input.sample.sample_id}::${qaIndex}`;
      const row = input.exampleMap.get(mapKey);

      const prediction = row?.prediction ?? 'No information available';
      const f1 = row?.officialScore ?? 0;

      const payload: Record<string, unknown> = {
        question: qa.question,
        answer: qa.answer,
        evidence: qa.evidence,
        category: qa.category,
        [input.predictionKey]: prediction,
        [`${input.modelKey}_f1`]: f1,
      };

      if (row !== undefined && row.contextIds.length > 0) {
        payload[`${input.predictionKey}_context`] = row.contextIds;
        payload[`${input.modelKey}_recall`] = 1;
      }

      return payload;
    });

  return {
    sample_id: input.sample.sample_id,
    qa,
  };
};

const selectedQaIndexesBySample = new Map<string, Set<number>>();
for (const example of input.examples) {
  const bucket = selectedQaIndexesBySample.get(example.sampleId) ?? new Set<number>();
  bucket.add(example.qaIndex);
  selectedQaIndexesBySample.set(example.sampleId, bucket);
}

const qaBySample = input.allSamples
  .filter((sample) => selectedQaIndexesBySample.has(sample.sample_id))
  .map((sample) =>
    toSampleQaForScoring({
      sample,
      selectedQaIndexes: selectedQaIndexesBySample.get(sample.sample_id) ?? new Set<number>(),
      exampleMap,
      predictionKey,
      modelKey,
    }),
  )
  .filter((sample) => sample.qa.length > 0);
```

- [ ] **Step 4: Re-run the scorer regression test**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/scorer.test.ts`

Expected: PASS and the written scorer payload files contain only the selected QA rows.

- [ ] **Step 5: Commit the scorer fix**

```bash
git add benchmarks/locomo/src/scorer.ts benchmarks/locomo/src/scorer.test.ts
git commit -m "fix: limit locomo scorer payloads to selected rows"
```

### Task 2: Make Raw-Turn Diagnostics A Real Ablation

**Files:**
- Modify: `benchmarks/locomo/src/baselines.ts`
- Modify: `benchmarks/locomo/src/baselines.test.ts`
- Test: `benchmarks/locomo/src/baselines.test.ts`

- [ ] **Step 1: Add a failing baseline-registry regression**

```ts
it('keeps raw-turn diagnostic variants distinct from the default runtime anchors', async () => {
  const config = {
    ...makeConfig('heuristic'),
    baselines: [
      'ledgermind_static_materialize',
      'ledgermind_static_materialize_raw_turn_injection',
      'ledgermind_agentic_loop',
      'ledgermind_agentic_loop_raw_turn_injection',
    ],
  } satisfies LocomoBenchmarkConfig;

  const baselines = createBaselineStrategies(config);

  const staticDefault = await baselines.ledgermind_static_materialize.run({
    sample,
    example,
    fairness: config.fairness,
    seed: 0,
  });
  const staticRawTurn = await baselines.ledgermind_static_materialize_raw_turn_injection.run({
    sample,
    example,
    fairness: config.fairness,
    seed: 0,
  });
  const agenticDefault = await baselines.ledgermind_agentic_loop.run({
    sample,
    example,
    fairness: config.fairness,
    seed: 0,
  });
  const agenticRawTurn = await baselines.ledgermind_agentic_loop_raw_turn_injection.run({
    sample,
    example,
    fairness: config.fairness,
    seed: 0,
  });

  expect(staticDefault.diagnostics?.rawTurnInjectionEnabled).toBe(false);
  expect(staticRawTurn.diagnostics?.rawTurnInjectionEnabled).toBe(true);
  expect(agenticDefault.diagnostics?.rawTurnInjectionEnabled).toBe(false);
  expect(agenticRawTurn.diagnostics?.rawTurnInjectionEnabled).toBe(true);
});
```

- [ ] **Step 2: Run the focused baseline test and confirm it fails**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/baselines.test.ts`

Expected: FAIL because the default `ledgermind_*` anchors currently report `rawTurnInjectionEnabled === true`.

- [ ] **Step 3: Change the default anchors to disable raw-turn injection**

```ts
ledgermind_static_materialize: createLedgermindBaseline(config, {
  name: 'ledgermind_static_materialize',
  variant: 'default',
  preCompactionEnabled: true,
  rawTurnInjectionEnabled: false,
  runtimeMode: 'static_materialize',
}),

ledgermind_agentic_loop: createLedgermindBaseline(config, {
  name: 'ledgermind_agentic_loop',
  variant: 'default',
  preCompactionEnabled: true,
  rawTurnInjectionEnabled: false,
  runtimeMode: 'agentic_loop',
}),
```

- [ ] **Step 4: Re-run the focused baseline regression**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/baselines.test.ts`

Expected: PASS and the default anchor diagnostics now differ from the `*_raw_turn_injection` variants.

- [ ] **Step 5: Commit the raw-turn ablation fix**

```bash
git add benchmarks/locomo/src/baselines.ts benchmarks/locomo/src/baselines.test.ts
git commit -m "fix: separate locomo raw-turn diagnostics from anchors"
```

### Task 3: Isolate The Artifact Toggle From Inline Caption Leakage

**Files:**
- Modify: `benchmarks/locomo/src/conversation.ts`
- Modify: `benchmarks/locomo/src/ledgermind-runtime.ts`
- Modify: `benchmarks/locomo/src/ledgermind-runtime.test.ts`
- Modify: `benchmarks/locomo/src/baselines.test.ts`
- Test: `benchmarks/locomo/src/ledgermind-runtime.test.ts`
- Test: `benchmarks/locomo/src/baselines.test.ts`

- [ ] **Step 1: Add a failing runtime regression for artifact-safe materialization**

```ts
it('does not inline raw artifact caption text into runtime context when artifacts are enabled', async () => {
  const runtime = await createLedgermindRuntime({
    sample: artifactSample,
    fairness,
    runtimeMode: 'static_materialize',
    summarizerType: 'locomo_deterministic_head_tail_v1',
    llmBaseUrl: undefined,
    llmApiKey: undefined,
    llmTimeoutMs: 1_000,
    precompact: false,
    artifactsEnabled: true,
  });

  const materialized = await runtime.engine.materializeContext({
    conversationId: runtime.conversationId,
    budgetTokens: 256,
    overheadTokens: 32,
  });

  expect(materialized.modelMessages.some((message) => message.content.includes('shared_caption'))).toBe(false);
  expect(materialized.modelMessages.some((message) => message.content.includes('"image":"migration"'))).toBe(false);
  expect(materialized.modelMessages.some((message) => message.content.includes('[shared file_'))).toBe(true);

  await runtime.destroy();
});
```

- [ ] **Step 2: Run the focused runtime tests and confirm they fail**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/ledgermind-runtime.test.ts src/baselines.test.ts`

Expected: FAIL because runtime messages still contain `shared_caption` and raw caption text when artifacts are enabled.

- [ ] **Step 3: Add explicit artifact text modes and use the runtime-safe mode**

```ts
export type ArtifactTextMode = 'inline_caption' | 'artifact_id_only' | 'omit';

export const formatTurnLine = (
  turn: LocomoTurn,
  input: {
    readonly artifactTextMode?: ArtifactTextMode;
    readonly artifactIdByTurnId?: ReadonlyMap<string, string>;
  } = {},
): string => {
  const base = `DATE: ${turn.dateTime} | ID: ${turn.diaId} | ${turn.speaker} said, "${turn.text}"`;

  if (turn.blipCaption === undefined) {
    return base;
  }

  const artifactTextMode = input.artifactTextMode ?? 'inline_caption';
  if (artifactTextMode === 'omit') {
    return base;
  }

  if (artifactTextMode === 'artifact_id_only') {
    const artifactId = input.artifactIdByTurnId?.get(turn.diaId);
    return artifactId === undefined ? base : `${base} [shared ${artifactId}]`;
  }

  return `${base} and shared ${turn.blipCaption}`;
};

export const buildContextLines = (
  sample: LocomoConversationSample,
  input: {
    readonly artifactTextMode?: ArtifactTextMode;
    readonly artifactIdByTurnId?: ReadonlyMap<string, string>;
  } = {},
): readonly ContextLine[] => {
  return Object.freeze(
    extractTurns(sample).map((turn) => {
      const text = formatTurnLine(turn, input);
      return {
        id: turn.diaId,
        text,
        tokenEstimate: estimateTokens(text),
      };
    }),
  );
};
```

```ts
const sharedSuffix =
  turn.blipCaption === undefined
    ? ''
    : input.artifactsEnabled && artifactId !== undefined
      ? ` [shared ${artifactId}]`
      : '';

const content = `DATE: ${turn.dateTime} | ID: ${turn.diaId} | ${turn.speaker}: ${turn.text}${sharedSuffix}`;

contextLines: buildContextLines(input.sample, {
  artifactTextMode: input.artifactsEnabled ? 'artifact_id_only' : 'omit',
  artifactIdByTurnId,
}).map((line) => ({
  id: line.id,
  text: line.text,
  tokenEstimate: line.tokenEstimate,
})),
```

- [ ] **Step 4: Re-run the runtime and agentic baseline regressions**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/ledgermind-runtime.test.ts src/baselines.test.ts`

Expected: PASS and artifact-enabled runtime context shows artifact IDs only until exploration adds artifact content through the tool loop.

- [ ] **Step 5: Commit the artifact isolation fix**

```bash
git add benchmarks/locomo/src/conversation.ts benchmarks/locomo/src/ledgermind-runtime.ts benchmarks/locomo/src/ledgermind-runtime.test.ts benchmarks/locomo/src/baselines.test.ts
git commit -m "fix: isolate locomo artifact toggle from inline captions"
```

### Task 4: Report Parity From Actual Execution Rows

**Files:**
- Modify: `benchmarks/locomo/src/runner.ts`
- Modify: `benchmarks/locomo/src/runner.test.ts`
- Test: `benchmarks/locomo/src/runner.test.ts`

- [ ] **Step 1: Add a failing parity-summary regression**

```ts
it('preserves parity summaries for full_context when all rows fit in budget', async () => {
  const outputDir = `${process.cwd()}/.tmp/locomo-runner-parity-test`;

  const result = await runLocomoBenchmark({
    config: makeConfig(outputDir, ['full_context']),
    samples: [sample],
    examples: [
      {
        sampleId: 'sample-1',
        qaIndex: 0,
        category: 3,
        question: 'What is the name of the dog Alice adopted?',
        answer: 'Comet',
        evidence: ['D1:1'],
      },
    ],
  });

  expect(result.runSummary.baselines).toHaveLength(1);
  expect(result.runSummary.baselines[0]?.baseline).toBe('full_context');
  expect(result.runSummary.baselines[0]?.parityMode).toBe('parity');
});
```

- [ ] **Step 2: Run the focused runner test and confirm it fails**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/runner.test.ts`

Expected: FAIL because `runSummary.baselines[0].parityMode` is still forced to `upper_bound`.

- [ ] **Step 3: Remove the baseline-name override from parity aggregation**

```ts
const parityMode = rows.some((row) => row.parityMode === 'upper_bound')
  ? 'upper_bound'
  : 'parity';
```

- [ ] **Step 4: Re-run the focused runner regression**

Run: `pnpm --filter @ledgermind/benchmark-locomo test -- --run src/runner.test.ts`

Expected: PASS and short/custom `full_context` runs now report `parity` truthfully.

- [ ] **Step 5: Commit the parity-summary fix**

```bash
git add benchmarks/locomo/src/runner.ts benchmarks/locomo/src/runner.test.ts
git commit -m "fix: report locomo parity from execution rows"
```

### Task 5: Update Operator Guardrails And Re-Verify The Harness

**Files:**
- Modify: `tests/quality/__tests__/locomo-smoke.test.ts`
- Modify: `benchmarks/locomo/README.md`
- Test: `tests/quality/__tests__/locomo-smoke.test.ts`

- [ ] **Step 1: Add smoke assertions for the raw-turn diagnostic split and update the README contract**

```ts
const staticAnchor = findSummary({
  summaries: result.runSummary.baselines,
  baselineName: 'ledgermind_static_materialize',
});
const staticRawTurn = findSummary({
  summaries: result.runSummary.baselines,
  baselineName: 'ledgermind_static_materialize_raw_turn_injection',
});

expect(staticAnchor.diagnostics?.rawTurnInjectionEnabledRate).toBe(0);
expect(staticRawTurn.diagnostics?.rawTurnInjectionEnabledRate).toBe(1);
```

```md
Default in heuristic mode (`--runtime-mode static_materialize`):

- `ledgermind_static_materialize` (parity anchor, no raw-turn injection)

Optional LedgerMind diagnostics (`--include-ledgermind-diagnostics`):

- static runtime mode: `ledgermind_static_materialize_no_precompaction`, `ledgermind_static_materialize_raw_turn_injection`, `ledgermind_static_materialize_no_precompaction_raw_turn_injection`
- agentic runtime mode: `ledgermind_agentic_loop_no_precompaction`, `ledgermind_agentic_loop_raw_turn_injection`, `ledgermind_agentic_loop_no_precompaction_raw_turn_injection`

- `--artifacts-enabled <true|false>` toggles artifact storage and exploration without inlining raw caption text into LedgerMind runtime context.
- `full_context` and `oracle_full_conversation_llm` are labeled as upper-bound only when the executed rows exceed the parity budget.
```

- [ ] **Step 2: Run the smoke guardrail and package verification commands**

Run: `pnpm --filter @ledgermind/tests test:quality:locomo:smoke`

Expected: PASS and the smoke test now proves the raw-turn diagnostic baseline is distinct from the anchor.

Run: `pnpm --filter @ledgermind/benchmark-locomo test`

Expected: PASS with the new scorer, baseline, runtime, and runner regressions included.

Run: `pnpm --filter @ledgermind/benchmark-locomo typecheck`

Expected: PASS with no TypeScript errors.

Run: `pnpm --filter @ledgermind/benchmark-locomo lint`

Expected: PASS with no ESLint errors.

- [ ] **Step 3: Commit the README and smoke-guardrail updates**

```bash
git add tests/quality/__tests__/locomo-smoke.test.ts benchmarks/locomo/README.md
git commit -m "docs: lock locomo benchmark guardrails"
```

## Self-Review

- Spec coverage: Task 1 fixes subset scoring. Task 2 fixes the duplicate raw-turn ablation. Task 3 fixes artifact-path leakage. Task 4 fixes parity reporting. Task 5 adds smoke/docs guardrails so the benchmark stays trustworthy.
- Placeholder scan: No `TODO`, `TBD`, or unspecified "write tests later" steps remain.
- Type consistency: The plan uses existing `LocomoBenchmarkConfig`, `PerExampleRecord`, `BaselineAggregateSummary`, and current package test commands consistently across tasks.
