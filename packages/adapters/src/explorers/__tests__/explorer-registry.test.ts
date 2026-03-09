import { describe, expect, it } from 'vitest';

import {
  ExplorerRegistry,
  FallbackExplorer,
  SimpleTokenizerAdapter,
  createDefaultExplorerRegistry,
} from '@ledgermind/adapters';
import type { ExplorerInput, ExplorerOutput, ExplorerPort } from '@ledgermind/application';
import { createMimeType, createTokenCount, InvariantViolationError, type MimeType } from '@ledgermind/domain';

import { compareResolverCandidates, type ResolverCandidateRanking } from '../explorer-registry';

const UNKNOWN_MIME_TYPE = 'application/x-ledgermind-unknown';

interface SignalProfile {
  readonly extensionRaw: number;
  readonly mimeRaw: number;
  readonly sniffingRaw: number;
  readonly extension: string;
}

class WeightedStubExplorer implements ExplorerPort {
  readonly inputs: ExplorerInput[] = [];

  constructor(
    public readonly name: string,
    private readonly profile: SignalProfile,
  ) {}

  canHandle(mimeType: MimeType, path: string): number {
    const hasExtension = path.toLowerCase().endsWith(this.profile.extension.toLowerCase());
    const extensionScore = hasExtension ? this.profile.extensionRaw : 0;
    const mimeScore = mimeType.toLowerCase() === UNKNOWN_MIME_TYPE ? 0 : this.profile.mimeRaw;

    return extensionScore + mimeScore + this.profile.sniffingRaw;
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    this.inputs.push(input);
    return {
      summary: `explored by ${this.name}`,
      metadata: { explorer: this.name },
      tokenCount: createTokenCount(4),
    };
  }
}

const createRanking = (overrides: Partial<ResolverCandidateRanking>): ResolverCandidateRanking => {
  return {
    totalScore: 0,
    extensionContribution: 0,
    mimeContribution: 0,
    sniffingContribution: 0,
    index: 0,
    ...overrides,
  };
};

describe('ExplorerRegistry', () => {
  it('resolves explorer with highest weighted total score', () => {
    const registry = new ExplorerRegistry();
    const extensionOnly = new WeightedStubExplorer('extension-only', {
      extensionRaw: 10,
      mimeRaw: 0,
      sniffingRaw: 0,
      extension: '.json',
    });
    const mixedSignals = new WeightedStubExplorer('mixed-signals', {
      extensionRaw: 5,
      mimeRaw: 10,
      sniffingRaw: 10,
      extension: '.json',
    });

    registry.register(extensionOnly);
    registry.register(mixedSignals);

    const resolved = registry.resolve(createMimeType('application/json'), '/tmp/file.json');

    expect(resolved.name).toBe('mixed-signals');
  });

  it('breaks fully-equal weighted ties by registration order', () => {
    const registry = new ExplorerRegistry();
    const first = new WeightedStubExplorer('first', {
      extensionRaw: 4,
      mimeRaw: 2,
      sniffingRaw: 1,
      extension: '.txt',
    });
    const second = new WeightedStubExplorer('second', {
      extensionRaw: 4,
      mimeRaw: 2,
      sniffingRaw: 1,
      extension: '.txt',
    });

    registry.register(first);
    registry.register(second);

    const resolved = registry.resolve(createMimeType('text/plain'), '/tmp/file.txt');

    expect(resolved.name).toBe('first');
  });

  it('ignores candidates whose weighted total is zero', () => {
    const registry = new ExplorerRegistry();
    const zero = new WeightedStubExplorer('zero', {
      extensionRaw: 0,
      mimeRaw: 0,
      sniffingRaw: 0,
      extension: '.json',
    });
    const winner = new WeightedStubExplorer('winner', {
      extensionRaw: 1,
      mimeRaw: 0,
      sniffingRaw: 0,
      extension: '.json',
    });

    registry.register(zero);
    registry.register(winner);

    const resolved = registry.resolve(createMimeType('application/json'), '/tmp/file.json');

    expect(resolved.name).toBe('winner');
  });

  it('remains deterministic for repeated identical inputs', () => {
    const registry = new ExplorerRegistry();
    const first = new WeightedStubExplorer('first', {
      extensionRaw: 6,
      mimeRaw: 6,
      sniffingRaw: 2,
      extension: '.json',
    });
    const second = new WeightedStubExplorer('second', {
      extensionRaw: 4,
      mimeRaw: 10,
      sniffingRaw: 10,
      extension: '.json',
    });

    registry.register(first);
    registry.register(second);

    const selectedNames = new Set<string>();
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const resolved = registry.resolve(createMimeType('application/json'), '/tmp/repeat.json');
      selectedNames.add(resolved.name);
    }

    expect(selectedNames).toEqual(new Set(['second']));
  });

  it('throws when no explorer can handle input', () => {
    const registry = new ExplorerRegistry();
    registry.register(
      new WeightedStubExplorer('none', {
        extensionRaw: 0,
        mimeRaw: 0,
        sniffingRaw: 0,
        extension: '.xml',
      }),
    );

    expect(() => registry.resolve(createMimeType('application/xml'), '/tmp/file.xml')).toThrow(
      InvariantViolationError,
    );
  });
});

