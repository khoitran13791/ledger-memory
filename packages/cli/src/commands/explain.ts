import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as RuntimeModule from '../runtime';
import type { CockpitRuntime } from '../runtime';
import type { DescribeInput, DescribeOutput, MemoryEngine } from '@ledgermind/sdk';

export interface ExplainRuntime {
  readonly engine: Pick<MemoryEngine, 'describe'>;
  close(): Promise<void>;
}

export interface RunExplainCommandInput {
  readonly config: CockpitConfig;
  readonly id: string;
  readonly runtime?: ExplainRuntime;
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

export const formatExplainHuman = (id: string, output: DescribeOutput): string => {
  const lines = [
    `Reference ${id}\n`,
    `Kind: ${output.kind}\n`,
    `Tokens: ${output.tokenCount.value}\n`,
  ];

  if (output.explorationSummary !== undefined) {
    lines.push(`Summary: ${output.explorationSummary}\n`);
  }

  return lines.join('');
};

export const runExplainCommand = async ({
  config,
  id,
  runtime,
}: RunExplainCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    const trimmedId = id.trim();
    if (trimmedId.length === 0) {
      throw new Error('explain requires a summary or artifact id.');
    }

    activeRuntime ??= await createRuntime(config);

    const output = await activeRuntime.engine.describe({ id: trimmedId as DescribeInput['id'] });

    if (config.output === 'json') {
      const { asJsonLine } =
        await import(localModule('../formatters')) as typeof FormattersModule;
      return asJsonLine({ ok: true, data: output });
    }

    return formatExplainHuman(trimmedId, output);
  } finally {
    await activeRuntime?.close();
  }
};
