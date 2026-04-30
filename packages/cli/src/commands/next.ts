import type { CockpitConfig } from '../config';
import {
  asJsonLine,
  createRuntime,
  formatNextStepsHuman,
  type ContinuityRuntime,
} from './continuity-shared';

export type NextRuntime = ContinuityRuntime<'getNextSteps'>;

export interface RunNextCommandInput {
  readonly config: CockpitConfig;
  readonly runtime?: NextRuntime;
}

export const runNextCommand = async ({ config, runtime }: RunNextCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    activeRuntime ??= await createRuntime(config);
    const binding = await activeRuntime.resolveBinding();
    const output = await activeRuntime.engine.getNextSteps({
      conversationId: binding.conversationId,
    });

    return config.output === 'json'
      ? asJsonLine({ ok: true, data: output })
      : formatNextStepsHuman(output);
  } finally {
    await activeRuntime?.close();
  }
};
