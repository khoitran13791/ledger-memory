import { describe, expect, it } from 'vitest';

import { SimpleTokenizerAdapter } from '@ledgermind/adapters';
import { createMimeType } from '@ledgermind/domain';

import { PythonExplorer } from '../python-explorer';

describe('PythonExplorer', () => {
  const tokenizer = new SimpleTokenizerAdapter();
  const explorer = new PythonExplorer(tokenizer);

  it('scores python extension with specialized baseline and rejects non-python paths', () => {
    expect(explorer.canHandle(createMimeType('text/x-python'), '/tmp/app.py')).toBe(10);
    expect(explorer.canHandle(createMimeType('text/plain'), '/tmp/app.txt')).toBe(0);
  });

  it('produces deterministic structural summary and required metadata keys', async () => {
    const content = [
      'import os',
      'from pathlib import Path',
      '',
      'class Service(BaseService):',
      '    """Service handles orchestration."""',
      '    def run(self) -> None:',
      '        return None',
      '',
      'async def worker(task: str) -> None:',
      '    """Worker entry point."""',
      '    return None',
      '',
      'if __name__ == "__main__":',
      '    pass',
    ].join('\n');

    const result = await explorer.explore({
      content,
      path: '/tmp/main.py',
      mimeType: createMimeType('text/x-python'),
    });

    expect(result.summary).toContain('## File: /tmp/main.py (Python)');
    expect(result.summary).toContain('### Imports: 2');
    expect(result.summary).toContain('### Classes: 1');
    expect(result.summary).toContain('### Functions: 1');
    expect(result.summary).toContain('### Entry Markers: 1');
    expect(result.summary).toContain('class Service(BaseService)');
    expect(result.summary).toContain('async def worker(task: str) -> None');
    expect(result.summary).toContain('if __name__ == "__main__":');

    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/main.py',
        mimeType: 'text/x-python',
      },
      selectedExplorer: 'python-explorer',
      inputClassification: 'python-source',
      score: 10,
      confidence: 1,
      truncated: false,
      samplingApplied: false,
      samplingStrategy: 'none',
      segmentCount: 0,
      segmentRanges: [],
      sampledChars: content.length,
      importCount: 2,
      classCount: 1,
      functionCount: 1,
      entryMarkerCount: 1,
    });

    expect(result.tokenCount.value).toBeGreaterThan(0);
  });

  it('returns identical output across repeated runs for same input', async () => {
    const input = {
      content: 'import sys\n\ndef main() -> int:\n    return 0\n',
      path: '/tmp/repeat.py',
      mimeType: createMimeType('text/x-python'),
    } as const;

    const first = await explorer.explore(input);
    const second = await explorer.explore(input);
    const third = await explorer.explore(input);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('enforces maxTokens and marks output as truncated when required', async () => {
    const content = `import os\n\n${'def item(x: int) -> int:\n    return x\n\n'.repeat(200)}`;

    const result = await explorer.explore({
      content,
      path: '/tmp/large.py',
      mimeType: createMimeType('text/x-python'),
      maxTokens: 20,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(20);
    expect(result.summary).toContain('[truncated for token budget]');
    expect(result.metadata).toMatchObject({
      inputClassification: 'python-source',
      truncated: true,
      maxTokensRequested: 20,
    });
  });

  it('applies stratified begin/middle/end sampling for large Python inputs', async () => {
    const content = `${'import os\n'.repeat(700)}${'def worker() -> None:\n    return None\n\n'.repeat(700)}`;

    const result = await explorer.explore({
      content,
      path: '/tmp/large-sampled.py',
      mimeType: createMimeType('text/x-python'),
    });

    expect(result.metadata).toMatchObject({
      inputClassification: 'python-source',
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
      content: 'import os\n\ndef main() -> None:\n    return None\n',
      path: '/tmp/small.py',
      mimeType: createMimeType('text/x-python'),
      maxTokens: 200,
    });

    expect(result.tokenCount.value).toBeLessThanOrEqual(200);
    expect(result.metadata).toMatchObject({
      inputClassification: 'python-source',
      truncated: false,
    });
  });

  it('returns structured unsupported-unreadable failure for undecodable bytes', async () => {
    const result = await explorer.explore({
      content: new Uint8Array([0xff, 0xfe, 0xfd]),
      path: '/tmp/binary.py',
      mimeType: createMimeType('text/x-python'),
    });

    expect(result.metadata).toMatchObject({
      artifactReference: {
        id: null,
        path: '/tmp/binary.py',
        mimeType: 'text/x-python',
      },
      selectedExplorer: 'python-explorer',
      inputClassification: 'unsupported-unreadable',
      score: 10,
      confidence: 1,
      truncated: false,
      failureClassification: 'unsupported-unreadable',
    });
    expect(result.summary).toContain('Python exploration unavailable for /tmp/binary.py');
    expect(result.tokenCount.value).toBeGreaterThanOrEqual(0);
  });
});
