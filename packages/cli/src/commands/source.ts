import { createSummaryNodeId } from '@ledgermind/domain';

import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as RuntimeModule from '../runtime';
import type { CockpitRuntime } from '../runtime';
import type { ExpandInput, ExpandOutput, MemoryEngine } from '@ledgermind/sdk';
import type { SessionBindingRecord } from '@ledgermind/mcp-server';

export interface SourceRuntime {
  readonly engine: Pick<MemoryEngine, 'expand'>;
  resolveBinding(): Promise<SessionBindingRecord>;
  close(): Promise<void>;
}

export interface RunSourceCommandInput {
  readonly config: CockpitConfig;
  readonly summaryId: string;
  readonly confirmed: boolean;
  readonly runtime?: SourceRuntime;
}

const localModule = (specifier: string): string =>
  new URL(
    import.meta.url.endsWith('.ts') ? `${specifier}.ts` : `${specifier}.js`,
    import.meta.url,
  ).href;

const createRuntime = async (config: CockpitConfig): Promise<CockpitRuntime> => {
  const { createCockpitRuntime } =
    await import(localModule('../runtime')) as typeof RuntimeModule;
  return createCockpitRuntime(config);
};

export const formatSourceHuman = (output: ExpandOutput): string =>
  output.messages
    .map((message) => `[${String(message.sequence)}] ${message.role}: ${message.content}\n`)
    .join('');

const createExpandInput = (
  summaryId: string,
  binding: SessionBindingRecord,
): ExpandInput => ({
  summaryId: createSummaryNodeId(summaryId),
  callerContext: {
    conversationId: binding.conversationId,
    isSubAgent: true,
    ...(binding.parentConversationId === undefined
      ? {}
      : { parentConversationId: binding.parentConversationId }),
  },
});

export const runSourceCommand = async ({
  config,
  summaryId,
  confirmed,
  runtime,
}: RunSourceCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    if (!confirmed) {
      throw new Error('source reveals raw remembered messages; rerun with --yes to confirm.');
    }

    const trimmedSummaryId = summaryId.trim();
    if (trimmedSummaryId.length === 0) {
      throw new Error('source requires a summary id.');
    }

    activeRuntime ??= await createRuntime(config);

    const binding = await activeRuntime.resolveBinding();
    if (binding.parentConversationId === undefined) {
      throw new Error(
        'source requires a child runtime binding. Rerun with a fresh --runtime-session and --parent-runtime-session <parent>.',
      );
    }

    const output = await activeRuntime.engine.expand(createExpandInput(trimmedSummaryId, binding));

    if (config.output === 'json') {
      const { asJsonLine } =
        await import(localModule('../formatters')) as typeof FormattersModule;
      return asJsonLine({ ok: true, data: output });
    }

    return formatSourceHuman(output);
  } finally {
    await activeRuntime?.close();
  }
};
