import { readFile } from 'node:fs/promises';

export interface ExtractedContinuityHandoff {
  readonly goal: string;
  readonly completed: readonly string[];
  readonly nextSteps: readonly string[];
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
  readonly verification: readonly string[];
  readonly risks: readonly string[];
  readonly changedFiles: readonly string[];
}

export interface ExtractContinuityHandoffInput {
  readonly transcriptPath: string;
  readonly sessionId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]+/gu,
  /ghp_[A-Za-z0-9_]+/gu,
  /postgres:\/\/[^\s]+/gu,
  /mongodb(\+srv)?:\/\/[^\s]+/gu,
  /AKIA[0-9A-Z]{16}/gu,
];

const MAX_HANDOFF_LINE_CHARS = 240;

const redactSecrets = (value: string): string =>
  SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value);

const sanitizeHandoffLine = (value: string): string | undefined => {
  const sanitized = redactSecrets(value)
    .replace(/^(human|user|assistant)\s*:\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();

  if (sanitized.length === 0) {
    return undefined;
  }

  return sanitized.length <= MAX_HANDOFF_LINE_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_HANDOFF_LINE_CHARS - 3).trimEnd()}...`;
};

const extractText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((item) => extractText(isRecord(item) && 'text' in item ? item.text : item))
      .filter((item): item is string => item !== undefined)
      .join('\n')
      .trim();
    return joined.length === 0 ? undefined : joined;
  }

  if (isRecord(value) && 'text' in value) {
    return extractText(value.text);
  }

  return undefined;
};

const extractRecordText = (record: Record<string, unknown>): string | undefined => {
  const message = isRecord(record.message) ? record.message : record;
  return extractText(message.content ?? record.content ?? message.text ?? record.text);
};

const readRole = (record: Record<string, unknown>): string | undefined => {
  const message = isRecord(record.message) ? record.message : record;
  const role = message.role ?? record.role;
  return typeof role === 'string' ? role.toLowerCase() : undefined;
};

const addUnique = (target: string[], value: string | undefined): void => {
  const trimmed = value === undefined ? undefined : sanitizeHandoffLine(value);
  if (trimmed !== undefined && trimmed.length > 0 && !target.includes(trimmed)) {
    target.push(trimmed);
  }
};

const includesAny = (value: string, needles: readonly string[]): boolean => {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
};

const isUserPromptGoalCandidate = (value: string): boolean =>
  !includesAny(value, ['next', 'todo', 'remaining', 'follow up']);

const readPath = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const path =
    value.file_path ?? value.filePath ?? value.path ?? value.absolute_path ?? value.absolutePath;
  return typeof path === 'string' && path.trim().length > 0 ? path.trim() : undefined;
};

const extractChangedFile = (record: Record<string, unknown>): string | undefined =>
  readPath(record.tool_input) ?? readPath(record.toolInput) ?? readPath(record.input);

export const extractContinuityHandoffFromTranscript = async ({
  transcriptPath,
  sessionId,
}: ExtractContinuityHandoffInput): Promise<ExtractedContinuityHandoff> => {
  const contents = await readFile(transcriptPath, 'utf8');
  const nextSteps: string[] = [];
  const decisions: string[] = [];
  const constraints: string[] = [];
  const openQuestions: string[] = [];
  const verification: string[] = [];
  const risks: string[] = [];
  const completed: string[] = [];
  const changedFiles: string[] = [];
  let goal: string | undefined;

  for (const line of contents.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmedLine) as Record<string, unknown>;
    } catch {
      continue;
    }

    addUnique(changedFiles, extractChangedFile(record));

    const role = readRole(record);
    const recordText = extractRecordText(record);
    if (role === 'user' && goal === undefined && recordText !== undefined) {
      const firstPromptLine = recordText
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .find((item) => item.length > 0 && isUserPromptGoalCandidate(item));

      goal = sanitizeHandoffLine(firstPromptLine ?? '');
    }

    const text = role === undefined || role === 'assistant' ? recordText : undefined;
    if (text === undefined) {
      continue;
    }

    for (const textLine of text
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean)) {
      goal ??= sanitizeHandoffLine(textLine);

      if (includesAny(textLine, ['next', 'todo', 'remaining', 'follow up'])) {
        addUnique(nextSteps, textLine);
      }
      if (includesAny(textLine, ['decided', 'decision', 'we will', 'we chose'])) {
        addUnique(decisions, textLine);
      }
      if (includesAny(textLine, ['must', 'cannot', 'do not', 'constraint', 'requirement'])) {
        addUnique(constraints, textLine);
      }
      if (includesAny(textLine, ['passed', 'failed', 'test', 'typecheck', 'lint', 'verify'])) {
        addUnique(verification, textLine);
      }
      if (includesAny(textLine, ['open question', 'unclear', 'unknown', 'question'])) {
        addUnique(openQuestions, textLine);
      }
      if (includesAny(textLine, ['risk', 'risky', 'blocked', 'blocker'])) {
        addUnique(risks, textLine);
      }
      if (includesAny(textLine, ['done', 'completed', 'implemented', 'fixed', 'added'])) {
        addUnique(completed, textLine);
      }
    }
  }

  return {
    goal: goal ?? `Continue work from Claude Code session ${sessionId}`,
    completed,
    nextSteps,
    decisions,
    constraints,
    openQuestions,
    verification,
    risks,
    changedFiles,
  };
};
