import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  Conversation,
  ConversationConfig,
  ConversationId,
  DomainEvent,
  HashPort,
  SummaryNode,
  TokenCount,
} from '@ledgermind/domain';
import {
  createCompactionThresholds,
  createContextVersion,
  createConversation,
  createConversationConfig,
  createConversationId,
  createIdService,
  createMimeType,
  createSequenceNumber,
  createTimestamp,
  createTokenCount,
  type ContextItem,
  type LedgerEvent,
  type SequenceNumber,
} from '@ledgermind/domain';

import {
  ConversationNotFoundError,
  InvalidTokenizerOutputError,
} from '../../errors/application-errors';
import type { EventPublisherPort } from '../../ports/driven/events/event-publisher.port';
import type { FileReaderPort } from '../../ports/driven/filesystem/file-reader.port';
import type { TokenizerPort } from '../../ports/driven/llm/tokenizer.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import type { ContextProjectionPort } from '../../ports/driven/persistence/context-projection.port';
import type { ConversationPort } from '../../ports/driven/persistence/conversation.port';
import type { LedgerAppendPort } from '../../ports/driven/persistence/ledger-append.port';
import type { UnitOfWork, UnitOfWorkPort } from '../../ports/driven/persistence/unit-of-work.port';
import type { IntegrityReport, SummaryDagPort } from '../../ports/driven/persistence/summary-dag.port';
import { StoreArtifactUseCase } from '../store-artifact';

class DeterministicHashPort implements HashPort {
  sha256(input: Uint8Array): string {
    let acc = 0;
    for (const byte of input) {
      acc = (acc * 31 + byte) >>> 0;
    }

    const part = acc.toString(16).padStart(8, '0');
    return part.repeat(8);
  }
}

class SimpleTokenizer implements TokenizerPort {
  countTokens(text: string): TokenCount {
    return createTokenCount(Math.max(1, Math.ceil(text.length / 4)));
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(Math.max(1, Math.ceil(byteLength / 4)));
  }
}

class InvalidOutputTokenizer implements TokenizerPort {
  countTokens(): TokenCount {
    return { value: Number.NaN } as TokenCount;
  }

  estimateFromBytes(): TokenCount {
    return { value: Number.NaN } as TokenCount;
  }
}

class TestFileReader implements FileReaderPort {
  private readonly files = new Map<string, Uint8Array>();

  constructor(files?: readonly [string, Uint8Array][]) {
    for (const [path, data] of files ?? []) {
      this.files.set(path, data);
    }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) {
      throw new Error(`File not found: ${path}`);
    }
    return data;
  }
}

class TestArtifactStore implements ArtifactStorePort {
  readonly stored = new Map<Artifact['id'], Artifact>();

  async store(artifact: Artifact): Promise<void> {
    this.stored.set(artifact.id, artifact);
  }

  async getMetadata(id: Artifact['id']): Promise<Artifact | null> {
    return this.stored.get(id) ?? null;
  }

  async getContent(): Promise<string | Uint8Array | null> {
    return null;
  }

  async updateExploration(): Promise<void> {
    return;
  }
}

class TestConversationStore implements ConversationPort {
  constructor(private readonly conversation: Conversation | null) {}

  async create(config: ConversationConfig): Promise<Conversation> {
    return createConversation({
      id: createConversationId('conv_created_store_artifact_test'),
      config,
      createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
    });
  }

  async get(id: ConversationId): Promise<Conversation | null> {
    return this.conversation?.id === id ? this.conversation : null;
  }

  async getAncestorChain(): Promise<readonly ConversationId[]> {
    return [];
  }
}

class NoopLedgerAppendPort implements LedgerAppendPort {
  async appendEvents(): Promise<void> {
    return;
  }

  async getNextSequence(): Promise<SequenceNumber> {
    return createSequenceNumber(1);
  }
}

class NoopContextProjectionPort implements ContextProjectionPort {
  async getCurrentContext(): Promise<{
    readonly items: readonly ContextItem[];
    readonly version: ReturnType<typeof createContextVersion>;
  }> {
    return { items: [], version: createContextVersion(0) };
  }

