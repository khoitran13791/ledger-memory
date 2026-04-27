import { createTokenCount } from '@ledgermind/domain';

import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';
import type * as RuntimeModule from '../runtime';
import type { CockpitRuntime } from '../runtime';
import type { AppendLedgerEventsInput, MemoryEngine } from '@ledgermind/sdk';
import type { SessionBindingRecord } from '@ledgermind/mcp-server';

export interface RememberRuntime {
  readonly engine: Pick<MemoryEngine, 'append'>;
  resolveBinding(): Promise<SessionBindingRecord>;
  close(): Promise<void>;
}

export interface RunRememberCommandInput {
  readonly config: CockpitConfig;
  readonly text: string;
  readonly runtime?: RememberRuntime;
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

const estimateTokenCount = (text: string) =>
  createTokenCount(Math.max(1, Math.ceil(text.length / 4)));

const createRememberIdempotencyKey = (config: CockpitConfig, text: string): string =>
  JSON.stringify({
    scope: 'cli:remember',
    workspaceScope: config.workspaceScope,
    text,
  });

const createRememberAppendInput = (
  config: CockpitConfig,
  binding: SessionBindingRecord,
  text: string,
): AppendLedgerEventsInput => ({
  conversationId: binding.conversationId,
  idempotencyKey: createRememberIdempotencyKey(config, text),
  events: [
    {
      role: 'system',
      content: text,
      tokenCount: estimateTokenCount(text),
      metadata: {
        source: 'ledgermind-cli',
        kind: 'manual_note',
        workspaceScope: config.workspaceScope,
        ...(config.branchScope === undefined ? {} : { branchScope: config.branchScope }),
      },
    },
  ],
});

export const runRememberCommand = async ({
  config,
  text,
  runtime,
}: RunRememberCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    if (text.trim().length === 0) {
      throw new Error('remember requires non-empty text.');
    }

    activeRuntime ??= await createRuntime(config);

    const binding = await activeRuntime.resolveBinding();
    await activeRuntime.engine.append(createRememberAppendInput(config, binding, text));

    if (config.output === 'json') {
      const { asJsonLine } =
        await import(localModule('../formatters')) as typeof FormattersModule;
      return asJsonLine({ ok: true, conversationId: String(binding.conversationId) });
    }

    return `Remembered note in ${String(binding.conversationId)}.\n`;
  } finally {
    await activeRuntime?.close();
  }
};
