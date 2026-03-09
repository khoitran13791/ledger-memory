import { describe, expect, it } from 'vitest';

import { createConversationId, createSummaryNodeId } from '@ledgermind/domain';

import { InvalidReferenceError } from '../../errors/application-errors';
import { GrepUseCase } from '../grep';
import {
  createTestGrepMatch,
  createTestSummary,
  FakeLedgerReadPort,
  FakeSummaryDagPort,
} from './retrieval-test-doubles';

const conversationId = createConversationId('conv_grep_uc');
const scopeSummaryId = createSummaryNodeId('sum_scope_grep_uc');
const outsideSummaryId = createSummaryNodeId('sum_scope_other_uc');

describe('GrepUseCase', () => {
  it('returns conversation-scoped regex matches', async () => {
    const matches = [
      createTestGrepMatch({
        eventIdValue: 'evt_grep_1',
        sequence: 1,
        excerpt: 'alpha token match',
      }),
      createTestGrepMatch({
        eventIdValue: 'evt_grep_3',
        sequence: 3,
        excerpt: 'gamma token found',
      }),
    ] as const;

    const ledgerRead = new FakeLedgerReadPort(matches);
    const summaryDag = new FakeSummaryDagPort();
    const useCase = new GrepUseCase({ ledgerRead, summaryDag });

    const output = await useCase.execute({ conversationId, pattern: 'token' });

    expect(output.matches).toEqual(matches);
    expect(ledgerRead.regexCalls).toEqual([
      {
        conversationId,
        pattern: 'token',
      },
    ]);
  });

  it('supports optional scope and propagates covering summary id', async () => {
    const summary = createTestSummary({
      idValue: 'sum_scope_grep_uc',
      conversationId,
      kind: 'leaf',
      content: 'scope summary',
      tokenCount: 10,
    });

    const matches = [
      createTestGrepMatch({
        eventIdValue: 'evt_grep_1',
        sequence: 1,
        excerpt: 'inside token one',
        coveringSummaryId: scopeSummaryId,
      }),
    ] as const;

    const ledgerRead = new FakeLedgerReadPort(matches);
    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const useCase = new GrepUseCase({ ledgerRead, summaryDag });

    const output = await useCase.execute({
      conversationId,
      pattern: 'token',
      scope: scopeSummaryId,
    });

    expect(output.matches).toEqual(matches);
    expect(summaryDag.getNodeCalls).toEqual([scopeSummaryId]);
    expect(ledgerRead.regexCalls).toEqual([
      {
        conversationId,
        pattern: 'token',
        scope: scopeSummaryId,
      },
    ]);
  });

  it('throws typed invalid-reference error for unknown scope', async () => {
    const ledgerRead = new FakeLedgerReadPort();
    const summaryDag = new FakeSummaryDagPort();
    const useCase = new GrepUseCase({ ledgerRead, summaryDag });

    const execution = useCase.execute({
      conversationId,
      pattern: 'token',
      scope: scopeSummaryId,
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary_scope',
      referenceId: scopeSummaryId,
    });

    expect(ledgerRead.regexCalls).toHaveLength(0);
  });

  it('throws typed invalid-reference error when scope belongs to another conversation', async () => {
    const outsideSummary = createTestSummary({
      idValue: 'sum_scope_other_uc',
      conversationId: createConversationId('conv_other_grep_uc'),
      kind: 'leaf',
      content: 'other scope summary',
      tokenCount: 10,
    });

    const ledgerRead = new FakeLedgerReadPort();
    const summaryDag = new FakeSummaryDagPort({ summaries: [outsideSummary] });
    const useCase = new GrepUseCase({ ledgerRead, summaryDag });

    const execution = useCase.execute({
      conversationId,
      pattern: 'token',
      scope: outsideSummaryId,
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary_scope',
      referenceId: outsideSummaryId,
    });

    expect(ledgerRead.regexCalls).toHaveLength(0);
  });
});