  async getContextTokenCount(): Promise<TokenCount> {
    return createTokenCount(0);
  }

  async appendContextItems(): Promise<ReturnType<typeof createContextVersion>> {
    return createContextVersion(0);
  }

  async replaceContextItems(): Promise<ReturnType<typeof createContextVersion>> {
    return createContextVersion(0);
  }
}

class NoopSummaryDagPort implements SummaryDagPort {
  async createNode(): Promise<void> {
    return;
  }

  async getNode(): Promise<SummaryNode | null> {
    return null;
  }

  async addLeafEdges(): Promise<void> {
    return;
  }

  async addCondensedEdges(): Promise<void> {
    return;
  }

  async getParentSummaryIds(): Promise<readonly SummaryNode['id'][]> {
    return [];
  }

  async expandToMessages(): Promise<readonly LedgerEvent[]> {
    return [];
  }

  async searchSummaries(): Promise<readonly SummaryNode[]> {
    return [];
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    return { passed: true, checks: [] };
  }
}

class TestUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly artifactStore: ArtifactStorePort,
    private readonly conversationStore: ConversationPort,
  ) {}

  async execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return work({
      ledger: new NoopLedgerAppendPort(),
      context: new NoopContextProjectionPort(),
      dag: new NoopSummaryDagPort(),
      artifacts: this.artifactStore,
      conversations: this.conversationStore,
    });
  }
}

const conversationId = createConversationId('conv_store_artifact_uc');

const createConversationForTest = (): Conversation => {
  return createConversation({
    id: conversationId,
    config: createConversationConfig({
      modelName: 'claude-opus-4-6',
      contextWindow: createTokenCount(8000),
      thresholds: createCompactionThresholds(0.6, 1),
    }),
    createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
  });
};

class SpyEventPublisher implements EventPublisherPort {
  readonly events: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.events.push(event);
  }
}

const createUseCase = (
  conversation: Conversation | null = createConversationForTest(),
  tokenizer: TokenizerPort = new SimpleTokenizer(),
) => {
  const hashPort = new DeterministicHashPort();
  const artifactStore = new TestArtifactStore();

  return {
    artifactStore,
    useCase: new StoreArtifactUseCase({
      unitOfWork: new TestUnitOfWork(artifactStore, new TestConversationStore(conversation)),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer,
    }),
  };
};

