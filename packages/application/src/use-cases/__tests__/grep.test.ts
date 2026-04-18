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
  it('returns grouped paginated matches with stable page metadata', async () => {
    const alphaCoverage = createSummaryNodeId('sum_grep_alpha');
    const betaCoverage = createSummaryNodeId('sum_grep_beta');

    const matches = [
      createTestGrepMatch({
        eventIdValue: 'evt_grep_1',
        sequence: 1,
        excerpt: 'alpha token one',
        coveringSummaryId: alphaCoverage,
      }),
      createTestGrepMatch({
        eventIdValue: 'evt_grep_2',
        sequence: 2,
        excerpt: 'alpha token two',
        coveringSummaryId: alphaCoverage,
      }),
      createTestGrepMatch({
        eventIdValue: 'evt_grep_3',
        sequence: 3,
        excerpt: 'beta token three',
        coveringSummaryId: betaCoverage,
      }),
    ] as const;

    const ledgerRead = new FakeLedgerReadPort({
      matches,
      totalMatchCount: 3,
    });
    const summaryDag = new FakeSummaryDagPort();
    const useCase = new GrepUseCase({ ledgerRead, summaryDag });

    const output = await useCase.execute({ conversationId, pattern: 'token' });

    expect(output.groups).toEqual([
      {
        coveringSummaryId: alphaCoverage,
        matches: [
          {
            eventId: matches[0].eventId,
            sequence: matches[0].sequence,
            excerpt: matches[0].excerpt,
          },
          {
            eventId: matches[1].eventId,
            sequence: matches[1].sequence,
            excerpt: matches[1].excerpt,
          },
        ],
      },
      {
        coveringSummaryId: betaCoverage,
        matches: [
          {
            eventId: matches[2].eventId,
            sequence: matches[2].sequence,
            excerpt: matches[2].excerpt,
          },
        ],
      },
    ]);
    expect(output.page).toEqual({
      offset: 0,
      limit: 25,
      returnedMatchCount: 3,
      totalMatchCount: 3,
      hasMore: false,
    });
    expect(ledgerRead.regexCalls).toEqual([
      {
        conversationId,
        pattern: 'token',
        offset: 0,
        limit: 25,
      },
    ]);
  });

  it('emits nextOffset when more matches remain after the current page', async () => {
    const summary = createTestSummary({
      idValue: 'sum_scope_grep_uc',
      conversationId,
      kind: 'condensed',
      content: 'scope summary',
      tokenCount: 10,
    });

    const match = createTestGrepMatch({
      eventIdValue: 'evt_grep_1',
      sequence: 1,
      excerpt: 'inside token one',
      coveringSummaryId: scopeSummaryId,
    });

    const ledgerRead = new FakeLedgerReadPort({
      matches: [match],
      totalMatchCount: 4,
    });
    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const useCase = new GrepUseCase({ ledgerRead, summaryDag });

    const output = await useCase.execute({
      conversationId,
      pattern: 'token',
      scope: scopeSummaryId,
      offset: 1,
      limit: 1,
    });

    expect(output.groups).toEqual([
      {
        coveringSummaryId: scopeSummaryId,
        matches: [
          {
            eventId: match.eventId,
            sequence: match.sequence,
            excerpt: match.excerpt,
          },
        ],
      },
    ]);
    expect(output.page).toEqual({
      offset: 1,
      limit: 1,
      returnedMatchCount: 1,
      totalMatchCount: 4,
      hasMore: true,
      nextOffset: 2,
    });
    expect(summaryDag.getNodeCalls).toEqual([scopeSummaryId]);
    expect(ledgerRead.regexCalls).toEqual([
      {
        conversationId,
        pattern: 'token',
        scope: scopeSummaryId,
        offset: 1,
        limit: 1,
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
