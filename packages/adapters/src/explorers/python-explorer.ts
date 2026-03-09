import type {
  ExplorerHints,
  ExplorerInput,
  ExplorerOutput,
  ExplorerPort,
  TokenizerPort,
} from '@ledgermind/application';
import { type MimeType } from '@ledgermind/domain';

import { applyStratifiedSampling } from './shared/stratified-sampling';
import { constrainSummaryToTokenBudget } from './shared/token-budget';

interface PythonImport {
  readonly line: number;
  readonly statement: string;
}

interface PythonClass {
  readonly line: number;
  readonly signature: string;
  readonly docstring?: string;
}

interface PythonFunction {
  readonly line: number;
  readonly signature: string;
  readonly docstring?: string;
}

interface PythonEntryMarker {
  readonly line: number;
  readonly statement: string;
}

interface PythonStructure {
  readonly lineCount: number;
  readonly imports: readonly PythonImport[];
  readonly classes: readonly PythonClass[];
  readonly functions: readonly PythonFunction[];
  readonly entryMarkers: readonly PythonEntryMarker[];
}

const PYTHON_SPECIALIZED_SCORE = 10;

const clampConfidence = (score: number): number => {
  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.min(1, score / PYTHON_SPECIALIZED_SCORE));
};

const leadingWhitespaceLength = (value: string): number => {
  const match = value.match(/^\s*/);
  return match?.[0].length ?? 0;
};

const cleanDocstring = (value: string): string => value.replace(/\s+/g, ' ').trim();

const extractDocstringFirstLine = (
  lines: readonly string[],
  declarationLineIndex: number,
  parentIndent: number,
): string | undefined => {
  for (let index = declarationLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const indent = leadingWhitespaceLength(line);
    if (indent <= parentIndent) {
      return undefined;
    }

    if (trimmed.startsWith('#')) {
      continue;
    }

    if (!(trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
      return undefined;
    }

    const quote = trimmed.slice(0, 3);
    const remainder = trimmed.slice(3);
    const closingOnSameLine = remainder.indexOf(quote);
    if (closingOnSameLine >= 0) {
      const sameLine = cleanDocstring(remainder.slice(0, closingOnSameLine));
      return sameLine.length > 0 ? sameLine : undefined;
    }

    const firstLine = cleanDocstring(remainder);
    if (firstLine.length > 0) {
      return firstLine;
    }

    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const nestedLine = lines[scan] ?? '';
      const nestedTrimmed = nestedLine.trim();

      if (nestedTrimmed.length === 0) {
        continue;
      }

      const nestedIndent = leadingWhitespaceLength(nestedLine);
      if (nestedIndent <= parentIndent) {
        return undefined;
      }

      const closingAt = nestedTrimmed.indexOf(quote);
      if (closingAt >= 0) {
        const beforeClosing = cleanDocstring(nestedTrimmed.slice(0, closingAt));
        return beforeClosing.length > 0 ? beforeClosing : undefined;
      }

      return cleanDocstring(nestedTrimmed);
    }

    return undefined;
  }

  return undefined;
};

const parsePythonStructure = (content: string): PythonStructure => {
  const lines = content.split(/\r?\n/);
  const imports: PythonImport[] = [];
  const classes: PythonClass[] = [];
  const functions: PythonFunction[] = [];
  const entryMarkers: PythonEntryMarker[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indent = leadingWhitespaceLength(line);
    if (indent !== 0) {
      continue;
    }

    if (trimmed === 'if __name__ == "__main__":' || trimmed === "if __name__ == '__main__':") {
      entryMarkers.push({ line: index + 1, statement: trimmed });
      continue;
    }

    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch !== null) {
      imports.push({ line: index + 1, statement: `import ${importMatch[1]?.trim() ?? ''}`.trim() });
      continue;
    }

    const fromImportMatch = trimmed.match(/^from\s+([^\s]+)\s+import\s+(.+)$/);
    if (fromImportMatch !== null) {
      imports.push({
        line: index + 1,
        statement: `from ${fromImportMatch[1]?.trim() ?? ''} import ${fromImportMatch[2]?.trim() ?? ''}`.trim(),
      });
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:/);
    if (classMatch !== null) {
      const name = classMatch[1] ?? '';
      const bases = classMatch[2]?.trim();
      const signature = bases === undefined || bases.length === 0 ? `class ${name}` : `class ${name}(${bases})`;
      const classDocstring = extractDocstringFirstLine(lines, index, indent);

      if (classDocstring === undefined) {
        classes.push({
          line: index + 1,
          signature,
        });
      } else {
        classes.push({
          line: index + 1,
          signature,
          docstring: classDocstring,
        });
      }

      continue;
    }

    const functionMatch = trimmed.match(
      /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/,
    );
    if (functionMatch !== null) {
      const asyncKeyword = functionMatch[1] !== undefined ? 'async ' : '';
      const name = functionMatch[2] ?? '';
      const params = (functionMatch[3] ?? '').trim();
      const returns = functionMatch[4]?.trim();
      const signature = `${asyncKeyword}def ${name}(${params})${
        returns === undefined || returns.length === 0 ? '' : ` -> ${returns}`
      }`;
      const functionDocstring = extractDocstringFirstLine(lines, index, indent);

      if (functionDocstring === undefined) {
        functions.push({
          line: index + 1,
          signature,
        });
      } else {
        functions.push({
          line: index + 1,
          signature,
          docstring: functionDocstring,
        });
      }
    }
  }

  return {
    lineCount: lines.length,
    imports,
    classes,
    functions,
    entryMarkers,
  };
};

