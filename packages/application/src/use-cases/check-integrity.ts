import { ConversationNotFoundError, IntegrityCheckExecutionError } from '../errors/application-errors';
import type { ConversationPort } from '../ports/driven/persistence/conversation.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import type { CheckIntegrityInput, CheckIntegrityOutput } from '../ports/driving/memory-engine.port';

export interface CheckIntegrityUseCaseDeps {
  readonly conversations: ConversationPort;
  readonly summaryDag: SummaryDagPort;
}

export class CheckIntegrityUseCase {
  constructor(private readonly deps: CheckIntegrityUseCaseDeps) {}

  async execute(input: CheckIntegrityInput): Promise<CheckIntegrityOutput> {
    const conversation = await this.deps.conversations.get(input.conversationId);
    if (conversation === null) {
      throw new ConversationNotFoundError(input.conversationId);
    }

    try {
      const report = await this.deps.summaryDag.checkIntegrity(input.conversationId);
      return { report };
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      throw new IntegrityCheckExecutionError(input.conversationId, message);
    }
  }
}
