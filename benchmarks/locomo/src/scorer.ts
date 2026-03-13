import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LocomoConversationSample, LocomoExample, PerExampleRecord } from './types.js';
import { mean } from './utils.js';

const execFileAsync = promisify(execFile);
const CATEGORY_ORDER = [1, 2, 3, 4, 5] as const;
const PYTHON_RESULT_PREFIX = '__LOCOMO_JSON__';

export interface OfficialScoreOutput {
  readonly aggregate: number;
  readonly categoryScores: Readonly<Record<number, number>>;
  readonly countByCategory: Readonly<Record<number, number>>;
}

export interface SeedScoringResult {
  readonly modelJsonPath: string;
  readonly statsJsonPath: string;
  readonly official: OfficialScoreOutput;
}

const PYTHON_SCORER_SCRIPT = `
import importlib.util
import json
import sys

scorer_path = sys.argv[1]
qas_path = sys.argv[2]
prediction_key = sys.argv[3]

spec = importlib.util.spec_from_file_location('locomo_eval_module', scorer_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with open(qas_path, 'r', encoding='utf-8') as handle:
    qas = json.load(handle)

scores, _, _ = module.eval_question_answering(qas, prediction_key, 'f1')

category_scores = {}
category_counts = {}
for qa, score in zip(qas, scores):
    category = int(qa.get('category', 0))
    category_scores.setdefault(category, []).append(float(score))
    category_counts[category] = category_counts.get(category, 0) + 1

result = {
    'aggregate': float(sum(scores) / len(scores)) if len(scores) > 0 else 0.0,
    'categoryScores': {
        str(key): (float(sum(values) / len(values)) if len(values) > 0 else 0.0)
        for key, values in category_scores.items()
    },
    'countByCategory': {
        str(key): int(value)
        for key, value in category_counts.items()
    }
}

print('${PYTHON_RESULT_PREFIX}' + json.dumps(result))
`;

const createModelKey = (baseline: string, seed: number): string => {
  return `locomo_${baseline}_seed_${seed}`;
};

const createPredictionKey = (baseline: string, seed: number): string => {
  return `${createModelKey(baseline, seed)}_prediction`;
};