const createSummarySection = (
  title: string,
  items: readonly { readonly line: number; readonly signature?: string; readonly statement?: string; readonly docstring?: string }[],
  getLabel: (item: {
    readonly line: number;
    readonly signature?: string;
    readonly statement?: string;
    readonly docstring?: string;
  }) => string,
): string[] => {
  const lines = [`### ${title}: ${items.length}`];

  if (items.length === 0) {
    lines.push('- (none)');
    return lines;
  }

  for (const item of items) {
    lines.push(`- ${getLabel(item)} (line ${item.line})`);
    if (item.docstring !== undefined && item.docstring.length > 0) {
      lines.push(`  doc: ${item.docstring}`);
    }
  }

  return lines;
};

const formatPythonSummary = (structure: PythonStructure, path: string): string => {
  const importSection = createSummarySection('Imports', structure.imports, (item) => item.statement ?? '');
  const classSection = createSummarySection('Classes', structure.classes, (item) => item.signature ?? '');
  const functionSection = createSummarySection('Functions', structure.functions, (item) => item.signature ?? '');
  const entrySection = createSummarySection('Entry Markers', structure.entryMarkers, (item) => item.statement ?? '');

  return [
    `## File: ${path} (Python)`,
    ...importSection,
    ...classSection,
    ...functionSection,
    ...entrySection,
    '### Summary',
    `Python module with ${structure.imports.length} imports, ${structure.classes.length} classes, ${structure.functions.length} functions, and ${structure.entryMarkers.length} entry markers. ${structure.lineCount} lines.`,
  ].join('\n');
};

const decodeUtf8 = (content: Uint8Array): string => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(content);
};

export class PythonExplorer implements ExplorerPort {
  readonly name = 'python-explorer';

  constructor(private readonly tokenizer: TokenizerPort) {}

  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number {
    void mimeType;
    void hints;
    return path.toLowerCase().endsWith('.py') ? PYTHON_SPECIALIZED_SCORE : 0;
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    const score = this.canHandle(input.mimeType, input.path);
    const confidence = clampConfidence(score);

    const baseMetadata = {
      artifactReference: {
        id: null,
        path: input.path,
        mimeType: input.mimeType,
      },
      selectedExplorer: this.name,
      score,
      confidence,
    } as const;

    let content: string;
    try {
      content = typeof input.content === 'string' ? input.content : decodeUtf8(input.content);
    } catch {
      const failureSummary = [
        `Python exploration unavailable for ${input.path}`,
        'Reason: unable to decode input bytes as UTF-8 text.',
        'Guidance: provide readable UTF-8 Python source content.',
      ].join('\n');

      const constrainedFailure = constrainSummaryToTokenBudget(failureSummary, this.tokenizer, input.maxTokens);
      return {
        summary: constrainedFailure.summary,
        metadata: {
          ...baseMetadata,
          inputClassification: 'unsupported-unreadable',
          truncated: constrainedFailure.truncated,
          originalTokenCount: constrainedFailure.originalTokenCount,
          outputTokenCount: constrainedFailure.outputTokenCount,
          ...(constrainedFailure.maxTokensRequested === undefined
            ? {}
            : {
                maxTokensRequested: constrainedFailure.maxTokensRequested,
              }),
          samplingApplied: false,
          samplingStrategy: 'none',
          segmentCount: 0,
          segmentRanges: [],
          sampledChars: 0,
          failureClassification: 'unsupported-unreadable',
          failureReason: 'Input bytes cannot be decoded as UTF-8 Python source.',
          actionableGuidance: ['Ensure artifact content is UTF-8 encoded text before exploration.'],
        },
        tokenCount: constrainedFailure.tokenCount,
      };
    }

    const sampled = applyStratifiedSampling(content);
    const structure = parsePythonStructure(sampled.content);
    const summary = formatPythonSummary(structure, input.path);
    const constrainedSummary = constrainSummaryToTokenBudget(summary, this.tokenizer, input.maxTokens);

    return {
      summary: constrainedSummary.summary,
      metadata: {
        ...baseMetadata,
        inputClassification: 'python-source',
        truncated: constrainedSummary.truncated,
        originalTokenCount: constrainedSummary.originalTokenCount,
        outputTokenCount: constrainedSummary.outputTokenCount,
        ...(constrainedSummary.maxTokensRequested === undefined
          ? {}
          : {
              maxTokensRequested: constrainedSummary.maxTokensRequested,
            }),
        samplingApplied: sampled.metadata.samplingApplied,
        samplingStrategy: sampled.metadata.samplingStrategy,
        segmentCount: sampled.metadata.segmentCount,
        segmentRanges: sampled.metadata.segmentRanges,
        sampledChars: sampled.metadata.sampledChars,
        lineCount: structure.lineCount,
        importCount: structure.imports.length,
        classCount: structure.classes.length,
        functionCount: structure.functions.length,
        entryMarkerCount: structure.entryMarkers.length,
      },
      tokenCount: constrainedSummary.tokenCount,
    };
  }
}
