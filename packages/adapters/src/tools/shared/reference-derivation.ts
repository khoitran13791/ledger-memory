import type { DescribeOutput, ExpandOutput, GrepOutput } from '@ledgermind/application';

import { toToolErrorEnvelope, toToolSuccessEnvelope } from '../error-mapping';
import type { ToolErrorEnvelope, ToolReferences, ToolSuccessEnvelope } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const mergeReferenceArrays = (
  arrays: ReadonlyArray<readonly string[] | undefined>,
): readonly string[] | undefined => {
  const merged = new Set<string>();

  for (const values of arrays) {
    if (values === undefined) {
      continue;
    }

    for (const value of values) {
      const normalized = value.trim();
      if (normalized.length > 0) {
        merged.add(normalized);
      }
    }
  }

  return merged.size > 0 ? [...merged] : undefined;
};

export const mergeReferences = (...references: readonly (ToolReferences | undefined)[]): ToolReferences | undefined => {
  const summaryIds = mergeReferenceArrays(references.map((reference) => reference?.summaryIds));
  const artifactIds = mergeReferenceArrays(references.map((reference) => reference?.artifactIds));
  const eventIds = mergeReferenceArrays(references.map((reference) => reference?.eventIds));

  if (summaryIds === undefined && artifactIds === undefined && eventIds === undefined) {
    return undefined;
  }

  return {
    ...(summaryIds === undefined ? {} : { summaryIds }),
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(eventIds === undefined ? {} : { eventIds }),
  };
};

export const extractReferences = (data: unknown): ToolReferences | undefined => {
  if (!isRecord(data)) {
    return undefined;
  }

  const references = data['references'];
  if (!isRecord(references)) {
    return undefined;
  }

  const readIdArray = (field: 'summaryIds' | 'artifactIds' | 'eventIds'): readonly string[] | undefined => {
    const value = references[field];
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }

    const ids = value.filter((candidate): candidate is string => typeof candidate === 'string');
    return ids.length > 0 ? ids : undefined;
  };

  const summaryIds = readIdArray('summaryIds');
  const artifactIds = readIdArray('artifactIds');
  const eventIds = readIdArray('eventIds');

  if (summaryIds === undefined && artifactIds === undefined && eventIds === undefined) {
    return undefined;
  }

  return {
    ...(summaryIds === undefined ? {} : { summaryIds }),
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(eventIds === undefined ? {} : { eventIds }),
  };
};

export const deriveRecallReferences = (
  scope: string | undefined,
  output: GrepOutput,
): ToolReferences | undefined => {
  const eventIds = output.matches
    .map((match) => String(match.eventId))
    .filter((eventId) => eventId.trim().length > 0);

  const dedupedEventIds = mergeReferenceArrays([eventIds]);

  if (scope === undefined && dedupedEventIds === undefined) {
    return undefined;
  }

  return {
    ...(scope === undefined ? {} : { summaryIds: [scope] }),
    ...(dedupedEventIds === undefined ? {} : { eventIds: dedupedEventIds }),
  };
};

export const deriveDescribeReferences = (id: string, output: DescribeOutput): ToolReferences | undefined => {
  if (output.kind === 'summary') {
    const summaryIds = mergeReferenceArrays([[id], output.parentIds?.map((parentId) => String(parentId))]);
    return summaryIds === undefined ? undefined : { summaryIds };
  }

  if (output.kind === 'artifact') {
    return { artifactIds: [id] };
  }

  return undefined;
};

const addArtifactIdFromUnknown = (target: Set<string>, value: unknown): void => {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length > 0) {
      target.add(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addArtifactIdFromUnknown(target, item);
    }
    return;
  }

  if (isRecord(value) && 'id' in value) {
    addArtifactIdFromUnknown(target, value.id);
  }
};

export const deriveExpandReferences = (
  summaryId: string,
  output: ExpandOutput,
): ToolReferences | undefined => {
  const artifactIdSet = new Set<string>();
  const eventIdSet = new Set<string>();

  for (const message of output.messages) {
    if (!isRecord(message)) {
      continue;
    }

    const rawEventId = message['id'];
    if (typeof rawEventId === 'string') {
      const normalizedEventId = rawEventId.trim();
      if (normalizedEventId.length > 0) {
        eventIdSet.add(normalizedEventId);
      }
    }

    const metadata = message['metadata'];
    if (!isRecord(metadata)) {
      continue;
    }

    addArtifactIdFromUnknown(artifactIdSet, metadata['artifactIds']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifact_ids']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifactId']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifact_id']);
    addArtifactIdFromUnknown(artifactIdSet, metadata['artifacts']);
  }

  const artifactIds = artifactIdSet.size > 0 ? [...artifactIdSet] : undefined;
  const eventIds = eventIdSet.size > 0 ? [...eventIdSet] : undefined;

  return {
    summaryIds: [summaryId],
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(eventIds === undefined ? {} : { eventIds }),
  };
};

export const toReferencedToolSuccessEnvelope = <TData>(
  data: TData,
  ...references: readonly (ToolReferences | undefined)[]
): ToolSuccessEnvelope<TData> => {
  const mergedReferences = mergeReferences(...references);
  return mergedReferences === undefined
    ? toToolSuccessEnvelope(data)
    : toToolSuccessEnvelope(data, { references: mergedReferences });
};

export const toReferencedToolErrorEnvelope = (
  error: unknown,
  ...references: readonly (ToolReferences | undefined)[]
): ToolErrorEnvelope => toToolErrorEnvelope(error, mergeReferences(...references));
