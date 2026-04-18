import { randomUUID } from 'node:crypto';

import { createConversationId } from '@ledgermind/domain';

import type {
  SessionBindingLookup,
  SessionBindingRecord,
  SessionBindingStore,
} from './session-binding-store';

export interface ResolveSessionBindingInput extends SessionBindingLookup {
  readonly parentRuntimeSessionId?: string;
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

export const resolveSessionBinding = async (
  store: SessionBindingStore,
  input: ResolveSessionBindingInput,
): Promise<SessionBindingRecord> => {
  const existing = await store.find(toLookup(input));
  if (existing !== undefined) {
    return existing;
  }

  let parentConversationId = undefined;
  if (input.parentRuntimeSessionId !== undefined) {
    const parentBinding = await store.find({
      runtime: input.runtime,
      runtimeSessionId: input.parentRuntimeSessionId,
      userScope: input.userScope,
      workspaceScope: input.workspaceScope,
      ...(input.branchScope === undefined ? {} : { branchScope: input.branchScope }),
    });

    parentConversationId = parentBinding?.conversationId;
  }

  const nextBinding: SessionBindingRecord = {
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId,
    userScope: input.userScope,
    workspaceScope: input.workspaceScope,
    ...(input.branchScope === undefined ? {} : { branchScope: input.branchScope }),
    conversationId: createConversationId(`conv_${randomUUID()}`),
    ...(parentConversationId === undefined ? {} : { parentConversationId }),
  };

  await store.save(nextBinding);
  return nextBinding;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

  if (runtime === undefined || runtimeSessionId === undefined || userScope === undefined || workspaceScope === undefined) {
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

  if (toolName === 'memory.recall' && nextArguments.conversationId === undefined) {
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
