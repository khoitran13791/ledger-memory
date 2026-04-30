import type {
  ContinuityRecord,
  GetCurrentStateInput,
  GetCurrentStateOutput,
  GetNextStepsInput,
  GetNextStepsOutput,
} from '../ports/driving/continuity.port';

export interface GetNextStepsUseCaseDeps {
  readonly getCurrentState: (input: GetCurrentStateInput) => Promise<GetCurrentStateOutput>;
}

const DEFAULT_LIMIT = 10;

const isActiveNextStep = (record: ContinuityRecord): boolean =>
  record.kind === 'next_step' && record.status === 'active';

export class GetNextStepsUseCase {
  constructor(private readonly deps: GetNextStepsUseCaseDeps) {}

  async execute(input: GetNextStepsInput): Promise<GetNextStepsOutput> {
    const limit = input.limit ?? DEFAULT_LIMIT;

    if (limit < 1) {
      return { nextSteps: [] };
    }

    const currentState = await this.deps.getCurrentState({ conversationId: input.conversationId });

    return {
      nextSteps: currentState.nextSteps.filter(isActiveNextStep).slice(0, limit),
    };
  }
}
