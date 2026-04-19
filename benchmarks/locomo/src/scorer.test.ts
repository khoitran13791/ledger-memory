import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scoreSeedWithOfficialScorer } from './scorer.js';
import type { LocomoConversationSample, LocomoExample, PerExampleRecord } from './types.js';

const baseline = 'truncation';
const seed = 11;
const modelKey = `locomo_${baseline}_seed_${seed}`;
const predictionKey = `${modelKey}_prediction`;

const allSamples: readonly LocomoConversationSample[] = [
  {
    sample_id: 'sample-1',
    conversation: {},
    qa: [
      {
        question: 'Q1',
        answer: 'A1',
        evidence: ['D1:1'],
        category: 1,
      },
      {
        question: 'Q2',
        answer: 'A2',
        evidence: ['D1:2'],
        category: 2,
      },
      {
        question: 'Q3',
        answer: 'A3',
        evidence: ['D1:3'],
        category: 3,
      },
    ],
  },
  {
    sample_id: 'sample-2',
    conversation: {},
    qa: [
      {
        question: 'Q4',
        answer: 'A4',
        evidence: ['D2:1'],
        category: 4,
      },
      {
        question: 'Q5',
        answer: 'A5',
        evidence: ['D2:2'],
        category: 5,
      },
    ],
  },
];

const examples: readonly LocomoExample[] = [
  {
    sampleId: 'sample-1',
    qaIndex: 0,
    category: 1,
    question: 'Q1',
    answer: 'A1',
    evidence: ['D1:1'],
  },
  {
    sampleId: 'sample-2',
    qaIndex: 1,
    category: 5,
    question: 'Q5',
    answer: 'A5',
    evidence: ['D2:2'],
  },
];

const toPerExampleRecord = (input: {
  readonly sampleId: string;
  readonly qaIndex: number;
  readonly category: number;
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly string[];
  readonly prediction: string;
  readonly officialScore: number;
  readonly contextIds: readonly string[];
}): PerExampleRecord => {
  return {
    runId: 'run-scorer-test',
    baseline: 'truncation',
    parityMode: 'parity',
    seed,
    sampleId: input.sampleId,
    qaIndex: input.qaIndex,
    category: input.category,
    question: input.question,
    answer: input.answer,
    evidence: input.evidence,
    prediction: input.prediction,
    predictionKey,
    predictionSource: 'heuristic',
    abstentionRetried: false,
    officialScore: input.officialScore,
    latencyMs: 1,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    contextTokenEstimate: 8,
    contextIds: input.contextIds,
    artifactBearingExample: false,
    evidenceInContext: {
      goldEvidenceIds: input.evidence,
      matchedEvidenceIds: input.evidence,
      missingEvidenceIds: [],
      recall: 1,
      hasGoldEvidenceInContext: true,
      hasAllGoldEvidenceInContext: true,
    },
    costUsd: 0,
    fairnessFingerprint: 'fp-test',
    provenance: {
      requestedPredictionMode: 'heuristic',
      actualPredictionSource: 'heuristic',
    },
    status: 'ok',
  };
};

const rows: readonly PerExampleRecord[] = [
  toPerExampleRecord({
    sampleId: 'sample-1',
    qaIndex: 0,
    category: 1,
    question: 'Q1',
    answer: 'A1',
    evidence: ['D1:1'],
    prediction: 'P1',
    officialScore: 0.25,
    contextIds: ['ctx-1'],
  }),
  toPerExampleRecord({
    sampleId: 'sample-2',
    qaIndex: 1,
    category: 5,
    question: 'Q5',
    answer: 'A5',
    evidence: ['D2:2'],
    prediction: 'P5',
    officialScore: 1,
    contextIds: ['ctx-2'],
  }),
];

describe('scoreSeedWithOfficialScorer', () => {
  let outputDir: string | undefined;

  afterEach(async () => {
    if (outputDir !== undefined) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('serializes only the selected QA rows into model and flat payload files', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'locomo-scorer-'));

    const result = await scoreSeedWithOfficialScorer({
      scorerPath: '/definitely/not/installed/evaluation.py',
      outputDir,
      baseline,
      seed,
      allSamples,
      examples,
      rows,
    });

    const modelPayload = JSON.parse(await readFile(result.modelJsonPath, 'utf8')) as Array<{
      readonly sample_id: string;
      readonly qa: Array<{
        readonly question: string;
        readonly [key: string]: unknown;
      }>;
    }>;
    expect(modelPayload).toStrictEqual([
      {
        sample_id: 'sample-1',
        qa: [
          {
            question: 'Q1',
            answer: 'A1',
            evidence: ['D1:1'],
            category: 1,
            [predictionKey]: 'P1',
            [`${modelKey}_f1`]: 0.25,
            [`${predictionKey}_context`]: ['ctx-1'],
            [`${modelKey}_recall`]: 1,
          },
        ],
      },
      {
        sample_id: 'sample-2',
        qa: [
          {
            question: 'Q5',
            answer: 'A5',
            evidence: ['D2:2'],
            category: 5,
            [predictionKey]: 'P5',
            [`${modelKey}_f1`]: 1,
            [`${predictionKey}_context`]: ['ctx-2'],
            [`${modelKey}_recall`]: 1,
          },
        ],
      },
    ]);

    const qaFlatPath = path.resolve(outputDir, `${modelKey}_qa_flat.json`);
    const flatPayload = JSON.parse(await readFile(qaFlatPath, 'utf8')) as Array<{
      readonly question: string;
      readonly [key: string]: unknown;
    }>;
    expect(flatPayload).toStrictEqual([
      {
        question: 'Q1',
        answer: 'A1',
        evidence: ['D1:1'],
        category: 1,
        [predictionKey]: 'P1',
        [`${modelKey}_f1`]: 0.25,
        [`${predictionKey}_context`]: ['ctx-1'],
        [`${modelKey}_recall`]: 1,
      },
      {
        question: 'Q5',
        answer: 'A5',
        evidence: ['D2:2'],
        category: 5,
        [predictionKey]: 'P5',
        [`${modelKey}_f1`]: 1,
        [`${predictionKey}_context`]: ['ctx-2'],
        [`${modelKey}_recall`]: 1,
      },
    ]);
  });
});
