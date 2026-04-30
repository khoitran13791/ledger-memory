import type { CockpitConfig } from '../config';
import {
  asJsonLine,
  createRuntime,
  requireText,
  type ContinuityRuntime,
} from './continuity-shared';

export type TaskRuntime = ContinuityRuntime<'recallForTask'>;

export interface RunTaskCommandInput {
  readonly config: CockpitConfig;
  readonly prompt: string;
  readonly runtime?: TaskRuntime;
  readonly budgetTokens?: number;
}

export const runTaskCommand = async ({
  config,
  prompt,
  runtime,
  budgetTokens = 1200,
}: RunTaskCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    const task = requireText(prompt, 'task');
    activeRuntime ??= await createRuntime(config);
    const binding = await activeRuntime.resolveBinding();
    const output = await activeRuntime.engine.recallForTask({
      conversationId: binding.conversationId,
      task,
      budgetTokens,
      includeHandoff: true,
      includeEvidence: true,
    });

    return config.output === 'json'
      ? asJsonLine({ ok: true, data: output })
      : `${output.contextBlock}\n`;
  } finally {
    await activeRuntime?.close();
  }
};