describe('StoreArtifactUseCase', () => {
  it('stores text artifacts with stable IDs and metadata', async () => {
    const { useCase, artifactStore } = createUseCase();

    const first = await useCase.execute({
      conversationId,
      source: { kind: 'text', content: 'hello artifact content' },
    });
    const second = await useCase.execute({
      conversationId,
      source: { kind: 'text', content: 'hello artifact content' },
    });

    expect(first.artifactId).toEqual(second.artifactId);
    expect(first.tokenCount.value).toBeGreaterThan(0);

    const stored = await artifactStore.getMetadata(first.artifactId);
    expect(stored?.storageKind).toBe('inline_text');
    expect(stored?.mimeType).toBe(createMimeType('text/plain'));
    expect(stored?.tokenCount).toEqual(first.tokenCount);
  });

  it('stores binary artifacts with explicit mime type', async () => {
    const { useCase, artifactStore } = createUseCase();

    const output = await useCase.execute({
      conversationId,
      source: { kind: 'binary', data: new Uint8Array([1, 2, 3, 4]) },
      mimeType: createMimeType('application/custom-binary'),
    });

    const stored = await artifactStore.getMetadata(output.artifactId);
    expect(stored?.storageKind).toBe('inline_binary');
    expect(stored?.mimeType).toBe(createMimeType('application/custom-binary'));
    expect(stored?.tokenCount.value).toBeGreaterThan(0);
  });

  it('stores path artifacts with stable IDs and path metadata', async () => {
    const { useCase, artifactStore } = createUseCase();

    const first = await useCase.execute({
      conversationId,
      source: { kind: 'path', path: '/tmp/project/data.json' },
    });
    const second = await useCase.execute({
      conversationId,
      source: { kind: 'path', path: '/tmp/project/data.json' },
    });

    expect(first.artifactId).toEqual(second.artifactId);

    const stored = await artifactStore.getMetadata(first.artifactId);
    expect(stored?.storageKind).toBe('path');
    expect(stored?.originalPath).toBe('/tmp/project/data.json');
    expect(stored?.mimeType).toBe(createMimeType('application/octet-stream'));
  });

  it('throws typed conversation-not-found error', async () => {
    const { useCase } = createUseCase(null);

    const execution = useCase.execute({
      conversationId,
      source: { kind: 'text', content: 'orphan artifact' },
    });

    await expect(execution).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(execution).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      conversationId,
    });
  });

  it('throws typed tokenizer invalid-output error and aborts store for text source', async () => {
    const { useCase, artifactStore } = createUseCase(createConversationForTest(), new InvalidOutputTokenizer());

    const execution = useCase.execute({
      conversationId,
      source: { kind: 'text', content: 'invalid tokenizer output should stop' },
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidTokenizerOutputError);
    await expect(execution).rejects.toMatchObject({
      code: 'TOKENIZER_OUTPUT_INVALID',
      operation: 'countTokens',
    });

    expect(artifactStore.stored.size).toBe(0);
  });

  it('throws typed tokenizer invalid-output error and aborts store for binary source', async () => {
    const { useCase, artifactStore } = createUseCase(createConversationForTest(), new InvalidOutputTokenizer());

    const execution = useCase.execute({
      conversationId,
      source: { kind: 'binary', data: new Uint8Array([1, 2, 3, 4]) },
    });

    await expect(execution).rejects.toBeInstanceOf(InvalidTokenizerOutputError);
    await expect(execution).rejects.toMatchObject({
      code: 'TOKENIZER_OUTPUT_INVALID',
      operation: 'estimateFromBytes',
    });

    expect(artifactStore.stored.size).toBe(0);
  });

  it('stores path artifacts with content-addressed IDs when fileReader is available', async () => {
    const hashPort = new DeterministicHashPort();
    const artifactStore = new TestArtifactStore();
    const conversation = createConversationForTest();
    const fileContent = new TextEncoder().encode('file content for hashing');
    const fileReader = new TestFileReader([['/tmp/project/data.json', fileContent]]);

    const useCase = new StoreArtifactUseCase({
      unitOfWork: new TestUnitOfWork(artifactStore, new TestConversationStore(conversation)),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer: new SimpleTokenizer(),
      fileReader,
    });

    const result = await useCase.execute({
      conversationId,
      source: { kind: 'path', path: '/tmp/project/data.json' },
    });

    // Same content at different path should produce same ID
    const fileReader2 = new TestFileReader([['/other/path.json', fileContent]]);
    const useCase2 = new StoreArtifactUseCase({
      unitOfWork: new TestUnitOfWork(artifactStore, new TestConversationStore(conversation)),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer: new SimpleTokenizer(),
      fileReader: fileReader2,
    });

    const result2 = await useCase2.execute({
      conversationId,
      source: { kind: 'path', path: '/other/path.json' },
    });

    expect(result.artifactId).toEqual(result2.artifactId);
  });

  it('emits ArtifactStored domain event when eventPublisher is provided', async () => {
    const eventPublisher = new SpyEventPublisher();
    const hashPort = new DeterministicHashPort();
    const artifactStore = new TestArtifactStore();

    const useCase = new StoreArtifactUseCase({
      unitOfWork: new TestUnitOfWork(artifactStore, new TestConversationStore(createConversationForTest())),
      idService: createIdService(hashPort),
      hashPort,
      tokenizer: new SimpleTokenizer(),
      eventPublisher,
    });

    const output = await useCase.execute({
      conversationId,
      source: { kind: 'text', content: 'hello artifact event' },
    });

    expect(eventPublisher.events).toHaveLength(1);
    expect(eventPublisher.events[0]).toMatchObject({
      type: 'ArtifactStored',
      conversationId,
      artifactId: output.artifactId,
      storageKind: 'inline_text',
      tokenCount: output.tokenCount,
    });
  });
});
