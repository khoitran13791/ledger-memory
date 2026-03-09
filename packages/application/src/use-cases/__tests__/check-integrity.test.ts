import { describe, expect, it } from 'vitest';

import type {
  Conversation,
  ConversationConfig,
  ConversationId,
  SummaryNode,
  SummaryNodeId,
} from '@ledgermind/domain';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createTokenCount,
  type EventId,
  type LedgerEvent,
} from '@ledgermind/domain';

import {
  ConversationNotFoundError,
  IntegrityCheckExecutionError,
} from '../../errors/application-errors';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type {
  IntegrityReport,
  SummaryDagPort,
} from '../../ports/driven/persistence/summary-dag.port';
import { CheckIntegrityUseCase } from '../check-integrity';

class TestConversationStore implements ConversationPort {
  constructor(private readonly conversation: Conversation | null) {}

  async create(config: ConversationConfig): Promise<Conversation> {
    return createConversation({
      id: createConversationId('conv_created_check_integrity_test'),
      config,
    });
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    return this.conversation?.id === id ? this.conversation : null;
  }

  async getAncestorChain(): Promise<readonly ConversationId[]> {
    return [];
  }
}

class TestSummaryDag implements SummaryDagPort {
  readonly checkIntegrityCalls: ConversationId[] = [];

  constructor(
    private readonly report: IntegrityReport,
    private readonly throwOnCheck = false,
  ) {}

  async createNode(): Promise<void> {
    return;
  }

  async getNode(): Promise<SummaryNode | null> {
    return null;
  }

  async addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly EventId[]): Promise<void> {
    void summaryId;
    void messageIds;
    return;
  }

  async addCondensedEdges(): Promise<void> {
    return;
  }

  async getParentSummaryIds(): Promise<readonly SummaryNodeId[]> {
    return [];
  }

  async expandToMessages(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async searchSummaries(): Promise<readonly SummaryNode[]> {
    return [];
  }

  async checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport> {
    this.checkIntegrityCalls.push(conversationId);

    if (this.throwOnCheck) {
      throw new Error('integrity backend offline');
    }

    return this.report;
  }
}

const conversationId = createConversationId('conv_check_integrity_uc');

const createConversationForTest = (): Conversation => {
  const config: ConversationConfig = createConversationConfig({
    modelName: 'claude-opus-4-6',
    contextWindow: createTokenCount(8000),
    thresholds: createCompactionThresholds(0.6, 1),
  });

  return createConversation({
    id: conversationId,
    config,
  });
};

describe('CheckIntegrityUseCase', () => {
  it('returns per-check integrity statuses unchanged', async () => {
    const report: IntegrityReport = {
      passed: false,
      checks: [
        {
          name: 'acyclic_dag',
          passed: true,
        },
        {
          name: 'artifact_propagation',
          passed: false,
          details: 'Missing artifact union at condensed node',
          affectedIds: ['sum_x', 'sum_y'],
        },
      ],
    };

    const summaryDag = new TestSummaryDag(report);
    const useCase = new CheckIntegrityUseCase({
      conversations: new TestConversationStore(createConversationForTest()),
      summaryDag,
    });

    const output = await useCase.execute({ conversationId });

    expect(output.report).toEqual(report);
    expect(output.report.checks).toHaveLength(2);
    expect(summaryDag.checkIntegrityCalls).toEqual([conversationId]);
  });

  it('throws typed conversation-not-found error when conversation is missing', async () => {
    const summaryDag = new TestSummaryDag({ passed: true, checks: [] });
    const useCase = new CheckIntegrityUseCase({
      conversations: new TestConversationStore(null),
      summaryDag,
    });

    const execution = useCase.execute({ conversationId });

    await expect(execution).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(execution).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      conversationId,
    });

    expect(summaryDag.checkIntegrityCalls).toHaveLength(0);
  });

  it('throws typed execution error when integrity check subsystem fails', async () => {
    const summaryDag = new TestSummaryDag({ passed: true, checks: [] }, true);
    const useCase = new CheckIntegrityUseCase({
      conversations: new TestConversationStore(createConversationForTest()),
      summaryDag,
    });

    const execution = useCase.execute({ conversationId });

    await expect(execution).rejects.toBeInstanceOf(IntegrityCheckExecutionError);
    await expect(execution).rejects.toMatchObject({
      code: 'INTEGRITY_CHECK_EXECUTION_FAILED',
      conversationId,
    });
  });
});
