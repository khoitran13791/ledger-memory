import { describe, expect, it } from 'vitest';

import {
  createConversationId,
  createEventId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import {
  ContinuityInputValidationError,
  type ContinuityInputField,
} from '../../errors/application-errors';
import type {
  ContinuityProvenance,
  ContinuityRecord,
  RecordContinuityInput,
  RecordContinuityOutput,
} from '../../ports/driving/continuity.port';
import { CreateHandoffUseCase } from '../create-handoff';

const conversationId = createConversationId('conv_create_handoff');
const createdAt = createTimestamp(new Date('2026-04-28T12:00:00.000Z'));

const createRecord = (input: RecordContinuityInput, index: number): ContinuityRecord => ({
  recordId: input.idempotencyKey ?? `${input.kind}:${input.title.toLowerCase()}`,
  conversationId: input.conversationId,
  kind: input.kind,
  status: input.status ?? 'active',
  title: input.title.trim(),
  content: input.content.trim(),
  importance: input.importance ?? 'normal',
  provenance: input.provenance ?? {},
  relatedRecordIds: input.relatedRecordIds ?? [],
  supersedesRecordIds: input.supersedesRecordIds ?? [],
  createdAt,
  eventId: createEventId(`evt_create_handoff_${index}`),
});

const createUseCase = () => {
  const recordContinuityCalls: RecordContinuityInput[] = [];

  const useCase = new CreateHandoffUseCase({
    recordContinuity: async (input): Promise<RecordContinuityOutput> => {
      recordContinuityCalls.push(input);

      return {
        record: createRecord(input, recordContinuityCalls.length),
        contextTokenCount: createTokenCount(10),
      };
    },
  });

  return { recordContinuityCalls, useCase };
};

describe('CreateHandoffUseCase', () => {
  it('rejects blank goal without writing continuity records', async () => {
    const { recordContinuityCalls, useCase } = createUseCase();

    const promise = useCase.execute({
      conversationId,
      goal: '   ',
      completed: [],
      nextSteps: [],
    });

    await expect(promise).rejects.toBeInstanceOf(ContinuityInputValidationError);
    await expect(promise).rejects.toMatchObject({
      code: 'CONTINUITY_INPUT_INVALID',
      field: 'title' satisfies ContinuityInputField,
    });
    expect(recordContinuityCalls).toHaveLength(0);
  });

  it('rejects blank next steps before writing a partial handoff', async () => {
    const { recordContinuityCalls, useCase } = createUseCase();

    const promise = useCase.execute({
      conversationId,
      goal: 'Resume implementation',
      completed: ['Wrote handoff tests.'],
      nextSteps: [{ title: '  ', content: 'Implement the use case.' }],
    });

    await expect(promise).rejects.toBeInstanceOf(ContinuityInputValidationError);
    await expect(promise).rejects.toMatchObject({
      code: 'CONTINUITY_INPUT_INVALID',
      field: 'title' satisfies ContinuityInputField,
    });
    expect(recordContinuityCalls).toHaveLength(0);
  });

  it('writes a deterministic structured handoff and next-step records', async () => {
    const { recordContinuityCalls, useCase } = createUseCase();
    const provenance: ContinuityProvenance = {
      transcriptPath: '/tmp/session.jsonl',
      transcriptLineStart: 3,
      transcriptLineEnd: 42,
      toolUseId: 'toolu_handoff',
      command: 'pnpm test',
    };

    const output = await useCase.execute({
      conversationId,
      goal: '  Ship structured handoff  ',
      completed: ['  Added continuity DTOs  ', '', 'Wired record continuity'],
      nextSteps: [
        {
          title: '  Add current state projection  ',
          content: '  Implement getCurrentState tests first. ',
        },
        {
          title: 'Capture task recall',
          content: 'Build recallForTask from current state.',
          importance: 'high',
          provenance: { command: 'pnpm --filter @ledgermind/application test' },
        },
      ],
      decisions: [' Use recordContinuity as the only write path. '],
      constraints: ['No persistence access in create handoff.'],
      openQuestions: ['Should task recall include stale records?'],
      verification: ['pnpm --filter @ledgermind/application test -- create-handoff'],
      risks: ['SDK still has later continuity stubs.'],
      changedFiles: [
        'packages/application/src/use-cases/create-handoff.ts',
        ' packages/sdk/src/index.ts ',
      ],
      provenance,
    });

    expect(recordContinuityCalls).toEqual([
      {
        conversationId,
        kind: 'handoff',
        title: 'Continue: Ship structured handoff',
        content: [
          'Goal:',
          '- Ship structured handoff',
          '',
          'Completed:',
          '- Added continuity DTOs',
          '- Wired record continuity',
          '',
          'Next steps:',
          '- Add current state projection',
          '- Capture task recall',
          '',
          'Decisions:',
          '- Use recordContinuity as the only write path.',
          '',
          'Constraints:',
          '- No persistence access in create handoff.',
          '',
          'Open questions:',
          '- Should task recall include stale records?',
          '',
          'Verification:',
          '- pnpm --filter @ledgermind/application test -- create-handoff',
          '',
          'Risks:',
          '- SDK still has later continuity stubs.',
          '',
          'Changed files:',
          '- packages/application/src/use-cases/create-handoff.ts',
          '- packages/sdk/src/index.ts',
        ].join('\n'),
        importance: 'normal',
        provenance,
      },
      {
        conversationId,
        kind: 'next_step',
        title: 'Add current state projection',
        content: 'Implement getCurrentState tests first.',
        provenance,
      },
      {
        conversationId,
        kind: 'next_step',
        title: 'Capture task recall',
        content: 'Build recallForTask from current state.',
        importance: 'high',
        provenance: { command: 'pnpm --filter @ledgermind/application test' },
      },
    ]);
    expect(output.handoff.kind).toBe('handoff');
    expect(output.handoff.title).toBe('Continue: Ship structured handoff');
    expect(output.nextStepRecords).toHaveLength(2);
    expect(output.nextStepRecords.map((record) => record.kind)).toEqual(['next_step', 'next_step']);
  });

  it('passes stable idempotency keys to the handoff and child next-step records', async () => {
    const { recordContinuityCalls, useCase } = createUseCase();
    const provenance: ContinuityProvenance = { transcriptPath: '/tmp/handoff.jsonl' };

    await useCase.execute({
      conversationId,
      goal: 'Resume SDK wiring',
      completed: ['Record continuity exists.'],
      nextSteps: [
        { title: 'Instantiate use case', content: 'Create after recordContinuityUseCase.' },
        { title: 'Replace stub', content: 'Call createHandoffUseCase.execute().' },
      ],
      provenance,
      idempotencyKey: 'handoff:task-5',
    });

    expect(recordContinuityCalls.map((call) => call.idempotencyKey)).toEqual([
      'handoff:task-5',
      'handoff:task-5:next-step:0',
      'handoff:task-5:next-step:1',
    ]);
    expect(recordContinuityCalls.map((call) => call.provenance)).toEqual([
      provenance,
      provenance,
      provenance,
    ]);
  });

  it('waits for each next-step write before starting the next one', async () => {
    const startedCalls: string[] = [];
    const finishedCalls: string[] = [];
    const useCase = new CreateHandoffUseCase({
      recordContinuity: async (input): Promise<RecordContinuityOutput> => {
        startedCalls.push(input.title);
        await Promise.resolve();
        finishedCalls.push(input.title);

        return {
          record: createRecord(input, startedCalls.length),
          contextTokenCount: createTokenCount(10),
        };
      },
    });

    await useCase.execute({
      conversationId,
      goal: 'Preserve next-step order',
      completed: ['Created handoff.'],
      nextSteps: [
        { title: 'First child', content: 'Persist first.' },
        { title: 'Second child', content: 'Persist second.' },
      ],
    });

    expect(startedCalls).toEqual([
      'Continue: Preserve next-step order',
      'First child',
      'Second child',
    ]);
    expect(finishedCalls).toEqual([
      'Continue: Preserve next-step order',
      'First child',
      'Second child',
    ]);
  });
});
