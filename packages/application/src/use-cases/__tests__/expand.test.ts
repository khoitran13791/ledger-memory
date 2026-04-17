import { describe, expect, it } from 'vitest';

import { createConversationId, createSummaryNodeId } from '@ledgermind/domain';

import type { CallerContext } from '../../ports/driven/auth/authorization.port';
import { InvalidReferenceError, UnauthorizedExpandError } from '../../errors/application-errors';
import { ExpandUseCase } from '../expand';
import {
  createTestConversation,
  createTestLedgerEvent,
  createTestSummary,
  FakeAuthorizationPort,
  FakeConversationPort,
  FakeSummaryDagPort,
} from './retrieval-test-doubles';

const conversationId = createConversationId('conv_expand_uc');
const parentConversationId = createConversationId('conv_expand_parent_uc');
const summaryId = createSummaryNodeId('sum_expand_uc');
const missingSummaryId = createSummaryNodeId('sum_missing_expand_uc');

const createCaller = (isSubAgent: boolean): CallerContext => ({
  conversationId,
  isSubAgent,
  parentConversationId,
});

describe('ExpandUseCase', () => {
  it('returns ordered source messages for authorized caller', async () => {
    const summary = createTestSummary({
      idValue: 'sum_expand_uc',
      conversationId,
      kind: 'leaf',
      content: 'expandable summary',
      tokenCount: 20,
    });

    const event1 = createTestLedgerEvent({
      idValue: 'evt_expand_1',
      conversationId,
      sequence: 1,
      content: 'first source event',
    });
    const event2 = createTestLedgerEvent({
      idValue: 'evt_expand_2',
      conversationId,
      sequence: 2,
      content: 'second source event',
    });

    const summaryDag = new FakeSummaryDagPort({
      summaries: [summary],
      expandedMessagesBySummaryId: new Map([[summaryId, [event1, event2]]]),
    });
    const authorization = new FakeAuthorizationPort(true);
    const conversations = new FakeConversationPort([
      createTestConversation('conv_expand_parent_uc'),
      createTestConversation('conv_expand_uc', parentConversationId),
    ]);

    const useCase = new ExpandUseCase({ authorization, conversations, summaryDag });
    const output = await useCase.execute({
      summaryId,
      callerContext: createCaller(true),
    });

    expect(output.messages.map((message) => message.sequence)).toEqual([event1.sequence, event2.sequence]);
    expect(output.messages.map((message) => message.id)).toEqual([event1.id, event2.id]);
    expect(summaryDag.expandCalls).toEqual([summaryId]);
  });

  it('throws typed authorization error for unauthorized caller', async () => {
    const authorization = new FakeAuthorizationPort(false);
    const summaryDag = new FakeSummaryDagPort();
    const conversations = new FakeConversationPort([
      createTestConversation('conv_expand_parent_uc'),
      createTestConversation('conv_expand_uc', parentConversationId),
    ]);

    const useCase = new ExpandUseCase({ authorization, conversations, summaryDag });

    const execution = useCase.execute({
      summaryId,
      callerContext: createCaller(false),
    });

    await expect(execution).rejects.toBeInstanceOf(UnauthorizedExpandError);
    await expect(execution).rejects.toMatchObject({
      code: 'UNAUTHORIZED_EXPAND',
      conversationId,
      summaryId,
    });

    expect(summaryDag.getNodeCalls).toHaveLength(0);
    expect(summaryDag.expandCalls).toHaveLength(0);
  });

  it('throws typed invalid-reference error for unknown summary', async () => {
    const authorization = new FakeAuthorizationPort(true);
    const summaryDag = new FakeSummaryDagPort();
    const conversations = new FakeConversationPort([
      createTestConversation('conv_expand_parent_uc'),
      createTestConversation('conv_expand_uc', parentConversationId),
    ]);

    const useCase = new ExpandUseCase({ authorization, conversations, summaryDag });

    const execution = useCase.execute({
      summaryId: missingSummaryId,
      callerContext: createCaller(true),
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary',
      referenceId: missingSummaryId,
    });

    expect(summaryDag.expandCalls).toHaveLength(0);
  });

  it('throws typed invalid-reference error when summary belongs to another conversation', async () => {
    const summary = createTestSummary({
      idValue: 'sum_expand_uc',
      conversationId: createConversationId('conv_other_expand_uc'),
      kind: 'leaf',
      content: 'other conversation summary',
      tokenCount: 10,
    });

    const authorization = new FakeAuthorizationPort(true);
    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const conversations = new FakeConversationPort([
      createTestConversation('conv_expand_parent_uc'),
      createTestConversation('conv_expand_uc', parentConversationId),
    ]);

    const useCase = new ExpandUseCase({ authorization, conversations, summaryDag });

    const execution = useCase.execute({
      summaryId,
      callerContext: createCaller(true),
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary',
      referenceId: summaryId,
    });

    expect(summaryDag.expandCalls).toHaveLength(0);
  });

  it('rejects when the caller is marked as a sub-agent but stored lineage does not match the declared parent conversation', async () => {
    const summary = createTestSummary({
      idValue: 'sum_expand_uc',
      conversationId,
      kind: 'leaf',
      content: 'expandable summary',
      tokenCount: 20,
    });
    const authorization = new FakeAuthorizationPort(true);
    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const conversations = new FakeConversationPort([
      createTestConversation('conv_expand_parent_uc'),
      createTestConversation('conv_expand_uc', createConversationId('conv_unexpected_parent_uc')),
    ]);
    const useCase = new ExpandUseCase({ authorization, conversations, summaryDag });

    const execution = useCase.execute({
      summaryId,
      callerContext: createCaller(true),
    });

    await expect(execution).rejects.toBeInstanceOf(UnauthorizedExpandError);
    await expect(execution).rejects.toMatchObject({
      code: 'UNAUTHORIZED_EXPAND',
      conversationId,
      summaryId,
    });
    expect(summaryDag.getNodeCalls).toHaveLength(0);
  });
});
