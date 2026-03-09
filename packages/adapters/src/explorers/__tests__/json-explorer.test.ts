import { describe, expect, it } from 'vitest';

import { SimpleTokenizerAdapter } from '@ledgermind/adapters';

import { JsonExplorer } from '../json-explorer';
import { createMimeType } from '@ledgermind/domain';

describe('JsonExplorer', () => {
  const tokenizer = new SimpleTokenizerAdapter();
  const explorer = new JsonExplorer(tokenizer);

  describe('canHandle', () => {
    it('returns highest score for .json files', () => {
      const score = explorer.canHandle(createMimeType('text/plain'), '/tmp/file.json');
      expect(score).toBe(10);
    });

    it('returns medium score for .jsonl files', () => {
      const score = explorer.canHandle(createMimeType('text/plain'), '/tmp/file.jsonl');
      expect(score).toBe(8);
    });

    it('returns positive score for application/json mime', () => {
      const score = explorer.canHandle(createMimeType('application/json'), '/tmp/file.txt');
      expect(score).toBe(7);
    });

    it('returns zero for unsupported inputs', () => {
      const score = explorer.canHandle(createMimeType('text/plain'), '/tmp/file.txt');
      expect(score).toBe(0);
    });
  });

  it('produces deterministic structural summary and required metadata for valid JSON', async () => {
    const input = {
      content: JSON.stringify({
        user: {
          id: 123,
          name: 'Ada',
        },
        tags: ['one', 'two'],
      }),
      path: '/tmp/example.json',
      mimeType: createMimeType('application/json'),
    };

    const first = await explorer.explore(input);
    const second = await explorer.explore(input);

    expect(first).toEqual(second);
    expect(first.summary).toContain('Root type: object');
    expect(first.summary).toContain('- user.id');
    expect(first.summary).toContain('- user.name');
    expect(first.summary).toContain('- tags[]');

    expect(first.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/example.json',
        mimeType: 'application/json',
      },
      selectedExplorer: 'json-explorer',
      inputClassification: 'json-structured',
      score: 10,
      confidence: 1,
      truncated: false,
      samplingApplied: false,
      samplingStrategy: 'none',
      segmentCount: 0,
      segmentRanges: [],
      sampledChars: input.content.length,
    });

    expect(first.tokenCount.value).toBeGreaterThan(0);
  });

  it('handles arrays and reports container shape metadata', async () => {
    const result = await explorer.explore({
      content: JSON.stringify([{ id: 1 }, { id: 2, tags: ['x'] }]),
      path: '/tmp/array.json',
      mimeType: createMimeType('application/json'),
    });

    expect(result.summary).toContain('Root type: array');
    expect(result.metadata).toMatchObject({
      inputClassification: 'json-structured',
      rootType: 'array',
      truncated: false,
    });
    expect(result.metadata).toHaveProperty('distinctArrayLengths');
  });

  it('returns structured malformed-structured failure metadata for invalid JSON', async () => {
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
      selectedExplorer: 'json-explorer',
      inputClassification: 'malformed-structured',
      score: 10,
      confidence: 1,
      truncated: false,
      failureClassification: 'malformed-structured',
      failureReason: 'Invalid JSON syntax.',
      actionableGuidance: ['Fix JSON syntax and retry exploration.'],
    });
  });

  it('supports jsonl content by parsing line-delimited records', async () => {
    const result = await explorer.explore({
      content: '{"name":"a"}\n{"name":"b","tags":[1,2]}\n',
      path: '/tmp/data.jsonl',
      mimeType: createMimeType('application/x-ndjson'),
    });

    expect(result.metadata).toMatchObject({
      inputClassification: 'json-structured',
      score: 8,
      confidence: 0.8,
      truncated: false,
    });
    expect(result.summary).toContain('Root type: array');
    expect(result.summary).toContain('- [].name');
  });

  it('enforces token budget deterministically and marks truncated metadata', async () => {
    const content = JSON.stringify({
      root: Array.from({ length: 80 }, (_, index) => ({
        index,
        values: ['alpha', 'beta', 'gamma', 'delta'],
      })),
    });

    const result = await explorer.explore({
      content,
      path: '/tmp/large.json',
      mimeType: createMimeType('application/json'),
      maxTokens: 20,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(20);
    expect(result.summary).toContain('[truncated for token budget]');
    expect(result.metadata).toMatchObject({
      truncated: true,
      selectedExplorer: 'json-explorer',
      inputClassification: 'json-structured',
      maxTokensRequested: 20,
    });
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('applies stratified begin/middle/end sampling for large JSON inputs', async () => {
    const content = JSON.stringify({
      root: Array.from({ length: 3000 }, (_, index) => ({
        index,
        payload: 'x'.repeat(30),
      })),
    });

    const result = await explorer.explore({
      content,
      path: '/tmp/large-sampled.json',
      mimeType: createMimeType('application/json'),
    });

    expect(result.metadata).toMatchObject({
      inputClassification: 'json-structured',
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

  it('returns empty output for zero token budget while preserving required keys', async () => {
    const result = await explorer.explore({
      content: '{"a":1}',
      path: '/tmp/zero.json',
      mimeType: createMimeType('application/json'),
      maxTokens: 0,
    });

    expect(result.summary).toBe('');
    expect(result.tokenCount.value).toBe(0);
    expect(result.metadata).toMatchObject({
      selectedExplorer: 'json-explorer',
      inputClassification: 'json-structured',
      truncated: true,
    });
  });
});
