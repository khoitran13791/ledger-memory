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

type TypeScriptInputClassification = 'typescript-source';

type TypeScriptDeclarationKind = 'interface' | 'class' | 'function' | 'type';

interface ArtifactReference {
  readonly id: string | null;
  readonly path: string;
  readonly mimeType: string;
}

interface TypeScriptImport {
  readonly line: number;
  readonly statement: string;
}

interface TypeScriptExport {
  readonly line: number;
  readonly statement: string;
}

interface TypeScriptDeclaration {
  readonly line: number;
  readonly kind: TypeScriptDeclarationKind;
  readonly signature: string;
}

interface TypeScriptStructure {
  readonly lineCount: number;
  readonly imports: readonly TypeScriptImport[];
  readonly exports: readonly TypeScriptExport[];
  readonly declarations: readonly TypeScriptDeclaration[];
}

interface TypeScriptExplorerMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactReference: ArtifactReference;
  readonly selectedExplorer: string;
  readonly inputClassification: TypeScriptInputClassification;
  readonly score: number;
  readonly confidence: number;
  readonly truncated: boolean;
  readonly originalTokenCount: number;
  readonly outputTokenCount: number;
  readonly maxTokensRequested?: number;
  readonly samplingApplied: boolean;
  readonly samplingStrategy: 'stratified-begin-middle-end' | 'none';
  readonly segmentCount: number;
  readonly segmentRanges: readonly { startOffset: number; endOffset: number }[];
  readonly sampledChars: number;
  readonly lineCount: number;
  readonly importCount: number;
  readonly exportCount: number;
  readonly declarationCount: number;
}

const TYPESCRIPT_SPECIALIZED_SCORE = 10;

const leadingWhitespaceLength = (value: string): number => {
  const match = value.match(/^\s*/);
  return match?.[0].length ?? 0;
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const stripTrailingSemicolon = (value: string): string => value.replace(/;\s*$/, '').trim();

const detectScore = (path: string): number => {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith('.ts') || normalizedPath.endsWith('.tsx')) {
    return TYPESCRIPT_SPECIALIZED_SCORE;
  }

  return 0;
};

const computeConfidence = (score: number): number => {
  const normalized = Math.max(0, Math.min(score, TYPESCRIPT_SPECIALIZED_SCORE)) / TYPESCRIPT_SPECIALIZED_SCORE;
  return Number(normalized.toFixed(2));
};

const extractArtifactId = (path: string): string | null => {
  const prefix = 'artifact://';
  if (!path.startsWith(prefix)) {
    return null;
  }

  const extracted = path.slice(prefix.length);
  return extracted.length > 0 ? extracted : null;
};

const createArtifactReference = (path: string, mimeType: MimeType): ArtifactReference => {
  return {
    id: extractArtifactId(path),
    path,
    mimeType,
  };
};

const parseDeclaration = (line: string, lineNumber: number): TypeScriptDeclaration | undefined => {
  const withoutExport = line.replace(/^export\s+/, '');
  const normalized = withoutExport.replace(/^default\s+/, '').replace(/^declare\s+/, '').trim();

  const interfaceMatch = normalized.match(/^interface\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s+extends\s+[^{}]+)?/);
  if (interfaceMatch !== null) {
    return {
      line: lineNumber,
      kind: 'interface',
      signature: interfaceMatch[0].trim(),
    };
  }

  const classMatch = normalized.match(
    /^(?:abstract\s+)?class\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s+extends\s+[^{}]+)?(?:\s+implements\s+[^{}]+)?/,
  );
  if (classMatch !== null) {
    return {
      line: lineNumber,
      kind: 'class',
      signature: classMatch[0].trim(),
    };
  }

  const functionMatch = normalized.match(/^(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)\s*(?::\s*[^ {]+)?/);
  if (functionMatch !== null) {
    return {
      line: lineNumber,
      kind: 'function',
      signature: functionMatch[0].trim(),
    };
  }

  const typeMatch = normalized.match(/^type\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>]+>)?\s*=\s*.+$/);
  if (typeMatch !== null) {
    return {
      line: lineNumber,
      kind: 'type',
      signature: stripTrailingSemicolon(typeMatch[0]),
    };
  }

  return undefined;
};