describe('compareResolverCandidates', () => {
  it('prioritizes higher total score first', () => {
    const higherTotal = createRanking({
      totalScore: 90,
      extensionContribution: 40,
      mimeContribution: 25,
      sniffingContribution: 15,
      index: 1,
    });
    const lowerTotal = createRanking({
      totalScore: 80,
      extensionContribution: 60,
      mimeContribution: 5,
      sniffingContribution: 15,
      index: 0,
    });

    expect(compareResolverCandidates(higherTotal, lowerTotal)).toBeLessThan(0);
    expect(compareResolverCandidates(lowerTotal, higherTotal)).toBeGreaterThan(0);
  });

  it('breaks total ties by extension contribution', () => {
    const higherExtension = createRanking({
      totalScore: 70,
      extensionContribution: 50,
      mimeContribution: 10,
      sniffingContribution: 10,
      index: 1,
    });
    const lowerExtension = createRanking({
      totalScore: 70,
      extensionContribution: 40,
      mimeContribution: 20,
      sniffingContribution: 10,
      index: 0,
    });

    expect(compareResolverCandidates(higherExtension, lowerExtension)).toBeLessThan(0);
  });

  it('breaks ties by MIME contribution after extension', () => {
    const higherMime = createRanking({
      totalScore: 70,
      extensionContribution: 45,
      mimeContribution: 20,
      sniffingContribution: 5,
      index: 1,
    });
    const lowerMime = createRanking({
      totalScore: 70,
      extensionContribution: 45,
      mimeContribution: 10,
      sniffingContribution: 15,
      index: 0,
    });

    expect(compareResolverCandidates(higherMime, lowerMime)).toBeLessThan(0);
  });

  it('breaks ties by sniffing contribution after MIME', () => {
    const higherSniffing = createRanking({
      totalScore: 70,
      extensionContribution: 40,
      mimeContribution: 20,
      sniffingContribution: 10,
      index: 1,
    });
    const lowerSniffing = createRanking({
      totalScore: 70,
      extensionContribution: 40,
      mimeContribution: 20,
      sniffingContribution: 5,
      index: 0,
    });

    expect(compareResolverCandidates(higherSniffing, lowerSniffing)).toBeLessThan(0);
  });

  it('falls back to registration order when all contributions tie', () => {
    const earlier = createRanking({
      totalScore: 70,
      extensionContribution: 40,
      mimeContribution: 20,
      sniffingContribution: 10,
      index: 0,
    });
    const later = createRanking({
      totalScore: 70,
      extensionContribution: 40,
      mimeContribution: 20,
      sniffingContribution: 10,
      index: 1,
    });

    expect(compareResolverCandidates(earlier, later)).toBeLessThan(0);
  });
});

