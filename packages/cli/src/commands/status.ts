import { readFile } from 'node:fs/promises';

import type { CockpitConfig } from '../config';
import type * as FormattersModule from '../formatters';

export interface StatusBindingRecord {
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly userScope: string;
  readonly workspaceScope: string;
  readonly branchScope?: string;
  readonly conversationId: string;
  readonly parentConversationId?: string;
}

export interface RunStatusCommandInput {
  readonly config: CockpitConfig;
  listBindings?(): Promise<readonly StatusBindingRecord[]>;
}

const listFileBindings = async (
  bindingStorePath: string,
): Promise<readonly StatusBindingRecord[]> => {
  try {
    return JSON.parse(await readFile(bindingStorePath, 'utf8')) as StatusBindingRecord[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const localModule = (specifier: string): string =>
  new URL(
    import.meta.url.endsWith('.ts') ? `${specifier}.ts` : `${specifier}.js`,
    import.meta.url,
  ).href;

export const runStatusCommand = async ({
  config,
  listBindings = () => listFileBindings(config.bindingStorePath),
}: RunStatusCommandInput): Promise<string> => {
  const bindings = await listBindings();
  const { asJsonLine, bullet } =
    await import(localModule('../formatters')) as typeof FormattersModule;

  if (config.output === 'json') {
    return asJsonLine({
      ok: true,
      storage: { type: config.storage.type },
      bindingStorePath: config.bindingStorePath,
      bindingCount: bindings.length,
      runtimeSessionId: config.runtimeSessionId,
      ...(config.parentRuntimeSessionId === undefined
        ? {}
        : { parentRuntimeSessionId: config.parentRuntimeSessionId }),
      workspaceScope: config.workspaceScope,
      ...(config.branchScope === undefined ? {} : { branchScope: config.branchScope }),
    });
  }

  return [
    'LedgerMind status\n',
    bullet('Storage', config.storage.type),
    bullet('Binding store', config.bindingStorePath),
    bullet('Bindings', bindings.length),
    bullet('Runtime session', config.runtimeSessionId),
    config.parentRuntimeSessionId === undefined
      ? ''
      : bullet('Parent runtime session', config.parentRuntimeSessionId),
    bullet('Workspace', config.workspaceScope),
    config.branchScope === undefined ? '' : bullet('Branch', config.branchScope),
  ].join('');
};
