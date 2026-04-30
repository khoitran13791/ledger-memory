import type { CockpitConfig } from '../config';
import {
  asJsonLine,
  createRuntime,
  requireText,
  type ContinuityRuntime,
} from './continuity-shared';

export type HandoffRuntime = ContinuityRuntime<'createHandoff'>;

export interface RunHandoffCommandInput {
  readonly config: CockpitConfig;
  readonly text: string;
  readStdin?(): Promise<string>;
  readonly runtime?: HandoffRuntime;
}

const readProcessStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8');
};

export const runHandoffCommand = async ({
  config,
  text,
  readStdin = readProcessStdin,
  runtime,
}: RunHandoffCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    const rawText = text.trim().length === 0 ? await readStdin() : text;
    const goal = requireText(rawText, 'handoff');
    activeRuntime ??= await createRuntime(config);
    const binding = await activeRuntime.resolveBinding();
    const output = await activeRuntime.engine.createHandoff({
      conversationId: binding.conversationId,
      goal,
      completed: [goal],
      nextSteps: [],
    });

    return config.output === 'json'
      ? asJsonLine({ ok: true, data: output })
      : `Created handoff ${output.handoff.recordId} in ${String(binding.conversationId)}.\n`;
  } finally {
    await activeRuntime?.close();
  }
};
