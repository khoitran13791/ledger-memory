import type { MessageRole } from '@ledgermind/domain';

import type { LocomoConversationSample } from './types.js';
import { estimateTokens } from './utils.js';

interface RawConversationTurn {
  readonly speaker?: unknown;
  readonly dia_id?: unknown;
  readonly text?: unknown;
  readonly blip_caption?: unknown;
}

export interface LocomoTurn {
  readonly session: number;
  readonly dateTime: string;
  readonly diaId: string;
  readonly speaker: string;
  readonly text: string;
  readonly blipCaption?: string;
}

export const hasArtifactLikeContent = (turn: LocomoTurn): boolean => {
  return turn.blipCaption !== undefined;
};

export interface ContextLine {
  readonly id: string;
  readonly text: string;
  readonly tokenEstimate: number;
}

const getSessionNumbers = (conversation: Readonly<Record<string, unknown>>): readonly number[] => {
  const sessionNumbers: number[] = [];

  for (const key of Object.keys(conversation)) {
    const match = key.match(/^session_(\d+)$/);
    if (match?.[1] === undefined) {
      continue;
    }

    const value = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(value) && value > 0) {
      sessionNumbers.push(value);
    }
  }

  return Object.freeze([...new Set(sessionNumbers)].sort((left, right) => left - right));
};

const ensureString = (value: unknown, fallback: string): string => {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
};

export const extractTurns = (sample: LocomoConversationSample): readonly LocomoTurn[] => {
  const conversation = sample.conversation as Readonly<Record<string, unknown>>;
  const sessionNumbers = getSessionNumbers(conversation);
  const turns: LocomoTurn[] = [];

  for (const session of sessionNumbers) {
    const dateTime = ensureString(conversation[`session_${session}_date_time`], `session_${session}`);
    const rawTurns = conversation[`session_${session}`];

    if (!Array.isArray(rawTurns)) {
      continue;
    }

    rawTurns.forEach((rawTurn, turnIndex) => {
      const turn = rawTurn as RawConversationTurn;
      const diaId = ensureString(turn.dia_id, `S${session}:${turnIndex + 1}`);
      const speaker = ensureString(turn.speaker, 'Unknown');
      const text = ensureString(turn.text, '');

      if (text.length === 0) {
        return;
      }

      const blipCaption =
        typeof turn.blip_caption === 'string' && turn.blip_caption.trim().length > 0
          ? turn.blip_caption.trim()
          : undefined;

      turns.push({
        session,
        dateTime,
        diaId,
        speaker,
        text,
        ...(blipCaption === undefined ? {} : { blipCaption }),
      });
    });
  }

  return Object.freeze(turns);
};

export const formatTurnLine = (turn: LocomoTurn): string => {
  const base = `DATE: ${turn.dateTime} | ID: ${turn.diaId} | ${turn.speaker} said, "${turn.text}"`;

  if (turn.blipCaption === undefined) {
    return base;
  }

  return `${base} and shared ${turn.blipCaption}`;
};

export const buildContextLines = (sample: LocomoConversationSample): readonly ContextLine[] => {
  return Object.freeze(
    extractTurns(sample).map((turn) => {
      const text = formatTurnLine(turn);
      return {
        id: turn.diaId,
        text,
        tokenEstimate: estimateTokens(text),
      };
    }),
  );
};

export const mapSpeakersToRoles = (turns: readonly LocomoTurn[]): ReadonlyMap<string, MessageRole> => {
  const orderedSpeakers: string[] = [];

  for (const turn of turns) {
    if (!orderedSpeakers.includes(turn.speaker)) {
      orderedSpeakers.push(turn.speaker);
    }
  }

  const roles: MessageRole[] = ['user', 'assistant', 'tool'];
  const mapping = new Map<string, MessageRole>();

  orderedSpeakers.forEach((speaker, index) => {
    mapping.set(speaker, roles[index] ?? 'assistant');
  });

  return mapping;
};
