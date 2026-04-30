import type {
  ArtifactId,
  EventId,
  EventMetadata,
  LedgerEvent,
  SummaryNodeId,
} from '@ledgermind/domain';

import type { LedgerReadPort } from '../ports/driven/persistence/ledger-read.port';
import type {
  ContinuityImportance,
  ContinuityProvenance,
  ContinuityRecord,
  ContinuityRecordKind,
  ContinuityRecordStatus,
  GetCurrentStateInput,
  GetCurrentStateOutput,
} from '../ports/driving/continuity.port';

export interface GetCurrentStateUseCaseDeps {
  readonly ledgerRead: LedgerReadPort;
}

type BucketName = Exclude<keyof GetCurrentStateOutput, 'activeRecordCount' | 'staleRecordCount'>;
type MutableBuckets = Record<BucketName, ContinuityRecord[]>;
type LifecycleSuppression = {
  readonly markerSequence: number;
  readonly targetRecordId: string;
};

const CONTINUITY_KINDS = new Set<ContinuityRecordKind>([
  'goal',
  'decision',
  'constraint',
  'progress',
  'next_step',
  'handoff',
  'verification',
  'failure',
  'open_question',
  'artifact_change',
  'session_summary',
]);

const CONTINUITY_STATUSES = new Set<ContinuityRecordStatus>([
  'active',
  'stale',
  'superseded',
  'resolved',
]);

const CONTINUITY_IMPORTANCE = new Set<ContinuityImportance>(['low', 'normal', 'high', 'critical']);

const BUCKETS_BY_KIND: Record<ContinuityRecordKind, BucketName> = {
  goal: 'goalRecords',
  decision: 'decisions',
  constraint: 'constraints',
  progress: 'progress',
  next_step: 'nextSteps',
  handoff: 'handoffs',
  verification: 'verification',
  failure: 'failures',
  open_question: 'openQuestions',
  artifact_change: 'artifactChanges',
  session_summary: 'sessionSummaries',
};

