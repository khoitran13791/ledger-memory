import type {
  ContinuityRecord,
  ContinuityRecordKind,
  CreateHandoffInput,
  CreateHandoffOutput,
  GetCurrentStateOutput,
  GetNextStepsOutput,
  MarkContinuityRecordOutput,
  MemoryEngine,
  RecallForTaskOutput,
  RecordContinuityOutput,
} from '@ledgermind/sdk';
import type { SessionBindingRecord } from '@ledgermind/mcp-server';

import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as RuntimeModule from '../runtime';
import type { CockpitRuntime } from '../runtime';

export interface ContinuityRuntime<TMethods extends keyof MemoryEngine> {
  readonly engine: Pick<MemoryEngine, TMethods>;
  resolveBinding(): Promise<SessionBindingRecord>;
  close(): Promise<void>;
}

const localModule = (specifier: string): string =>
  new URL(import.meta.url.endsWith('.ts') ? `${specifier}.ts` : `${specifier}.js`, import.meta.url)
    .href;

export const createRuntime = async (config: CockpitConfig): Promise<CockpitRuntime> => {
  const { createCockpitRuntime } = (await import(
    localModule('../runtime')
  )) as typeof RuntimeModule;
  return createCockpitRuntime(config);
};

export const asJsonLine = async (value: unknown): Promise<string> => {
  const { asJsonLine: formatJsonLine } = (await import(
    localModule('../formatters')
  )) as typeof FormattersModule;
  return formatJsonLine(value);
};

export const requireText = (value: string, command: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${command} requires non-empty text.`);
  }

  return trimmed;
};

export const formatRecordLine = (record: ContinuityRecord): string =>
  record.content.trim().length === 0
    ? `- ${record.title}\n`
    : `- ${record.title}: ${record.content}\n`;

export const formatCurrentStateHuman = (state: GetCurrentStateOutput): string => {
  const lines = ['Current state\n'];

  const appendSection = (label: string, records: readonly ContinuityRecord[]): void => {
    if (records.length === 0) {
      return;
    }

    lines.push(`${label}\n`);
    for (const record of records) {
      lines.push(`- ${record.title}\n`);
    }
  };

  appendSection('Goal', state.goalRecords);
  appendSection('Next', state.nextSteps);
  appendSection('Decisions', state.decisions);
  appendSection('Constraints', state.constraints);

  const evidenceIds = [
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
  ].map((record) => String(record.eventId));

  if (evidenceIds.length > 0) {
    lines.push('Evidence\n');
    for (const eventId of evidenceIds) {
      lines.push(`- ${eventId}\n`);
    }
  }

  return lines.join('');
};

export const formatNextStepsHuman = (output: GetNextStepsOutput): string =>
  ['Next steps\n', ...output.nextSteps.map(formatRecordLine)].join('');

export const runRecordContinuityCommand = async ({
  config,
  text,
  kind,
  runtime,
}: {
  readonly config: CockpitConfig;
  readonly text: string;
  readonly kind: Extract<ContinuityRecordKind, 'decision' | 'progress' | 'verification'>;
  readonly runtime?: ContinuityRuntime<'recordContinuity'>;
}): Promise<string> => {
  let activeRuntime = runtime;

  try {
    const trimmed = requireText(text, kind === 'verification' ? 'verify' : kind);
    activeRuntime ??= await createRuntime(config);

    const binding = await activeRuntime.resolveBinding();
    const output = await activeRuntime.engine.recordContinuity({
      conversationId: binding.conversationId,
      kind,
      title: trimmed,
      content: trimmed,
      ...(config.branchScope === undefined
        ? {}
        : { provenance: { command: `ledgermind ${kind}` } }),
    });

    if (config.output === 'json') {
      return asJsonLine({ ok: true, data: output });
    }

    return `Recorded ${kind} ${output.record.recordId} in ${String(binding.conversationId)}.\n`;
  } finally {
    await activeRuntime?.close();
  }
};

export type {
  CreateHandoffInput,
  CreateHandoffOutput,
  GetCurrentStateOutput,
  GetNextStepsOutput,
  MarkContinuityRecordOutput,
  RecallForTaskOutput,
  RecordContinuityOutput,
};
