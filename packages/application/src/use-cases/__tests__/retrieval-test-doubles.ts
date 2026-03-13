import type { AuthorizationPort, CallerContext } from '../../ports/driven/auth/authorization.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type {
  GrepMatch as LedgerReadGrepMatch,
  LedgerReadPort,
  SequenceRange,
} from '../../ports/driven/persistence/ledger-read.port';
import type {
  IntegrityReport,
  SummaryDagPort,
} from '../../ports/driven/persistence/summary-dag.port';

import {
  createArtifact,
  createArtifactId,
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createEventId,
  createLedgerEvent,
  createMimeType,
  createSequenceNumber,
  createSummaryNode,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  type Artifact,
  type ArtifactId,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type LedgerEvent,
  type SummaryKind,
  type SummaryNode,
  type SummaryNodeId,
} from '@ledgermind/domain';

const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = createConversationConfig({
  modelName: 'claude-opus-4-6',
  contextWindow: createTokenCount(8_000),
  thresholds: createCompactionThresholds(0.6, 1),
});

const EMPTY_INTEGRITY_REPORT: IntegrityReport = {
  passed: true,
  checks: [],
};

export const createTestConversation = (
  idValue: string,
  parentId: ConversationId | null = null,
): Conversation => {
  return createConversation({
    id: createConversationId(idValue),
    parentId,
    config: DEFAULT_CONVERSATION_CONFIG,
    createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
  });
};

export interface TestLedgerEventInput {
  readonly idValue: string;
  readonly conversationId: ConversationId;
  readonly sequence: number;
  readonly content: string;
}

export const createTestLedgerEvent = (input: TestLedgerEventInput): LedgerEvent => {
  return createLedgerEvent({
    id: createEventId(input.idValue),
    conversationId: input.conversationId,
    sequence: createSequenceNumber(input.sequence),
    role: 'user',
    content: input.content,
    tokenCount: createTokenCount(Math.max(1, input.content.length)),
    occurredAt: createTimestamp(
      new Date(`2026-01-01T00:00:${String(input.sequence).padStart(2, '0')}.000Z`),
    ),
    metadata: {},
  });
};

export interface TestSummaryInput {
  readonly idValue: string;
  readonly conversationId: ConversationId;
  readonly kind?: SummaryKind;
  readonly content?: string;
  readonly tokenCount?: number;
  readonly artifactIds?: readonly ArtifactId[];
}

