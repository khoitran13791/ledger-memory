import type { ArtifactId, EventId, SummaryNodeId, TokenCount } from '@ledgermind/domain';

import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
import type {
  ContinuityRecord,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  RecallForTaskInput,
  RecallForTaskOutput,
} from '../ports/driving/continuity.port';
import type {
  MaterializeContextInput,
  MaterializeContextOutput,
} from '../ports/driving/memory-engine.port';

export interface RecallForTaskUseCaseDeps {
  readonly getCurrentState: (input: GetCurrentStateInput) => Promise<GetCurrentStateOutput>;
  readonly materializeContext: (
    input: MaterializeContextInput,
  ) => Promise<MaterializeContextOutput>;
  readonly tokenizer: TokenizerPort;
}

type SectionName =
  | 'Goal'
  | 'Next steps'
  | 'Decisions'
  | 'Constraints'
  | 'Progress'
  | 'Verification'
  | 'Failures and risks'
  | 'Open questions'
  | 'Evidence'
  | 'Why recalled';

type RecallLine = {
  readonly section: SectionName;
  readonly text: string;
  readonly compactText?: string;
  readonly trimOrder?: number;
};

const SECTION_ORDER: readonly SectionName[] = [
  'Goal',
  'Next steps',
  'Decisions',
  'Constraints',
  'Progress',
  'Verification',
  'Failures and risks',
  'Open questions',
  'Evidence',
  'Why recalled',
];

const WHY_EVIDENCE_INCLUDED = 'Included active decisions, constraints, next steps, and evidence.';
const FINAL_FALLBACK_WHY = '- Current operational state was too large for the recall budget.';

const formatRecord = (record: ContinuityRecord): string => {
  const content = record.content.trim();
  const provenance = [
    record.provenance.command === undefined ? undefined : `command: ${record.provenance.command}`,
    record.provenance.transcriptPath === undefined
      ? undefined
      : `source: ${record.provenance.transcriptPath}`,
  ].filter((item): item is string => item !== undefined);
  const suffix = provenance.length === 0 ? '' : ` (${provenance.join('; ')})`;
  return content.length === 0
    ? `- ${record.title}${suffix}`
    : `- ${record.title}: ${content}${suffix}`;
};

const formatTitleOnly = (record: ContinuityRecord, prefix?: string): string =>
  `- ${prefix === undefined ? '' : `${prefix}: `}${record.title}`;

const addUnique = <T extends string>(target: T[], values: readonly T[] | undefined): void => {
  if (values === undefined) {
    return;
  }

  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
};

const collectRecordEventIds = (state: GetCurrentStateOutput): readonly EventId[] => {
  const ids: EventId[] = [];
  const addRecord = (record: ContinuityRecord): void => {
    addUnique(ids, record.provenance.eventIds);
    addUnique(ids, [record.eventId]);
  };

  for (const record of [
    ...state.goalRecords,
    ...state.decisions,
    ...state.constraints,
    ...state.progress,
    ...state.nextSteps,
    ...state.handoffs,
    ...state.verification,
    ...state.failures,
    ...state.openQuestions,
    ...state.artifactChanges,
    ...state.sessionSummaries,
  ]) {
    addRecord(record);
  }

  return ids;
};

const collectRecordArtifactIds = (state: GetCurrentStateOutput): readonly ArtifactId[] => {
  const ids: ArtifactId[] = [];

  for (const record of [
    ...state.goalRecords,
    ...state.decisions,
    ...state.constraints,
    ...state.progress,
    ...state.nextSteps,
    ...state.handoffs,
    ...state.verification,
    ...state.failures,
    ...state.openQuestions,
    ...state.artifactChanges,
    ...state.sessionSummaries,
  ]) {
    addUnique(ids, record.provenance.artifactIds);
  }

  return ids;
};

const collectRecordSummaryIds = (state: GetCurrentStateOutput): readonly SummaryNodeId[] => {
  const ids: SummaryNodeId[] = [];

  for (const record of [
    ...state.goalRecords,
    ...state.decisions,
    ...state.constraints,
    ...state.progress,
    ...state.nextSteps,
    ...state.handoffs,
    ...state.verification,
    ...state.failures,
    ...state.openQuestions,
    ...state.artifactChanges,
    ...state.sessionSummaries,
  ]) {
    addUnique(ids, record.provenance.summaryIds);
  }

  return ids;
};

const render = (lines: readonly RecallLine[]): string => {
  const sections = SECTION_ORDER.flatMap((section) => {
    const sectionLines = lines.filter((line) => line.section === section).map((line) => line.text);

    if (sectionLines.length === 0) {
      return [];
    }

    return [`${section}:\n${sectionLines.join('\n')}`];
  });

  return ['LedgerMind current state', ...sections].join('\n\n');
};

const count = (tokenizer: TokenizerPort, text: string): TokenCount => tokenizer.countTokens(text);

