import type { ConversationId } from '@ledgermind/domain';

import type { OperatorFailureMetadata } from '../../driving/operator-execution.port';

export interface SubAgentExecutorInput {
  readonly childConversationId: ConversationId;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutSeconds: number;
}

export type SubAgentExecutorResult =
  | {
      readonly status: 'succeeded';
      readonly output: unknown;
    }
  | {
      readonly status: 'failed';
      readonly failure: OperatorFailureMetadata;
    };

export interface SubAgentExecutorPort {
  execute(input: SubAgentExecutorInput): Promise<SubAgentExecutorResult>;
}
