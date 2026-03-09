import type { ExpandInput, ExpandOutput } from '../ports/driving/memory-engine.port';
import type { AuthorizationPort } from '../ports/driven/auth/authorization.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import { InvalidReferenceError, UnauthorizedExpandError } from '../errors/application-errors';

export interface ExpandUseCaseDeps {
  readonly authorization: AuthorizationPort;
  readonly summaryDag: SummaryDagPort;
}

export class ExpandUseCase {
  constructor(private readonly deps: ExpandUseCaseDeps) {}

  async execute(input: ExpandInput): Promise<ExpandOutput> {
    if (!this.deps.authorization.canExpand(input.callerContext)) {
      throw new UnauthorizedExpandError(input.callerContext.conversationId, input.summaryId);
    }

    const summaryNode = await this.deps.summaryDag.getNode(input.summaryId);
    if (!summaryNode || summaryNode.conversationId !== input.callerContext.conversationId) {
      throw new InvalidReferenceError('summary', input.summaryId);
    }

    const messages = await this.deps.summaryDag.expandToMessages(input.summaryId);
    return { messages };
  }
}
