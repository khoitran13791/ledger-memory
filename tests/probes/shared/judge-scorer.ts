import type { MaterializeContextOutput } from '@ledgermind/application';

import type { ProbeFixture } from './probe-fixture';

export interface ProbeJudgeResult {
  readonly passed: boolean;
  readonly score: number;
  readonly maxScore: number;
  readonly reasons: readonly string[];
}

const normalizeText = (value: string): string => {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
};

const toTokens = (value: string): readonly string[] => {
  return normalizeText(value)
    .split(/[^a-z0-9_.:/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
};

const tokenCoverage = (answer: string, expected: string): number => {
  const expectedTokens = [...new Set(toTokens(expected))];
  if (expectedTokens.length === 0) {
    return 0;
  }

  const answerTokens = new Set(toTokens(answer));
  const matched = expectedTokens.filter((token) => answerTokens.has(token));
  return matched.length / expectedTokens.length;
};

const hasMemoryExpandSuggestion = (answer: string): boolean => {
  const normalized = normalizeText(answer);
  return normalized.includes('memory.expand') || normalized.includes('expand(');
};

const hasMemoryDescribeSuggestion = (answer: string): boolean => {
  const normalized = normalizeText(answer);
  return normalized.includes('memory.describe') || normalized.includes('describe(');
};

const hasMemoryGrepSuggestion = (answer: string): boolean => {
  const normalized = normalizeText(answer);
  return normalized.includes('memory.grep') || normalized.includes('grep(');
};

const includesAnyReferenceId = (answer: string): boolean => {
  const normalized = normalizeText(answer);
  return normalized.includes('sum_') || normalized.includes('file_');
};

const isExactEnough = (answer: string, expected: string): boolean => {
  const normalizedAnswer = normalizeText(answer);
  const normalizedExpected = normalizeText(expected);

  if (normalizedAnswer.includes(normalizedExpected)) {
    return true;
  }

  const coverage = tokenCoverage(answer, expected);
  if (coverage >= 0.85) {
    return true;
  }

  const expectedStepMatch = normalizedExpected.match(/step\s*(\d+)/i);
  const answerStepMatch = normalizedAnswer.match(/step\s*(\d+)/i);

  if (expectedStepMatch?.[1] !== undefined && answerStepMatch?.[1] !== undefined) {
    if (expectedStepMatch[1] === answerStepMatch[1] && normalizedAnswer.includes('write tests')) {
      return true;
    }
  }

  return false;
};

const judgeRecallLike = (fixture: Extract<ProbeFixture, { readonly type: 'recall' | 'continuation' | 'decision' }>, answer: string): ProbeJudgeResult => {
  const reasons: string[] = [];
  const exactEnough = isExactEnough(answer, fixture.expectedAnswer);
  const coverage = tokenCoverage(answer, fixture.expectedAnswer);

  if (!exactEnough) {
    reasons.push(
      `Answer does not sufficiently match expected answer. coverage=${coverage.toFixed(2)} expected>=0.85 or direct phrase match.`,
    );
  }

  const score = exactEnough ? 5 : coverage >= 0.6 ? 3 : coverage >= 0.3 ? 2 : 1;

  return {
    passed: exactEnough,
    score,
    maxScore: 5,
    reasons,
  };
};

const judgeArtifact = (
  fixture: Extract<ProbeFixture, { readonly type: 'artifact' }>,
  answer: string,
  materialized: MaterializeContextOutput,
): ProbeJudgeResult => {
  const reasons: string[] = [];
  let score = 0;

  const exactEnough = isExactEnough(answer, fixture.expectedAnswer);
  if (exactEnough) {
    score += 3;
  } else {
    reasons.push('Artifact probe answer missed expected concrete value.');
    const coverage = tokenCoverage(answer, fixture.expectedAnswer);
    if (coverage >= 0.6) {
      score += 2;
    } else if (coverage >= 0.3) {
      score += 1;
    }
  }

  if (fixture.requiresArtifactReference) {
    const referencesAvailable = materialized.artifactReferences.length > 0 || materialized.summaryReferences.length > 0;
    const referencesUsed = includesAnyReferenceId(answer) || hasMemoryDescribeSuggestion(answer) || hasMemoryExpandSuggestion(answer);

    if (referencesUsed) {
      score += 2;
    } else {
      reasons.push('Artifact probe answer did not include artifact/summary reference or describe/expand suggestion.');
      if (referencesAvailable) {
        score += 1;
      }
    }
  } else {
    score += 2;
  }

  return {
    passed: score >= 4,
    score,
    maxScore: 5,
    reasons,
  };
};

const judgeToolUsage = (
  fixture: Extract<ProbeFixture, { readonly type: 'tool_usage' }>,
  answer: string,
  materialized: MaterializeContextOutput,
): ProbeJudgeResult => {
  const reasons: string[] = [];
  let score = 0;

  const hasExpand = hasMemoryExpandSuggestion(answer);
  if (hasExpand) {
    score += 3;
  } else {
    reasons.push('Tool-usage answer must recommend memory.expand for exact detail recovery.');
  }

  if (hasMemoryGrepSuggestion(answer) || hasMemoryDescribeSuggestion(answer)) {
    score += 1;
  } else {
    reasons.push('Tool-usage answer should mention grep or describe as supporting tools.');
  }

  const referencesAvailable = materialized.summaryReferences.length > 0 || materialized.artifactReferences.length > 0;
  if (!referencesAvailable || includesAnyReferenceId(answer)) {
    score += 1;
  } else {
    reasons.push('Tool-usage answer should include a concrete summary/artifact ID when available.');
  }

  const expectedCoverage = tokenCoverage(answer, fixture.expectedBehavior);
  if (expectedCoverage < 0.15) {
    reasons.push('Tool-usage answer only weakly aligns with expected behavior statement.');
  }

  return {
    passed: score >= 4,
    score,
    maxScore: 5,
    reasons,
  };
};

export const judgeProbeAnswer = (input: {
  readonly fixture: ProbeFixture;
  readonly answer: string;
  readonly materialized: MaterializeContextOutput;
}): ProbeJudgeResult => {
  const { fixture, answer, materialized } = input;

  if (fixture.type === 'artifact') {
    return judgeArtifact(fixture, answer, materialized);
  }

  if (fixture.type === 'tool_usage') {
    return judgeToolUsage(fixture, answer, materialized);
  }

  return judgeRecallLike(fixture, answer);
};