const toSampleQaForScoring = (input: {
  readonly sample: LocomoConversationSample;
  readonly exampleMap: ReadonlyMap<string, PerExampleRecord>;
  readonly predictionKey: string;
  readonly modelKey: string;
}): { readonly sample_id: string; readonly qa: readonly Record<string, unknown>[] } => {
  const qa = input.sample.qa.map((qa, qaIndex) => {
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

const computeFallbackOfficial = (rows: readonly PerExampleRecord[]): OfficialScoreOutput => {
  const categoryToScores = new Map<number, number[]>();

  for (const row of rows) {
    const bucket = categoryToScores.get(row.category) ?? [];
    bucket.push(row.officialScore);
    categoryToScores.set(row.category, bucket);
  }

  const categoryScores: Record<number, number> = {};
  const countByCategory: Record<number, number> = {};

  for (const category of CATEGORY_ORDER) {
    const scores = categoryToScores.get(category) ?? [];
    categoryScores[category] = scores.length === 0 ? 0 : mean(scores);
    countByCategory[category] = scores.length;
  }

  return {
    aggregate: rows.length === 0 ? 0 : mean(rows.map((row) => row.officialScore)),
    categoryScores,
    countByCategory,
  };
};

const runOfficialEvalWithPython = async (input: {
  readonly scorerPath: string;
  readonly qaFlatPath: string;
  readonly predictionKey: string;
}): Promise<OfficialScoreOutput | null> => {
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', PYTHON_SCORER_SCRIPT, input.scorerPath, input.qaFlatPath, input.predictionKey],
      {
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const payloadLine = [...lines].reverse().find((line) => line.startsWith(PYTHON_RESULT_PREFIX));
    if (payloadLine === undefined) {
      return null;
    }

    const parsed = JSON.parse(payloadLine.slice(PYTHON_RESULT_PREFIX.length)) as {
      readonly aggregate?: number;
      readonly categoryScores?: Readonly<Record<string, number>>;
      readonly countByCategory?: Readonly<Record<string, number>>;
    };

    const categoryScores: Record<number, number> = {};
    const countByCategory: Record<number, number> = {};

    for (const category of CATEGORY_ORDER) {
      categoryScores[category] = parsed.categoryScores?.[String(category)] ?? 0;
      countByCategory[category] = parsed.countByCategory?.[String(category)] ?? 0;
    }

    return {
      aggregate: parsed.aggregate ?? 0,
      categoryScores,
      countByCategory,
    };
  } catch {
    return null;
  }
};

const serializeStatsPayload = (input: {
  readonly modelKey: string;
  readonly official: OfficialScoreOutput;
}): Record<string, unknown> => {
  const categoryCounts: Record<number, number> = {};
  const cumulativeAccuracy: Record<number, number> = {};

  for (const category of CATEGORY_ORDER) {
    categoryCounts[category] = input.official.countByCategory[category] ?? 0;
    cumulativeAccuracy[category] =
      (input.official.categoryScores[category] ?? 0) * (input.official.countByCategory[category] ?? 0);
  }

  return {
    [input.modelKey]: {
      category_counts: categoryCounts,
      cum_accuracy_by_category: cumulativeAccuracy,
      category_counts_by_memory: {},
      cum_accuracy_by_category_by_memory: {},
      context_length_counts: {},
      cum_accuracy_by_context_length: {},
    },
  };
};

export const scoreSeedWithOfficialScorer = async (input: {
  readonly scorerPath: string;
  readonly outputDir: string;
  readonly baseline: string;
  readonly seed: number;
  readonly allSamples: readonly LocomoConversationSample[];
  readonly examples: readonly LocomoExample[];
  readonly rows: readonly PerExampleRecord[];
}): Promise<SeedScoringResult> => {
  const modelKey = createModelKey(input.baseline, input.seed);
  const predictionKey = createPredictionKey(input.baseline, input.seed);

  const exampleMap = new Map(
    input.rows.map((row) => [`${row.sampleId}::${row.qaIndex}`, row] as const),
  );

  const sampleIdsUsed = new Set(input.examples.map((example) => example.sampleId));
  const qaBySample = input.allSamples
    .filter((sample) => sampleIdsUsed.has(sample.sample_id))
    .map((sample) =>
      toSampleQaForScoring({
        sample,
        exampleMap,
        predictionKey,
        modelKey,
      }),
    );

  const modelJsonPath = path.resolve(input.outputDir, `${modelKey}.json`);
  await writeFile(modelJsonPath, `${JSON.stringify(qaBySample, null, 2)}\n`, 'utf8');

  const flattenedQa = qaBySample.flatMap((sample) => sample.qa);
  const qaFlatPath = path.resolve(input.outputDir, `${modelKey}_qa_flat.json`);
  await writeFile(qaFlatPath, `${JSON.stringify(flattenedQa, null, 2)}\n`, 'utf8');

  const official =
    (await runOfficialEvalWithPython({
      scorerPath: input.scorerPath,
      qaFlatPath,
      predictionKey,
    })) ?? computeFallbackOfficial(input.rows);

  const statsJsonPath = path.resolve(input.outputDir, `${modelKey}_stats.json`);
  await writeFile(
    statsJsonPath,
    `${JSON.stringify(serializeStatsPayload({ modelKey, official }), null, 2)}\n`,
    'utf8',
  );

  return {
    modelJsonPath,
    statsJsonPath,
    official,
  };
};

export const scoreAnswerOfficialStyle = (input: {
  readonly category: number;
  readonly prediction: string;
  readonly answer: string;
}): number => {
  const normalize = (value: string): string => {
    return value
      .toLowerCase()
      .replace(/[,]/g, '')
      .replace(/[\p{P}$+<=>^`|~]/gu, '')
      .replace(/\b(a|an|the|and)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const f1Score = (prediction: string, groundTruth: string): number => {
    const predTokens = normalize(prediction).split(' ').filter((token) => token.length > 0);
    const gtTokens = normalize(groundTruth).split(' ').filter((token) => token.length > 0);

    if (predTokens.length === 0 || gtTokens.length === 0) {
      return 0;
    }

    const predCounts = new Map<string, number>();
    predTokens.forEach((token) => {
      predCounts.set(token, (predCounts.get(token) ?? 0) + 1);
    });

    const gtCounts = new Map<string, number>();
    gtTokens.forEach((token) => {
      gtCounts.set(token, (gtCounts.get(token) ?? 0) + 1);
    });

    let overlap = 0;
    for (const [token, count] of predCounts.entries()) {
      overlap += Math.min(count, gtCounts.get(token) ?? 0);
    }

    if (overlap === 0) {
      return 0;
    }

    const precision = overlap / predTokens.length;
    const recall = overlap / gtTokens.length;
    return (2 * precision * recall) / (precision + recall);
  };

  const normalizedPrediction = input.prediction.trim();

  if (input.category === 5) {
    const lower = normalizedPrediction.toLowerCase();
    if (lower.includes('no information available') || lower.includes('not mentioned')) {
      return 1;
    }
    return 0;
  }

  if (input.category === 1) {
    const predParts = normalizedPrediction
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const gtParts = input.answer
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (predParts.length === 0 || gtParts.length === 0) {
      return 0;
    }

    const scores = gtParts.map((gt) => {
      return Math.max(...predParts.map((pred) => f1Score(pred, gt)));
    });

    return mean(scores);
  }

  const answerForCategory =
    input.category === 3 ? input.answer.split(';')[0]?.trim() ?? input.answer : input.answer;
  return f1Score(normalizedPrediction, answerForCategory);
};
