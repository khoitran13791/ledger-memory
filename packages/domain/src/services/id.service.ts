import type { SummaryKind } from '../entities/summary-node';
import { InvariantViolationError } from '../errors/domain-errors';
import {
  createArtifactId,
  createEventId,
  createSummaryNodeId,
  type ArtifactId,
  type ConversationId,
  type EventId,
  type SequenceNumber,
  type SummaryNodeId,
} from '../value-objects/ids';
import type { MessageRole } from '../value-objects/message-role';

export interface HashPort {
  sha256(input: Uint8Array): string;
}

export interface IdService {
  generateEventId(input: {
    readonly content: string;
    readonly conversationId: ConversationId;
    readonly role: MessageRole;
    readonly sequence: SequenceNumber;
  }): EventId;
  generateSummaryId(input: {
    readonly content: string;
    readonly conversationId: ConversationId;
    readonly kind: SummaryKind;
  }): SummaryNodeId;
  generateArtifactId(input: {
    readonly contentHashHex: string;
  }): ArtifactId;
}

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const textEncoder = new TextEncoder();

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizeCanonicalJsonValue = (value: unknown): CanonicalJsonValue | undefined => {
  if (value === null) {
    return null;
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (typeof value === 'bigint') {
    throw new InvariantViolationError('Canonical JSON does not support bigint values.');
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeCanonicalJsonValue(item) ?? null);
  }

  if (!isPlainRecord(value)) {
    throw new InvariantViolationError('Canonical JSON input must use plain objects, arrays, and primitives.');
  }

  const orderedEntries: Record<string, CanonicalJsonValue> = {};

  for (const key of Object.keys(value).sort()) {
    const normalizedValue = normalizeCanonicalJsonValue(value[key]);

    if (normalizedValue !== undefined) {
      orderedEntries[key] = normalizedValue;
    }
  }

  return orderedEntries;
};

export const serializeCanonicalJson = (input: Readonly<Record<string, unknown>>): string => {
  const normalized = normalizeCanonicalJsonValue(input);
  const serialized = normalized === undefined ? undefined : JSON.stringify(normalized);

  if (serialized === undefined) {
    throw new InvariantViolationError('Canonical JSON serialization failed for the provided payload.');
  }

  return serialized;
};

const normalizeHashHex = (hashHex: string): string => {
  const trimmed = hashHex.trim();

  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new InvariantViolationError('HashPort.sha256 must return a non-empty hexadecimal string.');
  }

  return trimmed.toLowerCase();
};

const createContentAddressedId = (
  prefix: 'evt' | 'sum' | 'file',
  payload: Readonly<Record<string, unknown>>,
  hashPort: HashPort,
): string => {
  const canonicalPayload = serializeCanonicalJson(payload);
  const digest = normalizeHashHex(hashPort.sha256(textEncoder.encode(canonicalPayload)));
  return `${prefix}_${digest}`;
};

export const createIdService = (hashPort: HashPort): IdService => {
  if (typeof hashPort?.sha256 !== 'function') {
    throw new InvariantViolationError('IdService requires a HashPort implementation with sha256(input).');
  }

  const service: IdService = {
    generateEventId: (input) => {
      const id = createContentAddressedId(
        'evt',
        {
          content: input.content,
          conversationId: input.conversationId,
          role: input.role,
          sequence: input.sequence,
        },
        hashPort,
      );

      return createEventId(id);
    },

    generateSummaryId: (input) => {
      const id = createContentAddressedId(
        'sum',
        {
          content: input.content,
          conversationId: input.conversationId,
          kind: input.kind,
        },
        hashPort,
      );

      return createSummaryNodeId(id);
    },

    generateArtifactId: (input) => {
      const id = createContentAddressedId(
        'file',
        {
          contentHash: normalizeHashHex(input.contentHashHex),
        },
        hashPort,
      );

      return createArtifactId(id);
    },
  };

  return Object.freeze(service);
};
