import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  ArtifactId,
  Conversation,
  ConversationConfig,
  ConversationId,
  MimeType,
} from '@ledgermind/domain';
import {
  createArtifact,
  createArtifactId,
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createMimeType,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';

import {
  ArtifactContentUnavailableError,
  ArtifactExplorationFailedError,
  ArtifactNotFoundError,
  ExplorerResolutionError,
} from '../../errors/application-errors';
import type {
  ExplorerHints,
  ExplorerInput,
  ExplorerOutput,
  ExplorerPort,
} from '../../ports/driven/explorer/explorer.port';
import type { ExplorerRegistryPort } from '../../ports/driven/explorer/explorer-registry.port';
import type { ArtifactStorePort } from '../../ports/driven/persistence/artifact-store.port';
import { ExploreArtifactUseCase } from '../explore-artifact';

class TestArtifactStore implements ArtifactStorePort {
  readonly updateCalls: Array<{ id: ArtifactId; summary: string; explorerUsed: string }> = [];

  constructor(
    private readonly metadataById: ReadonlyMap<ArtifactId, Artifact>,
    private readonly contentById: ReadonlyMap<ArtifactId, string | Uint8Array>,
    private readonly throwOnUpdate = false,
  ) {}

  async store(): Promise<void> {
    return;
  }

  async getMetadata(id: ArtifactId): Promise<Artifact | null> {
    return this.metadataById.get(id) ?? null;
  }

  async getContent(id: ArtifactId): Promise<string | Uint8Array | null> {
    return this.contentById.get(id) ?? null;
  }

  async updateExploration(id: ArtifactId, summary: string, explorerUsed: string): Promise<void> {
    if (this.throwOnUpdate) {
      throw new Error('update exploration failed');
    }

    this.updateCalls.push({ id, summary, explorerUsed });
  }
}

class TestExplorer implements ExplorerPort {
  constructor(
    public readonly name: string,
    private readonly output: ExplorerOutput,
    private readonly throwOnExplore = false,
  ) {}

  readonly inputs: ExplorerInput[] = [];

  canHandle(): number {
    return 1;
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    if (this.throwOnExplore) {
      throw new Error('exploration exploded');
    }

    this.inputs.push(input);
    return this.output;
  }
}

class TestExplorerRegistry implements ExplorerRegistryPort {
  readonly resolveCalls: Array<{ mimeType: MimeType; path: string; hints?: ExplorerHints }> = [];

  constructor(
    private readonly explorer: ExplorerPort,
    private readonly throwOnResolve = false,
  ) {}

  register(): void {
    return;
  }

  resolve(mimeType: MimeType, path: string, hints?: ExplorerHints): ExplorerPort {
    this.resolveCalls.push({ mimeType, path, ...(hints === undefined ? {} : { hints }) });

    if (this.throwOnResolve) {
      throw new Error('no explorer');
    }

    return this.explorer;
  }
}

const conversationId: ConversationId = createConversationId('conv_explore_artifact_uc');
const artifactId: ArtifactId = createArtifactId('file_explore_artifact_uc');

const createConversationForTest = (): Conversation => {
  const config: ConversationConfig = createConversationConfig({
    modelName: 'claude-opus-4-6',
    contextWindow: createTokenCount(8000),
    thresholds: createCompactionThresholds(0.6, 1),
  });

  return createConversation({
    id: conversationId,
    config,
    createdAt: createTimestamp(new Date('2026-01-01T00:00:00.000Z')),
  });
};

const createArtifactForTest = (overrides?: Partial<Artifact>): Artifact => {
  return createArtifact({
    id: artifactId,
    conversationId,
    storageKind: 'inline_text',
    mimeType: createMimeType('application/json'),
    tokenCount: createTokenCount(25),
    ...(overrides?.originalPath === undefined ? {} : { originalPath: overrides.originalPath }),
    ...(overrides?.explorationSummary === undefined
      ? {}
      : { explorationSummary: overrides.explorationSummary }),
    ...(overrides?.explorerUsed === undefined ? {} : { explorerUsed: overrides.explorerUsed }),
  });
};

describe('ExploreArtifactUseCase', () => {
  it('resolves explorer, explores artifact content, and persists exploration metadata', async () => {
    void createConversationForTest();

    const explorer = new TestExplorer('json-explorer', {
      summary: 'JSON object with auth config keys',
      metadata: Object.freeze({ topLevelKeys: ['auth', 'tokenTtl'] }),
      tokenCount: createTokenCount(12),
    });

    const artifactStore = new TestArtifactStore(
      new Map([[artifactId, createArtifactForTest({ originalPath: '/tmp/auth.json' })]]),
      new Map([[artifactId, '{"auth":true,"tokenTtl":3600}']]),
    );
    const registry = new TestExplorerRegistry(explorer);

    const useCase = new ExploreArtifactUseCase({
      artifactStore,
      explorerRegistry: registry,
    });

    const output = await useCase.execute({
      artifactId,
      explorerHints: { preferredExplorer: 'json-explorer' },
    });

    expect(output).toEqual({
      explorerUsed: 'json-explorer',
      summary: 'JSON object with auth config keys',
      metadata: { topLevelKeys: ['auth', 'tokenTtl'] },
      tokenCount: createTokenCount(12),
    });

    expect(registry.resolveCalls).toEqual([
      {
        mimeType: createMimeType('application/json'),
        path: '/tmp/auth.json',
        hints: { preferredExplorer: 'json-explorer' },
      },
    ]);

    expect(explorer.inputs).toHaveLength(1);
    expect(explorer.inputs[0]?.content).toBe('{"auth":true,"tokenTtl":3600}');
    expect(artifactStore.updateCalls).toEqual([
      {
        id: artifactId,
        summary: 'JSON object with auth config keys',
        explorerUsed: 'json-explorer',
      },
    ]);
  });

  it('passes through unsupported-unreadable structured-failure metadata unchanged and persists exploration record', async () => {
    const structuredFailureMetadata = Object.freeze({
      artifactReference: {
        id: null,
        path: '/tmp/unreadable.bin',
        mimeType: 'application/octet-stream',
      },
      selectedExplorer: 'fallback-explorer',
      inputClassification: 'unsupported-unreadable',
      score: 1,
      confidence: 0.1,
      truncated: false,
      failureClassification: 'unsupported-unreadable',
      failureReason: 'Input bytes cannot be decoded as UTF-8 text.',
      actionableGuidance: ['Ensure artifact content is UTF-8 encoded text before exploration.'],
    });

    const explorer = new TestExplorer('fallback-explorer', {
      summary: 'Fallback exploration unavailable for unreadable input.',
      metadata: structuredFailureMetadata,
      tokenCount: createTokenCount(18),
    });

    const artifactStore = new TestArtifactStore(
      new Map([[artifactId, createArtifactForTest({ originalPath: '/tmp/unreadable.bin' })]]),
      new Map([[artifactId, new Uint8Array([0xff, 0xfe, 0xfd])]]),
    );

    const useCase = new ExploreArtifactUseCase({
      artifactStore,
      explorerRegistry: new TestExplorerRegistry(explorer),
    });

    const output = await useCase.execute({ artifactId });

    expect(output).toEqual({
      explorerUsed: 'fallback-explorer',
      summary: 'Fallback exploration unavailable for unreadable input.',
      metadata: structuredFailureMetadata,
      tokenCount: createTokenCount(18),
    });

    expect(artifactStore.updateCalls).toEqual([
      {
        id: artifactId,
        summary: 'Fallback exploration unavailable for unreadable input.',
        explorerUsed: 'fallback-explorer',
      },
    ]);
  });

  it('passes through malformed-structured metadata unchanged and persists exploration record', async () => {
    const structuredFailureMetadata = Object.freeze({
      artifactReference: {
        id: null,
        path: '/tmp/bad.json',
        mimeType: 'application/json',
      },
      selectedExplorer: 'json-explorer',
      inputClassification: 'malformed-structured',
      score: 10,
      confidence: 1,
      truncated: false,
      failureClassification: 'malformed-structured',
      failureReason: 'Invalid JSON syntax.',
      actionableGuidance: ['Fix JSON syntax and retry exploration.'],
    });

    const explorer = new TestExplorer('json-explorer', {
      summary: 'JSON exploration for /tmp/bad.json\nInput classification: malformed-structured',
      metadata: structuredFailureMetadata,
      tokenCount: createTokenCount(20),
    });

    const artifactStore = new TestArtifactStore(
      new Map([[artifactId, createArtifactForTest({ originalPath: '/tmp/bad.json' })]]),
      new Map([[artifactId, '{invalid json']]),
    );

    const useCase = new ExploreArtifactUseCase({
      artifactStore,
      explorerRegistry: new TestExplorerRegistry(explorer),
    });

    const output = await useCase.execute({ artifactId });

    expect(output).toEqual({
      explorerUsed: 'json-explorer',
      summary: 'JSON exploration for /tmp/bad.json\nInput classification: malformed-structured',
      metadata: structuredFailureMetadata,
      tokenCount: createTokenCount(20),
    });

    expect(artifactStore.updateCalls).toEqual([
      {
        id: artifactId,
        summary: 'JSON exploration for /tmp/bad.json\nInput classification: malformed-structured',
        explorerUsed: 'json-explorer',
      },
    ]);
  });

  it('throws typed artifact-not-found error when metadata is missing', async () => {
    const explorer = new TestExplorer('fallback', {
      summary: 'unused',
      metadata: {},
      tokenCount: createTokenCount(1),
    });

    const useCase = new ExploreArtifactUseCase({
      artifactStore: new TestArtifactStore(new Map(), new Map()),
      explorerRegistry: new TestExplorerRegistry(explorer),
    });

    const execution = useCase.execute({ artifactId });

    await expect(execution).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(execution).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_FOUND',
      artifactId,
    });
  });

  it('throws typed content-unavailable error when artifact content is missing', async () => {
    const explorer = new TestExplorer('fallback', {
      summary: 'unused',
      metadata: {},
      tokenCount: createTokenCount(1),
    });

    const useCase = new ExploreArtifactUseCase({
      artifactStore: new TestArtifactStore(
        new Map([[artifactId, createArtifactForTest()]]),
        new Map(),
      ),
      explorerRegistry: new TestExplorerRegistry(explorer),
    });

    const execution = useCase.execute({ artifactId });

    await expect(execution).rejects.toBeInstanceOf(ArtifactContentUnavailableError);
    await expect(execution).rejects.toMatchObject({
      code: 'ARTIFACT_CONTENT_UNAVAILABLE',
      artifactId,
    });
  });

  it('throws typed explorer-resolution error when registry cannot resolve', async () => {
    const explorer = new TestExplorer('fallback', {
      summary: 'unused',
      metadata: {},
      tokenCount: createTokenCount(1),
    });

    const useCase = new ExploreArtifactUseCase({
      artifactStore: new TestArtifactStore(
        new Map([[artifactId, createArtifactForTest()]]),
        new Map([[artifactId, '{}']]),
      ),
      explorerRegistry: new TestExplorerRegistry(explorer, true),
    });

    const execution = useCase.execute({ artifactId });

    await expect(execution).rejects.toBeInstanceOf(ExplorerResolutionError);
    await expect(execution).rejects.toMatchObject({
      code: 'EXPLORER_RESOLUTION_FAILED',
      artifactId,
      mimeType: createMimeType('application/json'),
    });
  });

  it('throws typed exploration-failed error when explorer crashes', async () => {
    const explorer = new TestExplorer(
      'failing-explorer',
      {
        summary: 'unused',
        metadata: {},
        tokenCount: createTokenCount(1),
      },
      true,
    );

    const useCase = new ExploreArtifactUseCase({
      artifactStore: new TestArtifactStore(
        new Map([[artifactId, createArtifactForTest()]]),
        new Map([[artifactId, '{}']]),
      ),
      explorerRegistry: new TestExplorerRegistry(explorer),
    });

    const execution = useCase.execute({ artifactId });

    await expect(execution).rejects.toBeInstanceOf(ArtifactExplorationFailedError);
    await expect(execution).rejects.toMatchObject({
      code: 'ARTIFACT_EXPLORATION_FAILED',
      artifactId,
    });
  });

  it('does not remap non-explorer faults as artifact-exploration-failed errors', async () => {
    const explorer = new TestExplorer('json-explorer', {
      summary: 'JSON object with auth config keys',
      metadata: Object.freeze({ topLevelKeys: ['auth', 'tokenTtl'] }),
      tokenCount: createTokenCount(12),
    });

    const useCase = new ExploreArtifactUseCase({
      artifactStore: new TestArtifactStore(
        new Map([[artifactId, createArtifactForTest({ originalPath: '/tmp/auth.json' })]]),
        new Map([[artifactId, '{"auth":true,"tokenTtl":3600}']]),
        true,
      ),
      explorerRegistry: new TestExplorerRegistry(explorer),
    });

    const execution = useCase.execute({ artifactId });

    await expect(execution).rejects.not.toBeInstanceOf(ArtifactExplorationFailedError);
    await expect(execution).rejects.toThrow('update exploration failed');
  });
});
