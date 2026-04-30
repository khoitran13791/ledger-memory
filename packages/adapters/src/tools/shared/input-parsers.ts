import type { CallerContext, MemoryEngine } from '@ledgermind/application';
import { createConversationId } from '@ledgermind/domain';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const assertValidMemoryEngine: (engine: unknown) => asserts engine is MemoryEngine = (
  engine: unknown,
): asserts engine is MemoryEngine => {
  if (!isRecord(engine)) {
    throw new TypeError('createCanonicalMemoryToolCatalog requires a valid MemoryEngine object.');
  }

  const requiredMethods = ['grep', 'describe', 'expand'] as const;

  for (const method of requiredMethods) {
    const candidate = engine[method];
    if (typeof candidate !== 'function') {
      throw new TypeError(
        `createCanonicalMemoryToolCatalog requires engine.${method}() to be a function.`,
      );
    }
  }
};

export const readRequiredString = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): string => {
  const raw = input[field];

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new TypeError(`${toolName} requires "${field}" as a non-empty string.`);
  }

  return raw;
};

export const readOptionalString = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): string | undefined => {
  if (!(field in input) || input[field] === undefined) {
    return undefined;
  }

  const raw = input[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new TypeError(
      `${toolName} expects optional "${field}" to be a non-empty string when provided.`,
    );
  }

  return raw;
};

export const readOptionalBoolean = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): boolean | undefined => {
  if (!(field in input) || input[field] === undefined) {
    return undefined;
  }

  const raw = input[field];
  if (typeof raw !== 'boolean') {
    throw new TypeError(`${toolName} expects optional "${field}" to be a boolean when provided.`);
  }

  return raw;
};

export const readOptionalInteger = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
  bounds: {
    readonly minimum?: number;
    readonly maximum?: number;
  } = {},
): number | undefined => {
  if (!(field in input) || input[field] === undefined) {
    return undefined;
  }

  const raw = input[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new TypeError(`${toolName} expects optional "${field}" to be an integer when provided.`);
  }

  if (bounds.minimum !== undefined && raw < bounds.minimum) {
    throw new TypeError(`${toolName} expects optional "${field}" to be >= ${bounds.minimum}.`);
  }

  if (bounds.maximum !== undefined && raw > bounds.maximum) {
    throw new TypeError(`${toolName} expects optional "${field}" to be <= ${bounds.maximum}.`);
  }

  return raw;
};

export const readRequiredBoolean = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): boolean => {
  const raw = input[field];

  if (typeof raw !== 'boolean') {
    throw new TypeError(`${toolName} requires "${field}" as a boolean.`);
  }

  return raw;
};

export const readRequiredObject = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): Record<string, unknown> => {
  const raw = input[field];

  if (!isRecord(raw)) {
    throw new TypeError(`${toolName} requires "${field}" as an object.`);
  }

  return raw;
};

export const readOptionalObject = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): Record<string, unknown> | undefined => {
  if (!(field in input) || input[field] === undefined) {
    return undefined;
  }

  const raw = input[field];
  if (!isRecord(raw)) {
    throw new TypeError(`${toolName} expects optional "${field}" to be an object when provided.`);
  }

  return raw;
};

export const readOptionalStringArray = (
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): readonly string[] | undefined => {
  if (!(field in input) || input[field] === undefined) {
    return undefined;
  }

  const raw = input[field];
  if (!Array.isArray(raw)) {
    throw new TypeError(`${toolName} expects optional "${field}" to be an array when provided.`);
  }

  const strings = raw.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new TypeError(`${toolName} expects "${field}" items to be non-empty strings.`);
    }

    return item;
  });

  return strings;
};

export const parseToolInput = (input: unknown, toolName: string): Record<string, unknown> => {
  if (!isRecord(input)) {
    throw new TypeError(`${toolName} requires an object input payload.`);
  }

  return input;
};

export const parseCallerContext = (
  input: Record<string, unknown>,
  toolName: string,
): CallerContext => {
  const callerInput = readRequiredObject(input, 'callerContext', toolName);
  const conversationId = createConversationId(
    readRequiredString(callerInput, 'conversationId', toolName),
  );
  const isSubAgent = readRequiredBoolean(callerInput, 'isSubAgent', toolName);
  const parentConversationId = readOptionalString(callerInput, 'parentConversationId', toolName);

  if (parentConversationId === undefined) {
    return {
      conversationId,
      isSubAgent,
    };
  }

  return {
    conversationId,
    isSubAgent,
    parentConversationId: createConversationId(parentConversationId),
  };
};
