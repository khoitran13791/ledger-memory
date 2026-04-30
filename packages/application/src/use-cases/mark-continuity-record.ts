import type {
  MarkContinuityRecordInput,
  MarkContinuityRecordOutput,
  RecordContinuityInput,
  RecordContinuityOutput,
} from '../ports/driving/continuity.port';

export interface MarkContinuityRecordUseCaseDeps {
  readonly recordContinuity: (input: RecordContinuityInput) => Promise<RecordContinuityOutput>;
}

export class MarkContinuityRecordUseCase {
  constructor(private readonly deps: MarkContinuityRecordUseCaseDeps) {}

  async execute(input: MarkContinuityRecordInput): Promise<MarkContinuityRecordOutput> {
    const output = await this.deps.recordContinuity({
      conversationId: input.conversationId,
      kind: 'session_summary',
      title: `Mark ${input.recordId} ${input.status}`,
      content: `Record ${input.recordId} marked ${input.status}: ${input.reason}`,
      status: input.status,
      relatedRecordIds: [input.recordId],
      supersedesRecordIds: [input.recordId],
      ...(input.supersededByRecordId === undefined
        ? {}
        : { supersededByRecordId: input.supersededByRecordId }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });

    return {
      marker: output.record,
    };
  }
}
