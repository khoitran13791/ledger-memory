import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConversationNotFoundError, TokenizerConfigurationError } from '@ledgermind/application';
import { InMemoryConversationStore, SimpleTokenizerAdapter, TiktokenTokenizerAdapter } from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversation,
  createConversationConfig,
  createConversationId,
  createMimeType,
  createTokenCount,
} from '@ledgermind/domain';

import type * as SdkEntrypoint from './index';

let createMemoryEngine!: typeof SdkEntrypoint.createMemoryEngine;
let createInMemoryMemoryEngine!: typeof SdkEntrypoint.createInMemoryMemoryEngine;
let createPostgresMemoryEngine!: typeof SdkEntrypoint.createPostgresMemoryEngine;

const baseConfig = {
  storage: { type: 'in-memory' as const },
};

const conversationId = createConversationId('conv_000001');

beforeAll(async () => {
  const sdkModulePath = new URL('./index.ts', import.meta.url).href;
  const sdkModule = (await import(sdkModulePath)) as typeof SdkEntrypoint;

  createMemoryEngine = sdkModule.createMemoryEngine;
  createInMemoryMemoryEngine = sdkModule.createInMemoryMemoryEngine;
  createPostgresMemoryEngine = sdkModule.createPostgresMemoryEngine;
});

const createExistingConversation = (
  id: ReturnType<typeof createConversationId> = conversationId,
) => {
  const config = createConversationConfig({
    modelName: 'test-model',
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 0.9),
  });

  return createConversation({
    id,
    config,
  });
};

const expectedEngineMethods = [
  'append',
  'materializeContext',
  'runCompaction',
  'checkIntegrity',
  'grep',
  'describe',
  'expand',
  'storeArtifact',
  'exploreArtifact',
] as const;

