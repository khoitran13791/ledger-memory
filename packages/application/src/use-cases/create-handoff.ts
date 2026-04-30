import { ContinuityInputValidationError } from '../errors/application-errors';
import type {
  CreateHandoffInput,
  CreateHandoffOutput,
  HandoffNextStep,
  RecordContinuityInput,
  RecordContinuityOutput,
} from '../ports/driving/continuity.port';

export interface CreateHandoffUseCaseDeps {
  readonly recordContinuity: (input: RecordContinuityInput) => Promise<RecordContinuityOutput>;
}

const assertNonBlank = (value: string, field: 'title' | 'content'): string => {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new ContinuityInputValidationError(field);
  }

  return trimmed;
};

const trimNonBlank = (values: readonly string[] | undefined): readonly string[] => {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
};

const formatSection = (heading: string, items: readonly string[]): string | undefined => {
  if (items.length === 0) {
    return undefined;
  }

  return [heading, ...items.map((item) => `- ${item}`)].join('\n');
};

const formatHandoffContent = (
  goal: string,
  input: CreateHandoffInput,
  nextSteps: readonly HandoffNextStep[],
): string => {
  const sections = [
    formatSection('Goal:', [goal]),
    formatSection('Completed:', trimNonBlank(input.completed)),
    formatSection(
      'Next steps:',
      nextSteps.map((step) => step.title),
    ),
    formatSection('Decisions:', trimNonBlank(input.decisions)),
    formatSection('Constraints:', trimNonBlank(input.constraints)),
    formatSection('Open questions:', trimNonBlank(input.openQuestions)),
    formatSection('Verification:', trimNonBlank(input.verification)),
    formatSection('Risks:', trimNonBlank(input.risks)),
    formatSection('Changed files:', trimNonBlank(input.changedFiles)),
  ].filter((section): section is string => section !== undefined);

  return sections.join('\n\n');
};

const normalizeNextStep = (step: HandoffNextStep): HandoffNextStep => ({
  title: assertNonBlank(step.title, 'title'),
  content: assertNonBlank(step.content, 'content'),
  ...(step.importance === undefined ? {} : { importance: step.importance }),
  ...(step.provenance === undefined ? {} : { provenance: step.provenance }),
});

export class CreateHandoffUseCase {
  constructor(private readonly deps: CreateHandoffUseCaseDeps) {}

  async execute(input: CreateHandoffInput): Promise<CreateHandoffOutput> {
    const goal = assertNonBlank(input.goal, 'title');
    const nextSteps = input.nextSteps.map(normalizeNextStep);
    const handoffOutput = await this.deps.recordContinuity({
      conversationId: input.conversationId,
      kind: 'handoff',
      title: `Continue: ${goal}`,
      content: formatHandoffContent(goal, input, nextSteps),
      importance: 'normal',
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });

    const nextStepRecords = [];

    for (const [index, step] of nextSteps.entries()) {
      const provenance = step.provenance ?? input.provenance;
      const nextStepOutput = await this.deps.recordContinuity({
        conversationId: input.conversationId,
        kind: 'next_step',
        title: step.title,
        content: step.content,
        ...(step.importance === undefined ? {} : { importance: step.importance }),
        ...(provenance === undefined ? {} : { provenance }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: `${input.idempotencyKey}:next-step:${index}` }),
      });

      nextStepRecords.push(nextStepOutput.record);
    }

    return {
      handoff: handoffOutput.record,
      nextStepRecords,
    };
  }
}