describe('FallbackExplorer', () => {
  const tokenizer = new SimpleTokenizerAdapter();
  const explorer = new FallbackExplorer(tokenizer);

  it('handles any file type with low priority score', () => {
    expect(explorer.canHandle(createMimeType('application/unknown'), '/tmp/file.bin')).toBe(1);
  });

  it('summarizes text content deterministically with required metadata contract', async () => {
    const result = await explorer.explore({
      content: 'line 1\nline 2\nline 3',
      path: '/tmp/example.txt',
      mimeType: createMimeType('text/plain'),
    });

    expect(result.summary).toContain('Fallback exploration for /tmp/example.txt');
    expect(result.summary).toContain('Text lines: 3');
    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/example.txt',
        mimeType: 'text/plain',
      },
      selectedExplorer: 'fallback-explorer',
      inputClassification: 'unsupported-readable',
      score: 1,
      confidence: 0.1,
      truncated: false,
      mimeType: 'text/plain',
      path: '/tmp/example.txt',
      contentKind: 'text',
      characterCount: 20,
      previewLineCount: 5,
    });
    expect(result.tokenCount.value).toBeGreaterThan(0);
  });

  it('summarizes binary content deterministically with required metadata contract', async () => {
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const result = await explorer.explore({
      content: binary,
      path: '/tmp/example.bin',
      mimeType: createMimeType('application/octet-stream'),
    });

    expect(result.summary).toContain('Binary bytes: 4');
    expect(result.summary).toContain('de ad be ef');
    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/example.bin',
        mimeType: 'application/octet-stream',
      },
      selectedExplorer: 'fallback-explorer',
      inputClassification: 'unsupported-readable',
      score: 1,
      confidence: 0.1,
      truncated: false,
      mimeType: 'application/octet-stream',
      path: '/tmp/example.bin',
      contentKind: 'binary',
      byteLength: 4,
      previewLineCount: 5,
    });
    expect(result.tokenCount.value).toBeGreaterThan(0);
  });

  it('returns structured unsupported-unreadable failure metadata for undecodable bytes', async () => {
    const result = await explorer.explore({
      content: new Uint8Array([0xff, 0xfe, 0xfd]),
      path: '/tmp/unreadable.txt',
      mimeType: createMimeType('text/plain'),
    });

    expect(result.summary).toContain('Input classification: unsupported-unreadable');
    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/unreadable.txt',
        mimeType: 'text/plain',
      },
      selectedExplorer: 'fallback-explorer',
      inputClassification: 'unsupported-unreadable',
      score: 1,
      confidence: 0.1,
      truncated: false,
      contentKind: 'binary',
      byteLength: 3,
      failureClassification: 'unsupported-unreadable',
      failureReason: 'Input bytes cannot be decoded as UTF-8 text.',
    });
    expect(result.metadata).toHaveProperty('actionableGuidance');
    expect((result.metadata.actionableGuidance as readonly string[]).length).toBeGreaterThan(0);
  });

  it('returns structured malformed-structured failure metadata for malformed json-like content', async () => {
    const result = await explorer.explore({
      content: '{"invalid": true,,}',
      path: '/tmp/bad.json',
      mimeType: createMimeType('application/json'),
    });

    expect(result.summary).toContain('Input classification: malformed-structured');
    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/bad.json',
        mimeType: 'application/json',
      },
      selectedExplorer: 'fallback-explorer',
      inputClassification: 'malformed-structured',
      score: 1,
      confidence: 0.1,
      truncated: false,
      contentKind: 'text',
      characterCount: 19,
      failureClassification: 'malformed-structured',
      failureReason: 'Structured content is malformed and could not be parsed.',
    });
    expect(result.metadata).toHaveProperty('actionableGuidance');
    expect((result.metadata.actionableGuidance as readonly string[]).length).toBeGreaterThan(0);
  });

  it('respects maxTokens by truncating summary output and marking truncated metadata', async () => {
    const largeText = 'alpha '.repeat(300);

    const result = await explorer.explore({
      content: largeText,
      path: '/tmp/large.txt',
      mimeType: createMimeType('text/plain'),
      maxTokens: 20,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(20);
    expect(result.summary).toContain('[truncated for token budget]');
    expect(result.metadata).toMatchObject({
      inputClassification: 'unsupported-readable',
      truncated: true,
    });
  });

  it('returns empty summary when maxTokens is zero and marks output truncated', async () => {
    const result = await explorer.explore({
      content: 'alpha beta gamma',
      path: '/tmp/zero-budget.txt',
      mimeType: createMimeType('text/plain'),
      maxTokens: 0,
    });

    expect(result.summary).toBe('');
    expect(result.tokenCount.value).toBe(0);
    expect(result.metadata).toMatchObject({
      inputClassification: 'unsupported-readable',
      truncated: true,
    });
  });

  it('normalizes non-finite maxTokens values safely and marks output truncated', async () => {
    const result = await explorer.explore({
      content: 'alpha beta gamma',
      path: '/tmp/non-finite-budget.txt',
      mimeType: createMimeType('text/plain'),
      maxTokens: Number.NaN,
    });

    expect(result.summary).toBe('');
    expect(result.tokenCount.value).toBe(0);
    expect(result.metadata).toMatchObject({
      inputClassification: 'unsupported-readable',
      truncated: true,
    });
  });
});

