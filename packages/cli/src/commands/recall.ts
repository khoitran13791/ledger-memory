import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as RuntimeModule from '../runtime';
import type { CockpitRuntime } from '../runtime';
import type { GrepInput, GrepOutput, MemoryEngine } from '@ledgermind/sdk';
import type { SessionBindingRecord } from '@ledgermind/mcp-server';

export interface RecallRuntime {
  readonly engine: Pick<MemoryEngine, 'grep'>;
  resolveBinding(): Promise<SessionBindingRecord>;
  close(): Promise<void>;
}

export interface RunRecallCommandInput {
  readonly config: CockpitConfig;
  readonly query: string;
  readonly runtime?: RecallRuntime;
  readonly limit?: number;
  readonly offset?: number;
}

const DEFAULT_RECALL_LIMIT = 25;

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

export const formatRecallHuman = (output: GrepOutput): string => {
  const matchCount = output.page.totalMatchCount;
  const lines = [`${matchCount} ${matchCount === 1 ? 'match' : 'matches'}\n`];

  for (const group of output.groups) {
    if (group.coveringSummaryId !== undefined) {
      lines.push(`Summary: ${String(group.coveringSummaryId)}\n`);
    }

    for (const match of group.matches) {
      lines.push(`[${String(match.sequence)}] ${String(match.eventId)}: ${match.excerpt}\n`);
    }
  }

  if (output.page.hasMore && output.page.nextOffset !== undefined) {
    lines.push(`More results available at offset ${output.page.nextOffset}.\n`);
  }

  return lines.join('');
};

export const runRecallCommand = async ({
  config,
  query,
  runtime,
  limit = DEFAULT_RECALL_LIMIT,
  offset,
}: RunRecallCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    if (query.trim().length === 0) {
      throw new Error('recall requires a non-empty query.');
    }

    activeRuntime ??= await createRuntime(config);

    const binding = await activeRuntime.resolveBinding();
    const grepInput: GrepInput = {
      conversationId: binding.conversationId,
      pattern: query,
      ...(offset === undefined ? {} : { offset }),
      limit,
    };
    const output = await activeRuntime.engine.grep(grepInput);

    if (config.output === 'json') {
      const { asJsonLine } =
        await import(localModule('../formatters')) as typeof FormattersModule;
      return asJsonLine({ ok: true, data: output });
    }

    return formatRecallHuman(output);
  } finally {
    await activeRuntime?.close();
  }
};
