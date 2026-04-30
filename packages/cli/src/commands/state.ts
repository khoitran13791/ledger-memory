import type { CockpitConfig } from '../config';
import {
  asJsonLine,
  createRuntime,
  formatCurrentStateHuman,
  type ContinuityRuntime,
} from './continuity-shared';

export type StateRuntime = ContinuityRuntime<'getCurrentState'>;

export interface RunStateCommandInput {
  readonly config: CockpitConfig;
  readonly runtime?: StateRuntime;
}

export const runStateCommand = async ({
  config,
  runtime,
}: RunStateCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    activeRuntime ??= await createRuntime(config);
    const binding = await activeRuntime.resolveBinding();
    const output = await activeRuntime.engine.getCurrentState({
      conversationId: binding.conversationId,
    });

    return config.output === 'json'
      ? asJsonLine({ ok: true, data: output })
      : formatCurrentStateHuman(output);
  } finally {
    await activeRuntime?.close();
  }
};
