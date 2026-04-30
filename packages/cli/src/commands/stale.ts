import type { CockpitConfig } from '../config';
import { asJsonLine, createRuntime, type ContinuityRuntime } from './continuity-shared';

export type StaleRuntime = ContinuityRuntime<'markContinuityRecord'>;

export interface RunStaleCommandInput {
  readonly config: CockpitConfig;
  readonly recordId: string;
  readonly reason?: string;
  readonly runtime?: StaleRuntime;
}

export const runStaleCommand = async ({
  config,
  recordId,
  reason = 'Marked stale from CLI.',
  runtime,
}: RunStaleCommandInput): Promise<string> => {
  let activeRuntime = runtime;

  try {
    const targetRecordId = recordId.trim();
    if (targetRecordId.length === 0) {
      throw new Error('stale requires a record id.');
    }

    activeRuntime ??= await createRuntime(config);
    const binding = await activeRuntime.resolveBinding();
    const output = await activeRuntime.engine.markContinuityRecord({
      conversationId: binding.conversationId,
      recordId: targetRecordId,
      status: 'stale',
      reason,
    });

    return config.output === 'json'
      ? asJsonLine({ ok: true, data: output })
      : `Marked ${targetRecordId} stale in ${String(binding.conversationId)}.\n`;
  } finally {
    await activeRuntime?.close();
  }
};
