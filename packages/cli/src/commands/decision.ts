import type { CockpitConfig } from '../config';
import { runRecordContinuityCommand, type ContinuityRuntime } from './continuity-shared';

export type RecordContinuityRuntime = ContinuityRuntime<'recordContinuity'>;

export interface RunDecisionCommandInput {
  readonly config: CockpitConfig;
  readonly text: string;
  readonly runtime?: RecordContinuityRuntime;
}

export const runDecisionCommand = (input: RunDecisionCommandInput): Promise<string> =>
  runRecordContinuityCommand({ ...input, kind: 'decision' });