export const createTestSummary = (input: TestSummaryInput): SummaryNode => {
  return createSummaryNode({
    id: createSummaryNodeId(input.idValue),
    conversationId: input.conversationId,
    kind: input.kind ?? 'leaf',
    content: input.content ?? 'summary content',
    tokenCount: createTokenCount(input.tokenCount ?? 32),
    ...(input.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
    createdAt: createTimestamp(new Date('2026-01-01T00:05:00.000Z')),
  });
};

export interface TestArtifactInput {
  readonly idValue: string;
  readonly conversationId: ConversationId;
  readonly tokenCount?: number;
  readonly storageKind?: Artifact['storageKind'];
  readonly originalPath?: string | null;
  readonly mimeType?: string;
  readonly explorationSummary?: string | null;
  readonly explorerUsed?: string | null;
}

export const createTestArtifact = (input: TestArtifactInput): Artifact => {
  return createArtifact({
    id: createArtifactId(input.idValue),
    conversationId: input.conversationId,
    storageKind: input.storageKind ?? 'inline_text',
    ...(input.originalPath === undefined ? {} : { originalPath: input.originalPath }),
    mimeType: createMimeType(input.mimeType ?? 'application/json'),
    tokenCount: createTokenCount(input.tokenCount ?? 24),
    ...(input.explorationSummary === undefined
      ? {}
      : { explorationSummary: input.explorationSummary }),
    ...(input.explorerUsed === undefined ? {} : { explorerUsed: input.explorerUsed }),
  });
};

export const createTestGrepMatch = (input: {
  readonly eventIdValue: string;
  readonly sequence: number;
  readonly excerpt: string;
  readonly coveringSummaryId?: SummaryNodeId;
}): LedgerReadGrepMatch => {
  return {
    eventId: createEventId(input.eventIdValue),
    sequence: createSequenceNumber(input.sequence),
    excerpt: input.excerpt,
    ...(input.coveringSummaryId === undefined
      ? {}
      : { coveringSummaryId: input.coveringSummaryId }),
  };
};

export class FakeLedgerReadPort implements LedgerReadPort {
  readonly regexCalls: Array<{
    readonly conversationId: ConversationId;
    readonly pattern: string;
    readonly scope?: SummaryNodeId;
  }> = [];

  constructor(private readonly matches: readonly LedgerReadGrepMatch[] = []) {}

  async getEvents(
    conversationId: ConversationId,
    range?: SequenceRange,
  ): Promise<readonly LedgerEvent[]> {
    void conversationId;
    void range;
    return [];
  }

  async searchEvents(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly LedgerEvent[]> {
    void conversationId;
    void query;
    void scope;
    return [];
  }

  async regexSearchEvents(
    conversationId: ConversationId,
    pattern: string,
    scope?: SummaryNodeId,
  ): Promise<readonly LedgerReadGrepMatch[]> {
    this.regexCalls.push({
      conversationId,
      pattern,
      ...(scope === undefined ? {} : { scope }),
    });

    return this.matches;
  }
}

export class FakeSummaryDagPort implements SummaryDagPort {
  readonly getNodeCalls: SummaryNodeId[] = [];
  readonly expandCalls: SummaryNodeId[] = [];

  private readonly summaries = new Map<SummaryNodeId, SummaryNode>();
  private readonly expandedMessages = new Map<SummaryNodeId, readonly LedgerEvent[]>();
  private readonly condensedEdges = new Map<SummaryNodeId, readonly SummaryNodeId[]>();

  constructor(input?: {
    readonly summaries?: readonly SummaryNode[];
    readonly expandedMessagesBySummaryId?: ReadonlyMap<SummaryNodeId, readonly LedgerEvent[]>;
    readonly parentEdgesBySummaryId?: ReadonlyMap<SummaryNodeId, readonly SummaryNodeId[]>;
  }) {
    for (const summary of input?.summaries ?? []) {
      this.summaries.set(summary.id, summary);
    }

    for (const [summaryId, messages] of input?.expandedMessagesBySummaryId ?? new Map()) {
      this.expandedMessages.set(summaryId, messages);
    }

    for (const [summaryId, parentIds] of input?.parentEdgesBySummaryId ?? new Map()) {
      this.condensedEdges.set(summaryId, parentIds);
    }
  }

  async createNode(node: SummaryNode): Promise<void> {
    this.summaries.set(node.id, node);
  }

  async getNode(id: SummaryNodeId): Promise<SummaryNode | null> {
    this.getNodeCalls.push(id);
    return this.summaries.get(id) ?? null;
  }

  async addLeafEdges(summaryId: SummaryNodeId, messageIds: readonly never[]): Promise<void> {
    void summaryId;
    void messageIds;
    return;
  }

  async addCondensedEdges(
    summaryId: SummaryNodeId,
    parentSummaryIds: readonly SummaryNodeId[],
  ): Promise<void> {
    void summaryId;
    void parentSummaryIds;
    return;
  }

  async getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]> {
    return this.condensedEdges.get(summaryId) ?? [];
  }

  async expandToMessages(summaryId: SummaryNodeId): Promise<readonly LedgerEvent[]> {
    this.expandCalls.push(summaryId);
    return this.expandedMessages.get(summaryId) ?? [];
  }

  async searchSummaries(
    conversationId: ConversationId,
    query: string,
    scope?: SummaryNodeId,
  ): Promise<readonly SummaryNode[]> {
    void conversationId;
    void query;
    void scope;
    return [];
  }

  async checkIntegrity(conversationId: ConversationId): Promise<IntegrityReport> {
    void conversationId;
    return EMPTY_INTEGRITY_REPORT;
  }
}

export class FakeArtifactStorePort implements ArtifactStorePort {
  private readonly artifacts = new Map<ArtifactId, Artifact>();

  constructor(artifacts: readonly Artifact[] = []) {
    for (const artifact of artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }
  }

  async store(artifact: Artifact, content?: string | Uint8Array): Promise<void> {
    void content;
    this.artifacts.set(artifact.id, artifact);
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    return this.artifacts.get(id) ?? null;
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    void id;
    return null;
  }

  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void> {
    const current = this.artifacts.get(id);
    if (!current) {
      throw new Error(`Unknown artifact: ${id}`);
    }

    this.artifacts.set(
      id,
      createArtifact({
        id: current.id,
        conversationId: current.conversationId,
        storageKind: current.storageKind,
        originalPath: current.originalPath,
        mimeType: current.mimeType,
        tokenCount: current.tokenCount,
        explorationSummary: summary,
        explorerUsed,
      }),
    );
  }
}

export class FakeAuthorizationPort implements AuthorizationPort {
  readonly callerContexts: CallerContext[] = [];

  constructor(private readonly allowExpand: boolean) {}

  canExpand(caller: CallerContext): boolean {
    this.callerContexts.push(caller);
    return this.allowExpand;
  }
}

export class FakeConversationPort implements ConversationPort {
  private readonly conversations = new Map<ConversationId, Conversation>();

  constructor(conversations: readonly Conversation[] = []) {
    for (const conversation of conversations) {
      this.conversations.set(conversation.id, conversation);
    }
  }

  async create(config: ConversationConfig, parentId?: ConversationId): Promise<Conversation> {
    const conversation = createConversation({
      id: createConversationId(`conv_created_${this.conversations.size + 1}`),
      parentId: parentId ?? null,
      config,
      createdAt: createTimestamp(new Date('2026-01-01T00:10:00.000Z')),
    });

    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async getAncestorChain(id: ConversationId): Promise<readonly ConversationId[]> {
    const chain: ConversationId[] = [];
    const visited = new Set<ConversationId>();

    let current = this.conversations.get(id);
    while (current && current.parentId !== null) {
      const parentId = current.parentId;
      if (visited.has(parentId)) {
        break;
      }

      visited.add(parentId);
      chain.push(parentId);
      current = this.conversations.get(parentId);
    }

    return chain.reverse();
  }
}
