import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as RuntimeModule from '../runtime';
import type { CockpitRuntime } from '../runtime';
import { formatRecallHuman, type RecallRuntime } from './recall';

export interface RunTimelineCommandInput {
  readonly config: CockpitConfig;
  readonly runtime?: RecallRuntime;
  readonly limit?: number;
}

const DEFAULT_TIMELINE_LIMIT = 25;
const TIMELINE_PATTERN = '.+';

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

export const runTimelineCommand = async ({
  config,
  runtime,
  limit = DEFAULT_TIMELINE_LIMIT,
}: RunTimelineCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    activeRuntime ??= await createRuntime(config);

    const binding = await activeRuntime.resolveBinding();
    const firstPage = await activeRuntime.engine.grep({
      conversationId: binding.conversationId,
      pattern: TIMELINE_PATTERN,
      limit: 1,
    });
    const offset = Math.max(0, firstPage.page.totalMatchCount - limit);
    const output =
      firstPage.page.totalMatchCount === 0
        ? firstPage
        : await activeRuntime.engine.grep({
            conversationId: binding.conversationId,
            pattern: TIMELINE_PATTERN,
            offset,
            limit,
          });

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
