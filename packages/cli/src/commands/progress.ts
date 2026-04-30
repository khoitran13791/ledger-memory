import type { RunDecisionCommandInput } from './decision';
import { runRecordContinuityCommand } from './continuity-shared';

export const runProgressCommand = (input: RunDecisionCommandInput): Promise<string> =>
  runRecordContinuityCommand({ ...input, kind: 'progress' });
