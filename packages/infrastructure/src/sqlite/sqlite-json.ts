import { InvariantViolationError } from '@ledgermind/domain';

export const parseSqliteJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

export const parseSqliteJsonArray = (value: unknown): unknown[] => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
};

export const stringifySqliteJson = (value: unknown): string => JSON.stringify(value ?? null);

export const parseSqliteInteger = (value: unknown, fieldName: string): number => {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;

  if (!Number.isSafeInteger(parsed)) {
    throw new InvariantViolationError(`Invalid ${fieldName} from SQLite row.`);
  }

  return parsed;
};