describe('createDefaultExplorerRegistry', () => {
  it('resolves all five Phase 1 explorer categories by default and can execute each resolved explorer', async () => {
    const registry = createDefaultExplorerRegistry(new SimpleTokenizerAdapter());

    const cases = [
      {
        path: '/tmp/module.ts',
        mimeType: 'application/octet-stream',
        content: 'export const value = 42;\n',
        expectedExplorer: 'typescript-explorer',
      },
      {
        path: '/tmp/module.py',
        mimeType: 'text/plain',
        content: 'def main() -> None:\n    return None\n',
        expectedExplorer: 'python-explorer',
      },
      {
        path: '/tmp/config.json',
        mimeType: 'application/json',
        content: '{"feature":true,"retries":3}',
        expectedExplorer: 'json-explorer',
      },
      {
        path: '/tmp/readme.md',
        mimeType: 'text/markdown',
        content: '# Readme\n\n## Setup\n',
        expectedExplorer: 'markdown-explorer',
      },
      {
        path: '/tmp/anything.unknown',
        mimeType: 'application/unknown',
        content: 'hello',
        expectedExplorer: 'fallback-explorer',
      },
    ] as const;

    for (const entry of cases) {
      const resolved = registry.resolve(createMimeType(entry.mimeType), entry.path);
      expect(resolved.name).toBe(entry.expectedExplorer);

      const output = await resolved.explore({
        content: entry.content,
        path: entry.path,
        mimeType: createMimeType(entry.mimeType),
      });
      expect(output.summary.length).toBeGreaterThan(0);
      expect(output.metadata).toMatchObject({
        selectedExplorer: entry.expectedExplorer,
      });
    }
  });

  it('keeps resolution deterministic for repeated identical inputs', () => {
    const registry = createDefaultExplorerRegistry(new SimpleTokenizerAdapter());

    const selectedNames = new Set<string>();
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const resolved = registry.resolve(createMimeType('application/json'), '/tmp/repeat.json');
      selectedNames.add(resolved.name);
    }

    expect(selectedNames).toEqual(new Set(['json-explorer']));
  });

  it('keeps fallback as terminal handling path for unknown input', async () => {
    const registry = createDefaultExplorerRegistry(new SimpleTokenizerAdapter());

    const resolved = registry.resolve(createMimeType('application/unknown'), '/tmp/anything.unknown');
    const result = await resolved.explore({
      content: 'hello',
      path: '/tmp/anything.unknown',
      mimeType: createMimeType('application/unknown'),
    });

    expect(resolved.name).toBe('fallback-explorer');
    expect(result.summary).toContain('/tmp/anything.unknown');
  });
});
