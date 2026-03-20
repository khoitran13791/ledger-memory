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
      throw new TypeError(`createCanonicalMemoryToolCatalog requires engine.${method}() to be a function.`);
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
    throw new TypeError(`${toolName} expects optional "${field}" to be a non-empty string when provided.`);
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
  const conversationId = createConversationId(readRequiredString(callerInput, 'conversationId', toolName));
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
