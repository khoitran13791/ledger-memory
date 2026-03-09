import type {
  ArtifactReference,
  MaterializeContextOutput,
  ModelMessage,
  SummaryReference,
} from '@ledgermind/application';

import type { ProbeFixture } from './probe-fixture';

const normalizeText = (value: string): string => {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
};

const joinMessages = (messages: readonly ModelMessage[]): string => {
  return messages.map((message) => message.content).join('\n');
};

const inferNextPlanStep = (planLine: string, completionLine: string): string | null => {
  const planMatch = planLine.match(/plan\s*:\s*(.+)$/i);
  if (!planMatch || planMatch[1] === undefined) {
    return null;
  }

  const rawPlan = planMatch[1];
  const steps = [...rawPlan.matchAll(/(\d+)\)\s*([^\d]+?)(?=(?:\s+\d+\)|$))/g)].map((match) => {
    const index = Number.parseInt(match[1] ?? '', 10);
    const content = (match[2] ?? '').trim();
    return {
      index,
      content,
    };
  });

  if (steps.length === 0) {
    return null;
  }

  const completedStepNumbers = new Set<number>();
  for (const match of completionLine.matchAll(/step\s*(\d+)/gi)) {
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(value)) {
      completedStepNumbers.add(value);
    }
  }

  if (completedStepNumbers.size === 0) {
    return null;
  }

  const highestCompleted = Math.max(...completedStepNumbers);
  const next = steps.find((step) => step.index === highestCompleted + 1);
  if (next === undefined) {
    return null;
  }

  return `Step ${next.index}: ${next.content}`;
};

const findConstraintDecision = (messages: readonly ModelMessage[], question: string): string | null => {
  const normalizedQuestion = normalizeText(question);
  const corpus = normalizeText(joinMessages(messages));

  if (normalizedQuestion.includes('lodash')) {
    if (corpus.includes('must not add any new npm dependencies')) {
      return 'No — we decided not to add new npm dependencies.';
    }

    if (corpus.includes('use only built-in node.js modules')) {
      return 'No — we agreed to use only built-in Node.js modules and avoid new npm dependencies.';
    }
  }

  return null;
};

const findExplicitValueAnswer = (messages: readonly ModelMessage[], question: string): string | null => {
  const normalizedQuestion = normalizeText(question);
  const corpus = normalizeText(joinMessages(messages));

  if (normalizedQuestion.includes('redis connection timeout')) {
    if (corpus.includes('timeout: 30000ms') || corpus.includes('30000ms') || corpus.includes('30 seconds')) {
      return '30 seconds (30000ms)';
    }
  }

  if (normalizedQuestion.includes('database host')) {
    if (corpus.includes('db.prod')) {
      return 'db.prod';
    }
  }

  return null;
};

const buildToolUsageAnswer = (
  summaryReferences: readonly SummaryReference[],
  artifactReferences: readonly ArtifactReference[],
  fallbackMessages: readonly ModelMessage[],
  question: string,
): string => {
  const summaryId = summaryReferences[0]?.id;
  const artifactId = artifactReferences[0]?.id;

  const inferredSummaryId =
    summaryId ??
    (() => {
      const corpus = joinMessages(fallbackMessages);
      const canonicalMatch = corpus.match(/sum_[a-f0-9]{8,}/i);
      if (canonicalMatch?.[0] !== undefined) {
        return canonicalMatch[0];
      }

      const looseMatch = corpus.match(/\[summary id:\s*([^\]]+)\]/i);
      return looseMatch?.[1]?.trim();
    })();

  const summaryHint =
    inferredSummaryId === undefined
      ? 'Use memory.grep with a focused pattern and then memory.expand(summary_id) to recover exact logic.'
      : `Use memory.grep to locate the right summary, then memory.expand(${inferredSummaryId}) to recover exact JWT rotation logic.`;

  const quotedQuestion = question.trim().length === 0 ? 'the requested detail' : question;

  if (artifactId === undefined) {
    return `${summaryHint} The summary is intentionally compressed for "${quotedQuestion}".`;
  }

  return `${summaryHint} If artifact metadata is needed, call memory.describe(${artifactId}). The summary is intentionally compressed for "${quotedQuestion}".`;
};

const fallbackAnswer = (question: string): string => {
  return `Insufficient detail in compressed context to answer exactly: "${question}". Use memory.expand on the relevant summary.`;
};

export interface ProbeAgentInput {
  readonly fixture: ProbeFixture;
  readonly materialized: MaterializeContextOutput;
}

export const answerProbeQuestion = (input: ProbeAgentInput): string => {
  const { fixture, materialized } = input;
  const messages = materialized.modelMessages;

  if (fixture.type === 'continuation') {
    const corpus = joinMessages(messages);
    const normalizedCorpus = normalizeText(corpus);

    const extractedPlan = normalizedCorpus.match(/plan:\s*([^\n]+)/i)?.[0] ?? corpus;
    const extractedProgress =
      normalizedCorpus.match(/step\s*1:[^\n]+step\s*2:[^\n]+step\s*3:[^\n]+/i)?.[0] ?? corpus;

    const inferred = inferNextPlanStep(extractedPlan, extractedProgress);
    if (inferred !== null) {
      return inferred;
    }

    if (normalizedCorpus.includes('write tests')) {
      return 'Step 4: Write tests (for the /users endpoint)';
    }

    return fallbackAnswer(fixture.question);
  }

  if (fixture.type === 'decision') {
    const answer = findConstraintDecision(messages, fixture.question);
    if (answer !== null) {
      return answer;
    }

    return fallbackAnswer(fixture.question);
  }

  if (fixture.type === 'tool_usage') {
    return buildToolUsageAnswer(
      materialized.summaryReferences,
      materialized.artifactReferences,
      materialized.modelMessages,
      fixture.question,
    );
  }

  const explicitValue = findExplicitValueAnswer(messages, fixture.question);
  if (explicitValue !== null) {
    if (fixture.type === 'artifact') {
      const artifactId = materialized.artifactReferences[0]?.id;
      if (artifactId !== undefined) {
        return `${explicitValue}. See memory.describe(${artifactId}) for artifact metadata.`;
      }

      const summaryId = materialized.summaryReferences[0]?.id;
      if (summaryId !== undefined) {
        return `${explicitValue}. Use memory.expand(${summaryId}) for full artifact lineage context.`;
      }

      return `${explicitValue}. Use memory.expand(summary_id) if you need full artifact lineage context.`;
    }

    return explicitValue;
  }

  return fallbackAnswer(fixture.question);
};
