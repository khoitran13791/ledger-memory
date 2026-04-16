import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { NewLedgerEvent } from '@ledgermind/application';
import type { MessageRole } from '@ledgermind/domain';

import { withEstimatedTokenCount } from './runtime';

interface TranscriptMetadata {
  readonly source: string;
  readonly hook: string;
  readonly trigger?: string;
}

export interface ParsedTranscript {
  readonly digest: string;
  readonly events: readonly NewLedgerEvent[];
  readonly lineCount: number;
}

interface ParseTranscriptOptions {
  readonly startLine?: number;
  readonly onWarning?: (message: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMessageRole = (value: unknown): value is MessageRole =>
  value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';

const extractText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length === 0 ? undefined : normalized;
  }

  if (Array.isArray(value)) {
    const collected = value
      .map((item) => extractText(isRecord(item) && 'text' in item ? item.text : item))
      .filter((item): item is string => item !== undefined)
      .join('\n')
      .trim();

    return collected.length === 0 ? undefined : collected;
  }

  if (isRecord(value) && 'text' in value) {
    return extractText(value.text);
  }

  return undefined;
};

const toTranscriptEvent = (
  record: Record<string, unknown>,
  metadata: TranscriptMetadata,
): NewLedgerEvent | undefined => {
  const messageRecord = isRecord(record.message) ? record.message : record;
  const roleCandidate = messageRecord.role ?? record.role ?? record.type;
  const contentCandidate = messageRecord.content ?? record.content ?? messageRecord.text ?? record.text;

  if (!isMessageRole(roleCandidate)) {
    return undefined;
  }

  const content = extractText(contentCandidate);
  if (content === undefined) {
    return undefined;
  }

  return withEstimatedTokenCount({
    role: roleCandidate,
    content,
    metadata: {
      source: metadata.source,
      hook: metadata.hook,
      ...(metadata.trigger === undefined ? {} : { trigger: metadata.trigger }),
    },
  });
};

export const parseTranscriptFile = async (
  transcriptPath: string,
  metadata: TranscriptMetadata,
  options: ParseTranscriptOptions = {},
): Promise<ParsedTranscript> => {
  const contents = await readFile(transcriptPath, 'utf8');
  const lines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const startLine =
    options.startLine !== undefined && options.startLine >= 0 && options.startLine <= lines.length
      ? options.startLine
      : 0;

  const events = lines.slice(startLine).flatMap((line, index) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const event = toTranscriptEvent(record, metadata);
      return event === undefined ? [] : [event];
    } catch {
      options.onWarning?.(`Skipped malformed transcript line ${startLine + index + 1} from ${transcriptPath}.`);
      return [];
    }
  });

  return {
    digest: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    events,
    lineCount: lines.length,
  };
};
