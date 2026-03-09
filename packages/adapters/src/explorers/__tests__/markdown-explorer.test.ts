import { describe, expect, it } from 'vitest';

import { SimpleTokenizerAdapter } from '@ledgermind/adapters';
import { createMimeType } from '@ledgermind/domain';

import { MarkdownExplorer } from '../markdown-explorer';

describe('MarkdownExplorer', () => {
  const tokenizer = new SimpleTokenizerAdapter();
  const explorer = new MarkdownExplorer(tokenizer);

  it('scores markdown extension and MIME types with deterministic baseline', () => {
    expect(explorer.canHandle(createMimeType('text/plain'), '/tmp/readme.md')).toBe(10);
    expect(explorer.canHandle(createMimeType('text/plain'), '/tmp/readme.mdx')).toBe(9);
    expect(explorer.canHandle(createMimeType('text/markdown'), '/tmp/readme.txt')).toBe(7);
    expect(explorer.canHandle(createMimeType('application/octet-stream'), '/tmp/readme.txt')).toBe(0);
  });

  it('produces deterministic heading hierarchy, section outline, and document stats', async () => {
    const content = [
      '# Title',
      '',
      'Intro with [alpha](https://example.com)',
      '',
      '## Setup',
      'Setup text.',
      '',
      '```ts',
      '## Ignored In Fence',
      '```',
      '',
      '### Details',
      'More details with [beta](/docs).',
      '',
      '## API',
      'API content.',
    ].join('\n');

    const input = {
      content,
      path: '/tmp/guide.md',
      mimeType: createMimeType('text/markdown'),
    } as const;

    const first = await explorer.explore(input);
    const second = await explorer.explore(input);

    expect(first).toEqual(second);

    expect(first.summary).toContain('## File: /tmp/guide.md (Markdown)');
    expect(first.summary).toContain('### Heading Hierarchy (4)');
    expect(first.summary).toContain('- H1 Title (line 1)');
    expect(first.summary).toContain('H2 Setup (line 5)');
    expect(first.summary).toContain('H3 Details (line 12)');
    expect(first.summary).toContain('H2 API (line 15)');
    expect(first.summary).not.toContain('Ignored In Fence');

    expect(first.summary).toContain('### Section Outline (4)');
    expect(first.summary).toContain('1. H1 Title (lines 1-4, span 4)');
    expect(first.summary).toContain('2. H2 Setup (lines 5-11, span 7)');
    expect(first.summary).toContain('3. H3 Details (lines 12-14, span 3)');
    expect(first.summary).toContain('4. H2 API (lines 15-16, span 2)');

    expect(first.summary).toContain('### Document Stats');
    expect(first.summary).toContain('- lines: 16');
    expect(first.summary).toContain('- headings: 4');
    expect(first.summary).toContain('- sections: 4');
    expect(first.summary).toContain('- max heading level: 3');
    expect(first.summary).toContain('- fenced code blocks: 1');
    expect(first.summary).toContain('- links: 2');

    expect(first.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/guide.md',
        mimeType: 'text/markdown',
      },
      selectedExplorer: 'markdown-explorer',
      inputClassification: 'markdown-document',
      score: 10,
      confidence: 1,
      truncated: false,
      samplingApplied: false,
      samplingStrategy: 'none',
      segmentCount: 0,
      segmentRanges: [],
      sampledChars: content.length,
      lineCount: 16,
      headingCount: 4,
      sectionCount: 4,
      maxHeadingLevel: 3,
      codeFenceCount: 1,
      linkCount: 2,
    });

    expect(first.tokenCount.value).toBeGreaterThan(0);
  });

  it('enforces maxTokens and marks truncated metadata when reduction is required', async () => {
    const content = `${'# Heading\n\n'.repeat(40)}${'Long paragraph text. '.repeat(300)}`;

    const result = await explorer.explore({
      content,
      path: '/tmp/large.md',
      mimeType: createMimeType('text/markdown'),
      maxTokens: 20,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(20);
    expect(result.summary).toContain('[truncated for token budget]');
    expect(result.metadata).toMatchObject({
      selectedExplorer: 'markdown-explorer',
      inputClassification: 'markdown-document',
      truncated: true,
      maxTokensRequested: 20,
    });
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('applies stratified begin/middle/end sampling for large Markdown inputs', async () => {
    const content = `${'# Section\n\nBody text\n\n'.repeat(1000)}${'## Next\n\nMore text\n\n'.repeat(1000)}`;

    const result = await explorer.explore({
      content,
      path: '/tmp/large-sampled.md',
      mimeType: createMimeType('text/markdown'),
    });

    expect(result.metadata).toMatchObject({
      inputClassification: 'markdown-document',
      samplingApplied: true,
      samplingStrategy: 'stratified-begin-middle-end',
      segmentCount: 3,
    });

    const segmentRanges = result.metadata.segmentRanges as
      | readonly { startOffset: number; endOffset: number }[]
      | undefined;

    expect(segmentRanges).toHaveLength(3);
    expect(result.metadata.sampledChars).toBeGreaterThan(0);
  });

  it('keeps truncated false when summary fits token budget', async () => {
    const result = await explorer.explore({
      content: '# Small\n\nShort body.',
      path: '/tmp/small.md',
      mimeType: createMimeType('text/markdown'),
      maxTokens: 200,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(200);
    expect(result.metadata).toMatchObject({
      selectedExplorer: 'markdown-explorer',
      inputClassification: 'markdown-document',
      truncated: false,
    });
  });

  it('returns empty summary for zero token budget and sets truncated true', async () => {
    const result = await explorer.explore({
      content: '# Zero\n\nBudget',
      path: '/tmp/zero.md',
      mimeType: createMimeType('text/markdown'),
      maxTokens: 0,
    });

    expect(result.summary).toBe('');
    expect(result.tokenCount.value).toBe(0);
    expect(result.metadata).toMatchObject({
      selectedExplorer: 'markdown-explorer',
      inputClassification: 'markdown-document',
      truncated: true,
    });
  });

  it('returns structured unsupported-unreadable failure for undecodable bytes', async () => {
    const result = await explorer.explore({
      content: new Uint8Array([0xff, 0xfe, 0xfd]),
      path: '/tmp/binary.md',
      mimeType: createMimeType('text/markdown'),
    });

    expect(result.summary).toContain('Markdown exploration unavailable for /tmp/binary.md');
    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/binary.md',
        mimeType: 'text/markdown',
      },
      selectedExplorer: 'markdown-explorer',
      inputClassification: 'unsupported-unreadable',
      score: 10,
      confidence: 1,
      truncated: false,
      failureClassification: 'unsupported-unreadable',
      failureReason: 'Input bytes cannot be decoded as UTF-8 Markdown text.',
      actionableGuidance: ['Ensure artifact content is UTF-8 encoded text before exploration.'],
    });

    expect(result.tokenCount.value).toBeGreaterThanOrEqual(0);
  });
});
