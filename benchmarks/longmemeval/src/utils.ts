export const stableJson = (value: unknown): string => {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort(), 2);
};

export const estimateTokens = (value: string): number => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
};

export const formatNumber = (value: number, digits = 3): string => {
  return value.toFixed(digits);
};

export const mean = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
};
