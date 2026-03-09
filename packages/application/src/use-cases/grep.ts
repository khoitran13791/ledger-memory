import { InvalidReferenceError } from '../errors/application-errors';
import type { LedgerReadPort } from '../ports/driven/persistence/ledger-read.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import type { GrepInput, GrepOutput } from '../ports/driving/memory-engine.port';

export interface GrepUseCaseDeps {
  readonly ledgerRead: LedgerReadPort;
  readonly summaryDag: SummaryDagPort;
}

export class GrepUseCase {
  constructor(private readonly deps: GrepUseCaseDeps) {}

  async execute(input: GrepInput): Promise<GrepOutput> {
    if (input.scope) {
      const summaryNode = await this.deps.summaryDag.getNode(input.scope);
      if (!summaryNode || summaryNode.conversationId !== input.conversationId) {
        throw new InvalidReferenceError(
          'summary_scope',
          input.scope,
          `Unknown summary scope reference: ${input.scope}`,
        );
      }
    }

    const matches = await this.deps.ledgerRead.regexSearchEvents(
      input.conversationId,
      input.pattern,
      input.scope,
    );

    return { matches };
  }
}
