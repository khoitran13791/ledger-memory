import { describe, expect, it } from 'vitest';

import { createConversationId, createEventId, createTimestamp } from '@ledgermind/domain';

import type {
  ContinuityRecord,
  GetCurrentStateInput,
  GetCurrentStateOutput,
} from '../../ports/driving/continuity.port';
import { GetNextStepsUseCase } from '../get-next-steps';

const conversationId = createConversationId('conv_get_next_steps');
const now = createTimestamp(new Date('2026-04-28T10:00:00.000Z'));

const nextStep = (index: number, overrides: Partial<ContinuityRecord> = {}): ContinuityRecord => ({
  recordId: `next:${index}`,
  conversationId,
  kind: 'next_step',
  status: 'active',
  title: `Step ${index}`,
  content: `Do step ${index}.`,
  importance: 'normal',
  provenance: {},
  relatedRecordIds: [],
  supersedesRecordIds: [],
  createdAt: now,
  eventId: createEventId(`evt_next_step_${index}`),
  ...overrides,
});

const currentState = (nextSteps: readonly ContinuityRecord[]): GetCurrentStateOutput => ({
  goalRecords: [],
  decisions: [],
  constraints: [],
  progress: [],
  nextSteps,
  handoffs: [],
  verification: [],
  failures: [],
  openQuestions: [],
  artifactChanges: [],
  sessionSummaries: [],
  activeRecordCount: nextSteps.length,
  staleRecordCount: 0,
});

const createUseCase = (state: GetCurrentStateOutput) => {
  const getCurrentStateCalls: GetCurrentStateInput[] = [];
  const useCase = new GetNextStepsUseCase({
    getCurrentState: async (input) => {
      getCurrentStateCalls.push(input);
      return state;
    },
  });

  return { getCurrentStateCalls, useCase };
};

describe('GetNextStepsUseCase', () => {
  it('returns only active next steps from current state and preserves oldest-first ordering', async () => {
    const orderedSteps = [
      nextStep(1),
      nextStep(2, { status: 'stale' }),
      nextStep(3, { kind: 'progress' }),
      nextStep(4),
    ] as const;
    const { getCurrentStateCalls, useCase } = createUseCase(currentState(orderedSteps));

    const output = await useCase.execute({ conversationId });

    expect(getCurrentStateCalls).toEqual([{ conversationId }]);
    expect(output.nextSteps.map((record) => record.recordId)).toEqual(['next:1', 'next:4']);
  });

  it('defaults to ten next steps', async () => {
    const steps = Array.from({ length: 12 }, (_, index) => nextStep(index + 1));
    const { useCase } = createUseCase(currentState(steps));

    const output = await useCase.execute({ conversationId });

    expect(output.nextSteps.map((record) => record.recordId)).toEqual(
      steps.slice(0, 10).map((record) => record.recordId),
    );
  });

  it('preserves current-state sequence order even when later steps have higher importance', async () => {
    const steps = [
      nextStep(1, { importance: 'normal' }),
      nextStep(2, { importance: 'critical' }),
      nextStep(3, { importance: 'low' }),
      nextStep(4, { importance: 'high' }),
      nextStep(5, { importance: 'normal' }),
    ] as const;
    const state = currentState(steps);
    const { useCase } = createUseCase(state);

    const output = await useCase.execute({ conversationId, limit: 4 });

    expect(output.nextSteps.map((record) => record.recordId)).toEqual([
      'next:1',
      'next:2',
      'next:3',
      'next:4',
    ]);
    expect(state.nextSteps.map((record) => record.recordId)).toEqual([
      'next:1',
      'next:2',
      'next:3',
      'next:4',
      'next:5',
    ]);
  });

  it('does not treat matching timestamps as sequence ties', async () => {
    const sharedTimestamp = createTimestamp(new Date('2026-04-28T11:00:00.000Z'));
    const steps = [
      nextStep(1, { createdAt: sharedTimestamp, importance: 'normal' }),
      nextStep(2, { createdAt: sharedTimestamp, importance: 'critical' }),
      nextStep(3, { createdAt: sharedTimestamp, importance: 'high' }),
    ] as const;
    const { useCase } = createUseCase(currentState(steps));

    const output = await useCase.execute({ conversationId });

    expect(output.nextSteps.map((record) => record.recordId)).toEqual([
      'next:1',
      'next:2',
      'next:3',
    ]);
  });

  it('returns no next steps when limit is less than one', async () => {
    const { useCase } = createUseCase(currentState([nextStep(1)]));

    const output = await useCase.execute({ conversationId, limit: 0 });

    expect(output.nextSteps).toEqual([]);
  });

  it('preserves current-state order when records are not tied', async () => {
    const steps = [
      nextStep(1, { createdAt: createTimestamp(new Date('2026-04-28T10:03:00.000Z')) }),
      nextStep(2, {
        createdAt: createTimestamp(new Date('2026-04-28T10:01:00.000Z')),
        importance: 'critical',
      }),
      nextStep(3, { createdAt: createTimestamp(new Date('2026-04-28T10:02:00.000Z')) }),
    ] as const;
    const { useCase } = createUseCase(currentState(steps));

    const output = await useCase.execute({ conversationId });

    expect(output.nextSteps.map((record) => record.recordId)).toEqual([
      'next:1',
      'next:2',
      'next:3',
    ]);
  });
});
