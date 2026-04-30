import type { RunDecisionCommandInput } from './decision';
import { runRecordContinuityCommand } from './continuity-shared';

export const runVerifyCommand = (input: RunDecisionCommandInput): Promise<string> =>
  runRecordContinuityCommand({ ...input, kind: 'verification' });