const parseTypeScriptStructure = (content: string): TypeScriptStructure => {
  const lines = content.split(/\r?\n/);
  const imports: TypeScriptImport[] = [];
  const exports: TypeScriptExport[] = [];
  const declarations: TypeScriptDeclaration[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const trimmed = rawLine.trim();

    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      continue;
    }

    if (leadingWhitespaceLength(rawLine) !== 0) {
      continue;
    }

    const line = normalizeWhitespace(trimmed);

    if (line.startsWith('import ')) {
      imports.push({
        line: index + 1,
        statement: stripTrailingSemicolon(line),
      });
    }

    if (line.startsWith('export ')) {
      exports.push({
        line: index + 1,
        statement: stripTrailingSemicolon(line),
      });
    }

    const declaration = parseDeclaration(line, index + 1);
    if (declaration !== undefined) {
      declarations.push(declaration);
    }
  }

  return {
    lineCount: lines.length,
    imports,
    exports,
    declarations,
  };
};

const formatItemsSection = (
  title: string,
  items: readonly { readonly line: number; readonly statement: string }[],
): string[] => {
  const lines = [`### ${title}: ${items.length}`];

  if (items.length === 0) {
    lines.push('- (none)');
    return lines;
  }

  for (const item of items) {
    lines.push(`- ${item.statement} (line ${item.line})`);
  }

  return lines;
};

const formatDeclarationsSection = (declarations: readonly TypeScriptDeclaration[]): string[] => {
  const lines = [`### Declarations: ${declarations.length}`];

  if (declarations.length === 0) {
    lines.push('- (none)');
    return lines;
  }

  for (const declaration of declarations) {
    lines.push(`- ${declaration.signature} (line ${declaration.line})`);
  }

  return lines;
};

const buildSummary = (path: string, structure: TypeScriptStructure): string => {
  const importItems = structure.imports.map((entry) => ({ line: entry.line, statement: entry.statement }));
  const exportItems = structure.exports.map((entry) => ({ line: entry.line, statement: entry.statement }));

  return [
    `## File: ${path} (TypeScript)`,
    ...formatItemsSection('Imports', importItems),
    ...formatItemsSection('Exports', exportItems),
    ...formatDeclarationsSection(structure.declarations),
    '### Summary',
    `TypeScript module with ${structure.imports.length} imports, ${structure.exports.length} exports, ${structure.declarations.length} declarations. ${structure.lineCount} lines.`,
  ].join('\n');
};

const toTextContent = (content: string | Uint8Array): string => {
  if (typeof content === 'string') {
    return content;
  }

  return new TextDecoder().decode(content);
};

const createMetadata = (
  input: ExplorerInput,
  score: number,
  confidence: number,
  constrained: ReturnType<typeof constrainSummaryToTokenBudget>,
  structure: TypeScriptStructure,
  sampling: ReturnType<typeof applyStratifiedSampling>['metadata'],
): TypeScriptExplorerMetadata => {
  return {
    artifactReference: createArtifactReference(input.path, input.mimeType),
    selectedExplorer: 'typescript-explorer',
    inputClassification: 'typescript-source',
    score,
    confidence,
    truncated: constrained.truncated,
    originalTokenCount: constrained.originalTokenCount,
    outputTokenCount: constrained.outputTokenCount,
    ...(constrained.maxTokensRequested === undefined
      ? {}
      : {
          maxTokensRequested: constrained.maxTokensRequested,
        }),
    samplingApplied: sampling.samplingApplied,
    samplingStrategy: sampling.samplingStrategy,
    segmentCount: sampling.segmentCount,
    segmentRanges: sampling.segmentRanges,
    sampledChars: sampling.sampledChars,
    lineCount: structure.lineCount,
    importCount: structure.imports.length,
    exportCount: structure.exports.length,
    declarationCount: structure.declarations.length,
  };
};

export class TypeScriptExplorer implements ExplorerPort {
  readonly name = 'typescript-explorer';

  constructor(private readonly tokenizer: TokenizerPort) {}

  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number {
    void mimeType;
    void hints;
    return detectScore(path);
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    const score = this.canHandle(input.mimeType, input.path);
    const confidence = computeConfidence(score);

    const rawText = toTextContent(input.content);
    const sampled = applyStratifiedSampling(rawText);
    const structure = parseTypeScriptStructure(sampled.content);
    const summary = buildSummary(input.path, structure);
    const constrained = constrainSummaryToTokenBudget(summary, this.tokenizer, input.maxTokens);

    return {
      summary: constrained.summary,
      tokenCount: constrained.tokenCount,
      metadata: createMetadata(input, score, confidence, constrained, structure, sampled.metadata),
    };
  }
}
