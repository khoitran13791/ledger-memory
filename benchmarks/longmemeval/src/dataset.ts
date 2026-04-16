import { readFile } from 'node:fs/promises';

import type {
  LongMemEvalExample,
  LongMemEvalHistorySession,
  LongMemEvalHistoryTurn,
  LongMemEvalOfficialExample,
  LongMemEvalOfficialTurn,
} from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const requireString = (value: unknown, fieldName: string, exampleId: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`LongMemEval example ${exampleId} is missing required field ${fieldName}`);
  }

  return value;
};

const requireStringAllowingEmpty = (value: unknown, fieldName: string, exampleId: string): string => {
  if (typeof value !== 'string' || (value !== '' && value.trim().length === 0)) {
    throw new Error(`LongMemEval example ${exampleId} is missing required field ${fieldName}`);
  }

  return value;
};

const requireScalarString = (value: unknown, fieldName: string, exampleId: string): string => {
  if (typeof value === 'string') {
    return requireString(value, fieldName, exampleId);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  throw new Error(`LongMemEval example ${exampleId} is missing required field ${fieldName}`);
};

const requireStringArray = (value: unknown, fieldName: string, exampleId: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`LongMemEval example ${exampleId} is missing required field ${fieldName}`);
  }

  return value;
};

const normalizeTurn = (input: {
  readonly exampleId: string;
  readonly sessionId: string;
  readonly turn: LongMemEvalOfficialTurn;
  readonly turnIndex: number;
}): LongMemEvalHistoryTurn => {
  return {
    turnId: `${input.sessionId}#turn-${input.turnIndex}`,
    role: requireString(input.turn.role, `haystack_sessions turn role at ${input.sessionId}[${input.turnIndex}]`, input.exampleId),
    content: requireStringAllowingEmpty(
      input.turn.content,
      `haystack_sessions turn content at ${input.sessionId}[${input.turnIndex}]`,
      input.exampleId,
    ),
    sourceIndex: input.turnIndex,
    hasAnswer: input.turn.has_answer === true,
  };
};

export const normalizeLongMemEvalExample = (input: LongMemEvalOfficialExample): LongMemEvalExample => {
  const exampleId = requireString(input.question_id, 'question_id', '<unknown>');
  const questionType = requireString(input.question_type, 'question_type', exampleId);
  const question = requireString(input.question, 'question', exampleId);
  const answer = requireScalarString(input.answer, 'answer', exampleId);
  const questionDate = requireString(input.question_date, 'question_date', exampleId);
  const haystackSessionIds = requireStringArray(input.haystack_session_ids, 'haystack_session_ids', exampleId);
  const haystackDates = requireStringArray(input.haystack_dates, 'haystack_dates', exampleId);

  if (!Array.isArray(input.haystack_sessions)) {
    throw new Error(`LongMemEval example ${exampleId} is missing required field haystack_sessions`);
  }

  if (
    haystackSessionIds.length !== haystackDates.length ||
    haystackSessionIds.length !== input.haystack_sessions.length
  ) {
    throw new Error(`LongMemEval example ${exampleId} has mismatched haystack lengths`);
  }

  const history: LongMemEvalHistorySession[] = input.haystack_sessions.map((sessionTurns, sessionIndex) => {
    const sessionId = requireString(haystackSessionIds[sessionIndex], `haystack_session_ids[${sessionIndex}]`, exampleId);
    const sessionDate = requireString(haystackDates[sessionIndex], `haystack_dates[${sessionIndex}]`, exampleId);

    if (!Array.isArray(sessionTurns) || sessionTurns.some((turn) => !isRecord(turn))) {
      throw new Error(`LongMemEval example ${exampleId} has invalid turns for session ${sessionId}`);
    }

    return {
      sessionId,
      sessionDate,
      sourceIndex: sessionIndex,
      turns: sessionTurns.map((turn, turnIndex) =>
        normalizeTurn({
          exampleId,
          sessionId,
          turn: turn as LongMemEvalOfficialTurn,
          turnIndex,
        }),
      ),
    };
  });

  const goldEvidenceIds =
    input.answer_session_ids === undefined
      ? undefined
      : requireStringArray(input.answer_session_ids, 'answer_session_ids', exampleId);

  return {
    exampleId,
    question,
    answer,
    history,
    ...(goldEvidenceIds === undefined || goldEvidenceIds.length === 0 ? {} : { goldEvidenceIds }),
    metadata: {
      questionType,
      questionDate,
      haystackSessionIds,
      haystackDates,
    },
  };
};

const parseDatasetFile = (rawText: string): readonly LongMemEvalOfficialExample[] => {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('LongMemEval dataset JSON must contain an array of examples');
    }

    return parsed as readonly LongMemEvalOfficialExample[];
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LongMemEvalOfficialExample);
};

export const loadLongMemEvalDataset = async (datasetPath: string): Promise<readonly LongMemEvalExample[]> => {
  const rawText = await readFile(datasetPath, 'utf8');
  return parseDatasetFile(rawText).map(normalizeLongMemEvalExample);
};
