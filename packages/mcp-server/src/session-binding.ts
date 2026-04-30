import { randomUUID } from 'node:crypto';

import { createConversationId, type ConversationId } from '@ledgermind/domain';

import type {
  SessionBindingLookup,
  SessionBindingRecord,
  SessionBindingStore,
} from './session-binding-store';

export interface ResolveSessionBindingInput extends SessionBindingLookup {
  readonly parentRuntimeSessionId?: string;
  readonly createConversation?: (input: ResolveConversationBindingInput) => Promise<ConversationId>;
}

export interface ResolveConversationBindingInput {
  readonly parentConversationId?: ConversationId;
}

export interface SessionBindingRuntimeMetadata {
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly userScope: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
  readonly parentRuntimeSessionId?: string;
  readonly isSubAgent?: boolean;
}

const toLookup = (input: ResolveSessionBindingInput): SessionBindingLookup => ({
  runtime: input.runtime,
  runtimeSessionId: input.runtimeSessionId,
  userScope: input.userScope,
  workspaceScope: input.workspaceScope,
  ...(input.branchScope === undefined ? {} : { branchScope: input.branchScope }),
});

const findParentConversationId = async (
  store: SessionBindingStore,
  input: ResolveSessionBindingInput,
): Promise<ConversationId | undefined> => {
  if (input.parentRuntimeSessionId === undefined) {
    return undefined;
  }

  const parentBinding = await store.find({
    runtime: input.runtime,
    runtimeSessionId: input.parentRuntimeSessionId,
    userScope: input.userScope,
    workspaceScope: input.workspaceScope,
    ...(input.branchScope === undefined ? {} : { branchScope: input.branchScope }),
  });

  return parentBinding?.conversationId;
};

const createBindingConversationId = async (
  input: ResolveSessionBindingInput,
  parentConversationId: ConversationId | undefined,
): Promise<ConversationId> =>
  input.createConversation === undefined
    ? createConversationId(`conv_${randomUUID()}`)
    : input.createConversation(parentConversationId === undefined ? {} : { parentConversationId });

const resolveParentConversationId = async (
  store: SessionBindingStore,
  input: ResolveSessionBindingInput,
): Promise<ConversationId | undefined> => {
  const parentConversationId = await findParentConversationId(store, input);
  if (input.parentRuntimeSessionId !== undefined && parentConversationId === undefined) {
    throw new Error(`Parent runtime session "${input.parentRuntimeSessionId}" is not bound.`);
  }

  return parentConversationId;
};

export const resolveSessionBinding = async (
  store: SessionBindingStore,
  input: ResolveSessionBindingInput,
): Promise<SessionBindingRecord> => {
  const existing = await store.find(toLookup(input));
  if (existing !== undefined) {
    if (input.parentRuntimeSessionId !== undefined) {
      const parentConversationId = await resolveParentConversationId(store, input);
      if (
        existing.parentConversationId !== undefined &&
        parentConversationId !== existing.parentConversationId
      ) {
        throw new Error(
          `Runtime session "${input.runtimeSessionId}" is already bound to a different parent conversation.`,
        );
      }
    }

    return existing;
  }

  const parentConversationId = await resolveParentConversationId(store, input);
  const conversationId = await createBindingConversationId(input, parentConversationId);

  const nextBinding: SessionBindingRecord = {
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId,
    userScope: input.userScope,
    workspaceScope: input.workspaceScope,
    ...(input.branchScope === undefined ? {} : { branchScope: input.branchScope }),
    conversationId,
    ...(parentConversationId === undefined ? {} : { parentConversationId }),
  };

  await store.save(nextBinding);
  return nextBinding;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CONVERSATION_BOUND_TOOL_NAMES = new Set([
  'memory.recall',
  'memory.currentState',
  'memory.nextSteps',
  'memory.recallForTask',
  'memory.recordDecision',
  'memory.recordConstraint',
  'memory.recordProgress',
  'memory.recordVerification',
  'memory.createHandoff',
  'memory.markStale',
]);

export const readSessionBindingMetadata = (
  meta: Record<string, unknown> | undefined,
): SessionBindingRuntimeMetadata | undefined => {
  const raw = meta?.['ledgermind/session'];
  if (!isRecord(raw)) {
    return undefined;
  }

  const readOptionalString = (field: keyof SessionBindingRuntimeMetadata): string | undefined => {
    const value = raw[field];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  };

  const runtime = readOptionalString('runtime');
  const runtimeSessionId = readOptionalString('runtimeSessionId');
  const userScope = readOptionalString('userScope');
  const workspaceScope = readOptionalString('workspaceScope');

  if (
    runtime === undefined ||
    runtimeSessionId === undefined ||
    userScope === undefined ||
    workspaceScope === undefined
  ) {
    return undefined;
  }

  const branchScope = readOptionalString('branchScope');
  const parentRuntimeSessionId = readOptionalString('parentRuntimeSessionId');

  return {
    runtime,
    runtimeSessionId,
    userScope,
    workspaceScope,
    ...(branchScope === undefined ? {} : { branchScope }),
    ...(parentRuntimeSessionId === undefined ? {} : { parentRuntimeSessionId }),
    ...(typeof raw.isSubAgent === 'boolean' ? { isSubAgent: raw.isSubAgent } : {}),
  };
};

export const applySessionBindingToToolArguments = (
  toolName: string,
  argumentsInput: Record<string, unknown> | undefined,
  binding: SessionBindingRecord,
  metadata: SessionBindingRuntimeMetadata,
): Record<string, unknown> => {
  const nextArguments = { ...(argumentsInput ?? {}) };

  if (CONVERSATION_BOUND_TOOL_NAMES.has(toolName)) {
    nextArguments.conversationId = String(binding.conversationId);
  }

  if (toolName === 'memory.expand') {
    nextArguments.callerContext = {
      conversationId: String(binding.conversationId),
      isSubAgent: metadata.isSubAgent === true,
      ...(binding.parentConversationId === undefined
        ? {}
        : { parentConversationId: String(binding.parentConversationId) }),
    };
  }

  return nextArguments;
};
