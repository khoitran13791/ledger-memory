import { createHash } from 'node:crypto';

export const textEncoder = new TextEncoder();

export const estimateTokens = (text: string): number => {
  return Math.max(1, Math.ceil(text.length / 4));
};

export const clampString = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

export const sha256Hex = (value: string): string => {
  return createHash('sha256').update(value).digest('hex');
};

export const stableJson = (value: unknown): string => {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((item) => sort(item));
    }

    if (input !== null && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return Object.fromEntries(entries.map(([key, nested]) => [key, sort(nested)]));
    }

    return input;
  };

  return JSON.stringify(sort(value));
};

export const mean = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((acc, current) => acc + current, 0) / values.length;
};

export const sampleStd = (values: readonly number[]): number => {
  if (values.length <= 1) {
    return 0;
  }

  const m = mean(values);
  const variance =
    values.reduce((acc, current) => acc + (current - m) * (current - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
};

export const formatNumber = (value: number, digits = 3): string => {
  return value.toFixed(digits);
};

export const formatMeanStd = (values: readonly number[], digits = 3): string => {
  return `${formatNumber(mean(values), digits)} ± ${formatNumber(sampleStd(values), digits)}`;
};
