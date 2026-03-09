import { createTimestamp, type Timestamp } from '@ledgermind/domain';

export const SYSTEM_PROMPT_STORAGE_PREFIX = '__SYSTEM_PROMPT__';

export const toTimestamp = (value: string | Date): Timestamp => {
  return createTimestamp(value instanceof Date ? value : new Date(value));
};

export const toJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

export const toJsonStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
};

export const isStoredSystemPrompt = (value: string): boolean => {
  return value.startsWith(SYSTEM_PROMPT_STORAGE_PREFIX);
};

export const fromSystemPromptStorageValue = (value: string): string => {
  if (!isStoredSystemPrompt(value)) {
    return value;
  }

  return value.slice(SYSTEM_PROMPT_STORAGE_PREFIX.length);
};

export const arrayEquals = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
};
