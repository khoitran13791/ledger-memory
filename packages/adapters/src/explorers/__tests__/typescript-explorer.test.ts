import { describe, expect, it } from 'vitest';

import { SimpleTokenizerAdapter } from '@ledgermind/adapters';
import { createMimeType } from '@ledgermind/domain';

import { TypeScriptExplorer } from '../typescript-explorer';

describe('TypeScriptExplorer', () => {
  const tokenizer = new SimpleTokenizerAdapter();
  const explorer = new TypeScriptExplorer(tokenizer);

  it('scores TypeScript extensions with specialized baseline and rejects non-TypeScript paths', () => {
    expect(explorer.canHandle(createMimeType('application/typescript'), '/tmp/app.ts')).toBe(10);
    expect(explorer.canHandle(createMimeType('application/typescript'), '/tmp/app.tsx')).toBe(10);
    expect(explorer.canHandle(createMimeType('text/plain'), '/tmp/app.txt')).toBe(0);
  });

  it('produces deterministic structural summary and required metadata keys', async () => {
    const content = [
      "import fs from 'node:fs';",
      "import type { Config } from './types';",
      "import './polyfills';",
      '',
      'export interface User {',
      '  id: string;',
      '}',
      '',
      'export class Service implements Runnable {',
      '  run(): void {}',
      '}',
      '',
      'export function greet(name: string): string {',
      "  return `hi ${name}`;",
      '}',
      '',
      'export type UserId = string;',
      '',
      "export { Service as DefaultService } from './service';",
      "export * from './more';",
    ].join('\n');

    const result = await explorer.explore({
      content,
      path: '/tmp/main.ts',
      mimeType: createMimeType('application/typescript'),
    });

    expect(result.summary).toContain('## File: /tmp/main.ts (TypeScript)');
    expect(result.summary).toContain('### Imports: 3');
    expect(result.summary).toContain('### Exports: 6');
    expect(result.summary).toContain('### Declarations: 4');
    expect(result.summary).toContain("import fs from 'node:fs' (line 1)");
    expect(result.summary).toContain('export interface User { (line 5)');
    expect(result.summary).toContain('export class Service implements Runnable { (line 9)');
    expect(result.summary).toContain('export function greet(name: string): string { (line 13)');
    expect(result.summary).toContain('export type UserId = string (line 17)');

    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/main.ts',
        mimeType: 'application/typescript',
      },
      selectedExplorer: 'typescript-explorer',
      inputClassification: 'typescript-source',
      score: 10,
      confidence: 1,
      truncated: false,
      samplingApplied: false,
      samplingStrategy: 'none',
      segmentCount: 0,
      segmentRanges: [],
      sampledChars: content.length,
      importCount: 3,
      exportCount: 6,
      declarationCount: 4,
    });

    expect(result.tokenCount.value).toBeGreaterThan(0);
  });

  it('returns identical output across repeated runs for same input', async () => {
    const input = {
      content: "import { A } from './a';\nexport type Id = string;\n",
      path: '/tmp/repeat.ts',
      mimeType: createMimeType('application/typescript'),
    } as const;

    const first = await explorer.explore(input);
    const second = await explorer.explore(input);
    const third = await explorer.explore(input);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('enforces maxTokens and marks output as truncated when required', async () => {
    const content = `${"import { A } from './a';\n".repeat(80)}${
      "export function item(x: number): number { return x; }\n".repeat(120)
    }`;

    const result = await explorer.explore({
      content,
      path: '/tmp/large.ts',
      mimeType: createMimeType('application/typescript'),
      maxTokens: 20,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(20);
    expect(result.summary).toContain('[truncated for token budget]');
    expect(result.metadata).toMatchObject({
      inputClassification: 'typescript-source',
      truncated: true,
      maxTokensRequested: 20,
    });
  });

  it('applies stratified begin/middle/end sampling for large TypeScript inputs', async () => {
    const content = `${'export const value = 1;\n'.repeat(700)}${'export function run(): void {}\n'.repeat(700)}`;

    const result = await explorer.explore({
      content,
      path: '/tmp/large-sampled.ts',
      mimeType: createMimeType('application/typescript'),
    });

    expect(result.metadata).toMatchObject({
      inputClassification: 'typescript-source',
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

  it('keeps truncated false when summary already fits token budget', async () => {
    const result = await explorer.explore({
      content: "import { A } from './a';\nexport type Name = string;\n",
      path: '/tmp/small.ts',
      mimeType: createMimeType('application/typescript'),
      maxTokens: 200,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(200);
    expect(result.metadata).toMatchObject({
      inputClassification: 'typescript-source',
      truncated: false,
    });
  });

  it('returns empty summary for zero token budget and sets truncated true', async () => {
    const result = await explorer.explore({
      content: 'export type A = string;',
      path: '/tmp/zero.ts',
      mimeType: createMimeType('application/typescript'),
      maxTokens: 0,
    });

    expect(result.summary).toBe('');
    expect(result.tokenCount.value).toBe(0);
    expect(result.metadata).toMatchObject({
      selectedExplorer: 'typescript-explorer',
      inputClassification: 'typescript-source',
      truncated: true,
    });
  });
});