const trimToBudget = (
  lines: readonly RecallLine[],
  budgetTokens: number,
  tokenizer: TokenizerPort,
): readonly RecallLine[] => {
  let current = [...lines];

  if (count(tokenizer, render(current)).value <= budgetTokens) {
    return current;
  }

  for (let order = 1; order <= 6; order += 1) {
    current = current.map((line) =>
      line.trimOrder === order && line.compactText !== undefined
        ? { ...line, text: line.compactText }
        : line,
    );

    if (count(tokenizer, render(current)).value <= budgetTokens) {
      return current;
    }

    current = current.filter((line) => line.trimOrder !== order || line.compactText !== undefined);

    if (count(tokenizer, render(current)).value <= budgetTokens) {
      return current;
    }
  }

  const whyOnly = current.filter((line) => line.section === 'Why recalled').slice(0, 1);

  if (count(tokenizer, render(whyOnly)).value <= budgetTokens) {
    return whyOnly;
  }

  const fallback = [
    {
      section: 'Why recalled',
      text: FINAL_FALLBACK_WHY,
    },
  ] as const;

  if (count(tokenizer, render(fallback)).value <= budgetTokens) {
    return fallback;
  }

  return [];
};

export class RecallForTaskUseCase {
  constructor(private readonly deps: RecallForTaskUseCaseDeps) {}

  async execute(input: RecallForTaskInput): Promise<RecallForTaskOutput> {
    const [currentState, materializedContext] = await Promise.all([
      this.deps.getCurrentState({ conversationId: input.conversationId }),
      this.deps.materializeContext({
        conversationId: input.conversationId,
        budgetTokens: input.budgetTokens,
        overheadTokens: 0,
        retrievalHints: [{ query: input.task }],
      }),
    ]);
    const why = [
      `Current operational state for task: ${input.task}`,
      `Matched retrieval hint: ${input.task}`,
      WHY_EVIDENCE_INCLUDED,
    ] as const;
    const summaryIds: SummaryNodeId[] = [];
    const artifactIds: ArtifactId[] = [];
    const eventIds: EventId[] = [];

    addUnique(summaryIds, collectRecordSummaryIds(currentState));
    addUnique(
      summaryIds,
      materializedContext.summaryReferences.map((reference) => reference.id),
    );
    for (const diagnostics of materializedContext.retrievalDiagnostics ?? []) {
      addUnique(summaryIds, diagnostics.selectedSummaryIds);
    }

    addUnique(artifactIds, collectRecordArtifactIds(currentState));
    addUnique(
      artifactIds,
      materializedContext.artifactReferences.map((reference) => reference.id),
    );

    addUnique(eventIds, collectRecordEventIds(currentState));
    for (const diagnostics of materializedContext.retrievalDiagnostics ?? []) {
      addUnique(eventIds, diagnostics.selectedMessageIds);
    }

    const lines: RecallLine[] = [
      ...currentState.goalRecords.map((record) => ({
        section: 'Goal' as const,
        text: formatRecord(record),
      })),
      ...currentState.nextSteps.map((record) => ({
        section: 'Next steps' as const,
        text: formatRecord(record),
      })),
      ...currentState.decisions.map((record) => ({
        section: 'Decisions' as const,
        text: formatRecord(record),
      })),
      ...currentState.constraints.map((record) => ({
        section: 'Constraints' as const,
        text: formatRecord(record),
      })),
      ...currentState.progress.map((record, index) => ({
        section: 'Progress' as const,
        text: formatRecord(record),
        ...(index === 0 ? {} : { trimOrder: 1 }),
      })),
      ...currentState.sessionSummaries.map((record) => ({
        section: 'Progress' as const,
        text: formatRecord(record),
        trimOrder: 2,
      })),
    ];

    if (input.includeHandoff !== false && currentState.handoffs.length > 0) {
      const [latestHandoff, ...olderHandoffs] = currentState.handoffs;

      if (latestHandoff !== undefined) {
        lines.push({
          section: 'Progress',
          text: formatRecord(latestHandoff),
          compactText: formatTitleOnly(latestHandoff),
          trimOrder: 3,
        });
      }

      lines.push(
        ...olderHandoffs.map((record) => ({
          section: 'Progress' as const,
          text: formatRecord(record),
          trimOrder: 3,
        })),
      );
    }

    lines.push(
      ...currentState.verification.map((record) => ({
        section: 'Verification' as const,
        text: formatRecord(record),
        compactText: formatTitleOnly(record),
        trimOrder: 4,
      })),
      ...currentState.failures.map((record) => ({
        section: 'Failures and risks' as const,
        text: formatRecord(record),
      })),
      ...currentState.openQuestions.map((record) => ({
        section: 'Open questions' as const,
        text: formatRecord(record),
        compactText: formatTitleOnly(record),
        trimOrder: 5,
      })),
    );

    if (input.includeEvidence !== false) {
      lines.push(
        ...summaryIds.map((id) => ({
          section: 'Evidence' as const,
          text: `- summary ${id}`,
          trimOrder: 6,
        })),
        ...artifactIds.map((id) => ({
          section: 'Evidence' as const,
          text: `- artifact ${id}`,
          trimOrder: 6,
        })),
        ...eventIds.map((id) => ({
          section: 'Evidence' as const,
          text: `- event ${id}`,
          trimOrder: 6,
        })),
      );
    }

    lines.push(...why.map((reason) => ({ section: 'Why recalled' as const, text: `- ${reason}` })));

    const trimmedLines = trimToBudget(lines, input.budgetTokens, this.deps.tokenizer);
    const renderedContextBlock = render(trimmedLines);
    const contextBlock =
      this.deps.tokenizer.countTokens(renderedContextBlock).value <= input.budgetTokens
        ? renderedContextBlock
        : '';

    return {
      contextBlock,
      currentState,
      recalledSummaryIds: summaryIds,
      recalledArtifactIds: artifactIds,
      recalledEventIds: eventIds,
      why,
      budgetUsed: this.deps.tokenizer.countTokens(contextBlock),
    };
  }
}