const emptyBuckets = (): MutableBuckets => ({
  goalRecords: [],
  decisions: [],
  constraints: [],
  progress: [],
  nextSteps: [],
  handoffs: [],
  verification: [],
  failures: [],
  openQuestions: [],
  artifactChanges: [],
  sessionSummaries: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (metadata: EventMetadata, key: string): string | null => {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

const readStringArray = (metadata: EventMetadata, key: string): readonly string[] => {
  const value = metadata[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
};

const readProvenanceStringArray = (
  provenance: Record<string, unknown>,
  key: string,
): readonly string[] | undefined => {
  const value = provenance[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );

  return strings.length === 0 ? undefined : strings;
};

const readOptionalString = (
  provenance: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = provenance[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

const readOptionalNumber = (
  provenance: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = provenance[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const sanitizeProvenance = (value: unknown): ContinuityProvenance => {
  if (!isRecord(value)) {
    return {};
  }

  const eventIds = readProvenanceStringArray(value, 'eventIds');
  const summaryIds = readProvenanceStringArray(value, 'summaryIds');
  const artifactIds = readProvenanceStringArray(value, 'artifactIds');
  const transcriptPath = readOptionalString(value, 'transcriptPath');
  const transcriptLineStart = readOptionalNumber(value, 'transcriptLineStart');
  const transcriptLineEnd = readOptionalNumber(value, 'transcriptLineEnd');
  const toolUseId = readOptionalString(value, 'toolUseId');
  const command = readOptionalString(value, 'command');

  return {
    ...(eventIds === undefined ? {} : { eventIds: eventIds as readonly EventId[] }),
    ...(summaryIds === undefined ? {} : { summaryIds: summaryIds as readonly SummaryNodeId[] }),
    ...(artifactIds === undefined ? {} : { artifactIds: artifactIds as readonly ArtifactId[] }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(transcriptLineStart === undefined ? {} : { transcriptLineStart }),
    ...(transcriptLineEnd === undefined ? {} : { transcriptLineEnd }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(command === undefined ? {} : { command }),
  };
};

const parseContent = (
  eventContent: string,
  kind: ContinuityRecordKind,
): Pick<ContinuityRecord, 'title' | 'content'> => {
  const match = /^\[([^\]]+)\] ([^\n]+)\n\n([\s\S]*)$/u.exec(eventContent);
  const [, parsedKind, parsedTitle, parsedContent] = match ?? [];

  if (parsedKind === kind && parsedTitle !== undefined && parsedTitle.trim().length > 0) {
    return {
      title: parsedTitle.trim(),
      content: parsedContent?.trim() ?? '',
    };
  }

  const fallback = eventContent.trim();

  return {
    title: fallback.length === 0 ? '(untitled continuity record)' : fallback,
    content: fallback,
  };
};

export const parseContinuityRecordFromEvent = (event: LedgerEvent): ContinuityRecord | null => {
  const metadata = event.metadata;

  if (metadata['kind'] !== 'continuity_record') {
    return null;
  }

  const rawKind = readString(metadata, 'continuityKind');
  const rawStatus = readString(metadata, 'status');
  const rawImportance = readString(metadata, 'importance');
  const recordId = readString(metadata, 'recordId');

  if (
    rawKind === null ||
    rawStatus === null ||
    rawImportance === null ||
    recordId === null ||
    !CONTINUITY_KINDS.has(rawKind as ContinuityRecordKind) ||
    !CONTINUITY_STATUSES.has(rawStatus as ContinuityRecordStatus) ||
    !CONTINUITY_IMPORTANCE.has(rawImportance as ContinuityImportance)
  ) {
    return null;
  }

  const kind = rawKind as ContinuityRecordKind;
  const { title, content } = parseContent(event.content, kind);
  const supersededByRecordId = readString(metadata, 'supersededByRecordId');

  return {
    recordId,
    conversationId: event.conversationId,
    kind,
    status: rawStatus as ContinuityRecordStatus,
    title,
    content,
    importance: rawImportance as ContinuityImportance,
    provenance: sanitizeProvenance(metadata['provenance']),
    relatedRecordIds: readStringArray(metadata, 'relatedRecordIds'),
    supersedesRecordIds: readStringArray(metadata, 'supersedesRecordIds'),
    ...(supersededByRecordId === null ? {} : { supersededByRecordId }),
    createdAt: event.occurredAt,
    eventId: event.id,
  };
};

const sequenceOf = (
  record: ContinuityRecord,
  eventSequences: ReadonlyMap<EventId, number>,
): number => eventSequences.get(record.eventId) ?? 0;

const compareNewestFirst =
  (eventSequences: ReadonlyMap<EventId, number>) =>
  (left: ContinuityRecord, right: ContinuityRecord): number =>
    sequenceOf(right, eventSequences) - sequenceOf(left, eventSequences);

const compareOldestFirst =
  (eventSequences: ReadonlyMap<EventId, number>) =>
  (left: ContinuityRecord, right: ContinuityRecord): number =>
    sequenceOf(left, eventSequences) - sequenceOf(right, eventSequences);

const limitRecords = (
  records: readonly ContinuityRecord[],
  limitPerKind: number | undefined,
): readonly ContinuityRecord[] => {
  if (limitPerKind === undefined || limitPerKind < 1) {
    return records;
  }

  return records.slice(0, limitPerKind);
};

export class GetCurrentStateUseCase {
  constructor(private readonly deps: GetCurrentStateUseCaseDeps) {}

  async execute(input: GetCurrentStateInput): Promise<GetCurrentStateOutput> {
    const events = await this.deps.ledgerRead.getEvents(input.conversationId);
    const eventSequences = new Map(events.map((event) => [event.id, event.sequence]));
    const records = events
      .map((event) => parseContinuityRecordFromEvent(event))
      .filter((record): record is ContinuityRecord => record !== null);

    const lifecycleSuppressions: LifecycleSuppression[] = [];

    for (const record of records) {
      const markerSequence = sequenceOf(record, eventSequences);

      for (const supersededRecordId of record.supersedesRecordIds) {
        lifecycleSuppressions.push({
          markerSequence,
          targetRecordId: supersededRecordId,
        });
      }

      if (record.status !== 'active') {
        for (const relatedRecordId of record.relatedRecordIds) {
          lifecycleSuppressions.push({
            markerSequence,
            targetRecordId: relatedRecordId,
          });
        }
      }
    }

    const isSuppressedByLaterLifecycle = (record: ContinuityRecord): boolean => {
      const recordSequence = sequenceOf(record, eventSequences);

      return lifecycleSuppressions.some(
        (suppression) =>
          suppression.targetRecordId === record.recordId &&
          recordSequence < suppression.markerSequence,
      );
    };

    const isActiveAfterLifecycle = (record: ContinuityRecord): boolean =>
      record.status === 'active' && !isSuppressedByLaterLifecycle(record);

    const activeRecordCount = records.filter(isActiveAfterLifecycle).length;
    const staleRecordCount = records.length - activeRecordCount;
    const visibleRecords =
      input.includeStale === true
        ? records
        : records.filter((record) => isActiveAfterLifecycle(record));
    const buckets = emptyBuckets();

    for (const record of visibleRecords) {
      buckets[BUCKETS_BY_KIND[record.kind]].push(record);
    }

    const newestFirst = compareNewestFirst(eventSequences);
    const oldestFirst = compareOldestFirst(eventSequences);

    return {
      goalRecords: limitRecords(buckets.goalRecords.sort(newestFirst), input.limitPerKind),
      decisions: limitRecords(buckets.decisions.sort(newestFirst), input.limitPerKind),
      constraints: limitRecords(buckets.constraints.sort(newestFirst), input.limitPerKind),
      progress: limitRecords(buckets.progress.sort(newestFirst), input.limitPerKind),
      nextSteps: limitRecords(buckets.nextSteps.sort(oldestFirst), input.limitPerKind),
      handoffs: limitRecords(buckets.handoffs.sort(newestFirst), input.limitPerKind),
      verification: limitRecords(buckets.verification.sort(newestFirst), input.limitPerKind),
      failures: limitRecords(buckets.failures.sort(newestFirst), input.limitPerKind),
      openQuestions: limitRecords(buckets.openQuestions.sort(newestFirst), input.limitPerKind),
      artifactChanges: limitRecords(buckets.artifactChanges.sort(newestFirst), input.limitPerKind),
      sessionSummaries: limitRecords(
        buckets.sessionSummaries.sort(newestFirst),
        input.limitPerKind,
      ),
      activeRecordCount,
      staleRecordCount,
    };
  }
}
