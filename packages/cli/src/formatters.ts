export const asJsonLine = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const bullet = (label: string, value: string | number): string => `${label}: ${value}\n`;

export const errorJsonLine = (error: unknown): string =>
  `${JSON.stringify({
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
    },
  })}\n`;
