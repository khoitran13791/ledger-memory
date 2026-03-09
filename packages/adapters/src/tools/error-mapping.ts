import {
  ApplicationError,
  ArtifactNotFoundError,
  ConversationNotFoundError,
  InvalidReferenceError,
  UnauthorizedExpandError,
} from '@ledgermind/application';
import { InvariantViolationError } from '@ledgermind/domain';

import type {
  ToolErrorEnvelope,
  ToolErrorPayload,
  ToolReferences,
  ToolSuccessEnvelope,
} from './types';

const TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED' as const;

const toErrorDetails = (error: Error): Readonly<Record<string, unknown>> | undefined => {
  if (error instanceof InvalidReferenceError) {
    return {
      referenceKind: error.referenceKind,
      referenceId: error.referenceId,
    };
  }

  if (error instanceof UnauthorizedExpandError) {
    return {
      conversationId: error.conversationId,
      summaryId: error.summaryId,
    };
  }

  if (error instanceof ArtifactNotFoundError) {
    return {
      artifactId: error.artifactId,
    };
  }

  if (error instanceof ConversationNotFoundError) {
    return {
      conversationId: error.conversationId,
    };
  }

  if (error instanceof InvariantViolationError) {
    return {
      reason: error.message,
    };
  }

  return undefined;
};

const toErrorPayload = (error: unknown): ToolErrorPayload => {
  if (
    error instanceof InvalidReferenceError ||
    error instanceof UnauthorizedExpandError ||
    error instanceof ArtifactNotFoundError ||
    error instanceof ConversationNotFoundError
  ) {
    const details = toErrorDetails(error);

    return details === undefined
      ? {
          code: error.code,
          message: error.message,
        }
      : {
          code: error.code,
          message: error.message,
          details,
        };
  }

  if (error instanceof ApplicationError || error instanceof InvariantViolationError) {
    const details = toErrorDetails(error);

    return details === undefined
      ? {
          code: TOOL_EXECUTION_FAILED,
          message: error.message,
        }
      : {
          code: TOOL_EXECUTION_FAILED,
          message: error.message,
          details,
        };
  }

  if (error instanceof Error) {
    return {
      code: TOOL_EXECUTION_FAILED,
      message: error.message,
    };
  }

  return {
    code: TOOL_EXECUTION_FAILED,
    message: 'Tool execution failed due to an unexpected non-error throw value.',
    details: {
      thrownValue: String(error),
    },
  };
};

export const toToolSuccessEnvelope = <TData>(
  data: TData,
  options: {
    references?: ToolReferences;
    meta?: Readonly<Record<string, unknown>>;
  } = {},
): ToolSuccessEnvelope<TData> => {
  const envelope: {
    ok: true;
    data: TData;
    references?: ToolReferences;
    meta?: Readonly<Record<string, unknown>>;
  } = {
    ok: true,
    data,
  };

  if (options.references !== undefined) {
    envelope.references = options.references;
  }

  if (options.meta !== undefined) {
    envelope.meta = options.meta;
  }

  return envelope;
};

export const toToolErrorEnvelope = (
  error: unknown,
  references?: ToolReferences,
): ToolErrorEnvelope => {
  const payload = toErrorPayload(error);

  if (references === undefined) {
    return {
      ok: false,
      error: payload,
    };
  }

  return {
    ok: false,
    error: payload,
    references,
  };
};