const expectStableEngineContract = (engine: Record<string, unknown>) => {
  expect(Object.keys(engine).sort()).toEqual([...expectedEngineMethods].sort());

  for (const method of expectedEngineMethods) {
    expect(engine[method]).toBeTypeOf('function');
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMemoryEngine tokenizer selection', () => {
  it('uses deterministic tokenizer by default (backward-compatible)', () => {
    expect(() => createMemoryEngine(baseConfig)).not.toThrow();
  });

  it('creates engine with explicit deterministic tokenizer', () => {
    expect(() =>
      createMemoryEngine({
        ...baseConfig,
        tokenizer: { type: 'deterministic' },
      }),
    ).not.toThrow();
  });

  it('wires deterministic tokenizer into StoreArtifact tokenizer usage', async () => {
    const countTokensSpy = vi.spyOn(SimpleTokenizerAdapter.prototype, 'countTokens');
    const estimateFromBytesSpy = vi.spyOn(SimpleTokenizerAdapter.prototype, 'estimateFromBytes');

    const engine = createMemoryEngine({
      ...baseConfig,
      tokenizer: { type: 'deterministic' },
    });

    await expect(
      engine.storeArtifact({
        conversationId,
        source: { kind: 'text', content: 'abcd' },
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(countTokensSpy).toHaveBeenCalledWith('abcd');
    expect(estimateFromBytesSpy).not.toHaveBeenCalled();
  });

  it('creates engine with model-aligned tokenizer default family', () => {
    expect(() =>
      createMemoryEngine({
        ...baseConfig,
        tokenizer: { type: 'model-aligned' },
      }),
    ).not.toThrow();
  });

  it('wires model-aligned tokenizer into StoreArtifact tokenizer usage', async () => {
    const countTokensSpy = vi.spyOn(TiktokenTokenizerAdapter.prototype, 'countTokens');
    const estimateFromBytesSpy = vi.spyOn(TiktokenTokenizerAdapter.prototype, 'estimateFromBytes');

    const engine = createMemoryEngine({
      ...baseConfig,
      tokenizer: { type: 'model-aligned' },
    });

    await expect(
      engine.storeArtifact({
        conversationId,
        source: { kind: 'text', content: 'hello' },
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(countTokensSpy).toHaveBeenCalledWith('hello');
    expect(estimateFromBytesSpy).not.toHaveBeenCalled();
  });

  it.each([null, 'deterministic', 42])(
    'rejects non-object tokenizer config at initialization (%j)',
    (tokenizerConfig) => {
      const invalidConfig = {
        ...baseConfig,
        tokenizer: tokenizerConfig as unknown as { readonly type: 'deterministic' },
      };

      expect(() => createMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
      expect(() => createMemoryEngine(invalidConfig)).toThrow(
        'Tokenizer config must be an object. Supported values: "deterministic", "model-aligned".',
      );
    },
  );

  it.each([
    [123, 'number'],
    [true, 'boolean'],
    [{ unsupported: true }, 'object'],
  ])(
    'rejects model-aligned tokenizer config when modelFamily is not a string (%j)',
    (modelFamily, receivedType) => {
      const invalidConfig = {
        ...baseConfig,
        tokenizer: {
          type: 'model-aligned' as const,
          modelFamily: modelFamily as unknown as 'gpt-4o-mini',
        },
      };

      expect(() => createMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
      expect(() => createMemoryEngine(invalidConfig)).toThrow(
        `modelFamily must be a string when provided. Received ${receivedType}.`,
      );
    },
  );

  it('rejects unsupported model family at initialization', () => {
    const invalidConfig = {
      ...baseConfig,
      tokenizer: {
        type: 'model-aligned' as const,
        modelFamily: 'gpt-4o' as 'gpt-4o-mini',
      },
    };

    expect(() => createMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
    expect(() => createMemoryEngine(invalidConfig)).toThrow(
      'Unsupported modelFamily "gpt-4o". Supported values: "gpt-4o-mini".',
    );
  });

  it('rejects tokenizer config objects without a type', () => {
    const invalidConfig = {
      ...baseConfig,
      tokenizer: {} as unknown as { readonly type: 'deterministic' },
    };

    expect(() => createMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
    expect(() => createMemoryEngine(invalidConfig)).toThrow(
      'Missing tokenizer type. Supported values: "deterministic", "model-aligned".',
    );
  });

  it('rejects unsupported tokenizer types at initialization', () => {
    const invalidConfig = {
      ...baseConfig,
      tokenizer: { type: 'custom' } as unknown as { readonly type: 'deterministic' },
    };

    expect(() => createMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
    expect(() => createMemoryEngine(invalidConfig)).toThrow(
      'Unsupported tokenizer type "custom". Supported values: "deterministic", "model-aligned".',
    );
  });
});

describe('createMemoryEngine initialization validation', () => {
  it.each([undefined, null, 'invalid', 123])(
    'rejects non-object top-level config (%j)',
    (config) => {
      expect(() => createMemoryEngine(config as unknown as Parameters<typeof createMemoryEngine>[0])).toThrow(
        'MemoryEngine config must be an object.',
      );
    },
  );

  it('rejects when storage config is missing', () => {
    expect(() => createMemoryEngine({} as unknown as Parameters<typeof createMemoryEngine>[0])).toThrow(
      'MemoryEngine config must include a storage object.',
    );
  });

  it('rejects unsupported storage types with actionable error', () => {
    expect(() =>
      createMemoryEngine({
        storage: { type: 'sqlite' } as unknown as { type: 'in-memory' },
      }),
    ).toThrow('Unsupported storage type "sqlite". Supported values: "in-memory", "postgres".');
  });

  it('rejects invalid summarizer shape and unsupported summarizer type', () => {
    expect(() =>
      createMemoryEngine({
        ...baseConfig,
        summarizer: 'deterministic' as unknown as { readonly type: 'deterministic' },
      }),
    ).toThrow('Summarizer config must be an object when provided. Supported values: "deterministic".');

    expect(() =>
      createMemoryEngine({
        ...baseConfig,
        summarizer: {} as unknown as { readonly type: 'deterministic' },
      }),
    ).toThrow('Missing summarizer type. Supported values: "deterministic".');

    expect(() =>
      createMemoryEngine({
        ...baseConfig,
        summarizer: { type: 'llm' } as unknown as { readonly type: 'deterministic' },
      }),
    ).toThrow('Unsupported summarizer type "llm". Supported values: "deterministic".');
  });

  it.each([null, [], 'bad'])('rejects invalid compaction container (%j)', (compaction) => {
    expect(() =>
      createMemoryEngine({
        ...baseConfig,
        compaction: compaction as unknown as NonNullable<
          Parameters<typeof createMemoryEngine>[0]['compaction']
        >,
      }),
    ).toThrow('Compaction config must be an object when provided.');
  });
});

describe('SDK presets', () => {
  it('exports generic and named preset constructors from SDK module surface', () => {
    expect(createMemoryEngine).toBeTypeOf('function');
    expect(createInMemoryMemoryEngine).toBeTypeOf('function');
    expect(createPostgresMemoryEngine).toBeTypeOf('function');
  });

  it('returns same runtime contract for generic and in-memory preset engines', () => {
    const genericEngine = createMemoryEngine(baseConfig);
    const inMemoryPresetEngine = createInMemoryMemoryEngine();

    expectStableEngineContract(genericEngine as unknown as Record<string, unknown>);
    expectStableEngineContract(inMemoryPresetEngine as unknown as Record<string, unknown>);
  });

  it('in-memory preset supports usable artifact operations', async () => {
    const conversation = createExistingConversation();
    vi.spyOn(InMemoryConversationStore.prototype, 'get').mockResolvedValue(conversation);

    const engine = createInMemoryMemoryEngine();

    const stored = await engine.storeArtifact({
      conversationId,
      source: { kind: 'text', content: 'preset smoke content' },
      mimeType: createMimeType('text/plain'),
    });

    const explored = await engine.exploreArtifact({
      artifactId: stored.artifactId,
    });

    expect(stored.artifactId).toMatch(/^file_/);
    expect(explored.explorerUsed).toBeTypeOf('string');
    expect(explored.summary.length).toBeGreaterThan(0);
  });

  it('preserves generic tokenizer validation behavior when initialized via in-memory preset', () => {
    const invalidConfig = {
      tokenizer: { type: 'custom' } as unknown as { readonly type: 'deterministic' },
    };

    expect(() => createInMemoryMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
    expect(() => createInMemoryMemoryEngine(invalidConfig)).toThrow(
      'Unsupported tokenizer type "custom". Supported values: "deterministic", "model-aligned".',
    );
  });

  it('preserves generic tokenizer validation behavior when initialized via postgres preset', () => {
    const invalidConfig = {
      connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
      tokenizer: { type: 'custom' } as unknown as { readonly type: 'deterministic' },
    };

    expect(() => createPostgresMemoryEngine(invalidConfig)).toThrow(TokenizerConfigurationError);
    expect(() => createPostgresMemoryEngine(invalidConfig)).toThrow(
      'Unsupported tokenizer type "custom". Supported values: "deterministic", "model-aligned".',
    );
  });

  it.each(['', ' ', '\t', '\n', '  \n\t  '])(
    'surfaces actionable initialization error for incomplete postgres preset input (%j)',
    (connectionString) => {
      expect(() =>
        createPostgresMemoryEngine({
          connectionString,
        }),
      ).toThrow('Postgres connectionString is required and cannot be empty.');
    },
  );

  it.each(['', ' ', '\t', '\n', '  \n\t  '])(
    'surfaces actionable initialization error for incomplete postgres generic input (%j)',
    (connectionString) => {
      expect(() =>
        createMemoryEngine({
          storage: {
            type: 'postgres',
            connectionString,
          },
        }),
      ).toThrow('Postgres connectionString is required and cannot be empty.');
    },
  );

  it('returns same runtime contract for generic and postgres preset engines', () => {
    const connectionString = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

    const genericEngine = createMemoryEngine({
      storage: {
        type: 'postgres',
        connectionString,
      },
    });

    const postgresPresetEngine = createPostgresMemoryEngine({
      connectionString,
    });

    expectStableEngineContract(genericEngine as unknown as Record<string, unknown>);
    expectStableEngineContract(postgresPresetEngine as unknown as Record<string, unknown>);
  });
});

describe('createMemoryEngine artifact and explorer integration', () => {
  it('wires fileReader for in-memory path artifacts and enables path explore round-trip', async () => {
    const conversation = createExistingConversation();
    vi.spyOn(InMemoryConversationStore.prototype, 'get').mockResolvedValue(conversation);

    const tempDir = await mkdtemp(join(tmpdir(), 'ledgermind-sdk-test-'));
    const artifactPath = join(tempDir, 'notes.txt');

    try {
      await writeFile(artifactPath, 'line one\nline two\nline three', 'utf8');

      const engine = createMemoryEngine(baseConfig);

      const stored = await engine.storeArtifact({
        conversationId,
        source: { kind: 'path', path: artifactPath },
      });

      const explored = await engine.exploreArtifact({
        artifactId: stored.artifactId,
      });

      expect(explored.explorerUsed).toBe('fallback-explorer');
      expect(explored.summary).toContain(`Fallback exploration for ${artifactPath}`);
      expect(explored.summary).toContain('Text lines: 3');
      expect(explored.summary).toContain('line one');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('selects the same explorer deterministically for repeated identical artifacts', async () => {
    const conversation = createExistingConversation();
    vi.spyOn(InMemoryConversationStore.prototype, 'get').mockResolvedValue(conversation);

    const engine = createMemoryEngine(baseConfig);

    const first = await engine.storeArtifact({
      conversationId,
      source: { kind: 'text', content: 'export const value = 42;' },
      mimeType: createMimeType('text/plain'),
    });

    const second = await engine.storeArtifact({
      conversationId,
      source: { kind: 'text', content: 'export const value = 42;' },
      mimeType: createMimeType('text/plain'),
    });

    const firstExplore = await engine.exploreArtifact({ artifactId: first.artifactId });
    const secondExplore = await engine.exploreArtifact({ artifactId: second.artifactId });

    expect(first.artifactId).toBe(second.artifactId);
    expect(firstExplore.explorerUsed).toBe(secondExplore.explorerUsed);
    expect(firstExplore.summary).toBe(secondExplore.summary);
  });

  it('creates engine with postgres storage composition', () => {
    expect(() =>
      createMemoryEngine({
        storage: {
          type: 'postgres',
          connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
        },
      }),
    ).not.toThrow();
  });
});
