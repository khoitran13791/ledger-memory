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

type JsonInputClassification = 'json-structured' | 'malformed-structured';

interface ArtifactReference {
  readonly id: string | null;
  readonly path: string;
  readonly mimeType: string;
}

interface JsonExplorerMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactReference: ArtifactReference;
  readonly selectedExplorer: string;
  readonly inputClassification: JsonInputClassification;
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
  readonly rootType?: string;
  readonly keyHierarchyCount?: number;
  readonly maxDepth?: number;
  readonly objectCount?: number;
  readonly arrayCount?: number;
  readonly primitiveCount?: number;
  readonly nullCount?: number;
  readonly distinctArrayLengths?: readonly number[];
  readonly failureClassification?: 'malformed-structured';
  readonly failureReason?: string;
  readonly actionableGuidance?: readonly string[];
}

interface JsonStructureStats {
  readonly rootType: string;
  readonly keyHierarchy: readonly string[];
  readonly maxDepth: number;
  readonly objectCount: number;
  readonly arrayCount: number;
  readonly primitiveCount: number;
  readonly nullCount: number;
  readonly distinctArrayLengths: readonly number[];
}

type ParsedJson =
  | {
      readonly parsed: true;
      readonly value: unknown;
    }
  | {
      readonly parsed: false;
    };

const JSON_EXTENSION_SCORE = 10;
const JSONL_EXTENSION_SCORE = 8;
const JSON_MIME_SCORE = 7;
const MALFORMED_FAILURE_REASON = 'Invalid JSON syntax.';
const MALFORMED_ACTIONABLE_GUIDANCE = ['Fix JSON syntax and retry exploration.'];

const detectScore = (mimeType: MimeType, path: string): number => {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith('.json')) {
    return JSON_EXTENSION_SCORE;
  }

  if (normalizedPath.endsWith('.jsonl')) {
    return JSONL_EXTENSION_SCORE;
  }

  if (mimeType.toLowerCase() === 'application/json') {
    return JSON_MIME_SCORE;
  }

  return 0;
};

const computeConfidence = (score: number): number => {
  const normalized = Math.max(0, Math.min(score, JSON_EXTENSION_SCORE)) / JSON_EXTENSION_SCORE;
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

const parseJsonContent = (text: string, path: string): ParsedJson => {
  try {
    return {
      parsed: true,
      value: JSON.parse(text),
    };
  } catch {
    // Fall through for JSONL support.
  }

  if (!path.toLowerCase().endsWith('.jsonl')) {
    return { parsed: false };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const values: unknown[] = [];
  for (const line of lines) {
    try {
      values.push(JSON.parse(line));
    } catch {
      return { parsed: false };
    }
  }

  return {
    parsed: true,
    value: values,
  };
};

const getRootType = (value: unknown): string => {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    return 'object';
  }

  return typeof value;
};

const collectJsonStructure = (root: unknown): JsonStructureStats => {
  const keyHierarchy = new Set<string>();
  const arrayLengths = new Set<number>();

  let maxDepth = 0;
  let objectCount = 0;
  let arrayCount = 0;
  let primitiveCount = 0;
  let nullCount = 0;

  const visit = (value: unknown, path: string, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);

    if (Array.isArray(value)) {
      arrayCount += 1;
      arrayLengths.add(value.length);

      const arrayPath = path.length > 0 ? `${path}[]` : '[]';
      if (path.length > 0) {
        keyHierarchy.add(arrayPath);
      }

      for (const item of value) {
        visit(item, arrayPath, depth + 1);
      }
      return;
    }

    if (value === null) {
      nullCount += 1;
      return;
    }

    if (typeof value === 'object') {
      objectCount += 1;
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      );

      for (const [key, child] of entries) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        keyHierarchy.add(childPath);
        visit(child, childPath, depth + 1);
      }
      return;
    }

    primitiveCount += 1;
  };

  visit(root, '', 1);

  return {
    rootType: getRootType(root),
    keyHierarchy: [...keyHierarchy].sort((left, right) => left.localeCompare(right)),
    maxDepth,
    objectCount,
    arrayCount,
    primitiveCount,
    nullCount,
    distinctArrayLengths: [...arrayLengths].sort((left, right) => left - right),
  };
};

const buildSummary = (path: string, stats: JsonStructureStats): string => {
  const keyHierarchyLines =
    stats.keyHierarchy.length === 0
      ? ['- (none)']
      : stats.keyHierarchy.map((keyPath) => `- ${keyPath}`);

  const arrayLengthDisplay =
    stats.distinctArrayLengths.length === 0 ? 'none' : stats.distinctArrayLengths.join(', ');

  return [
    `JSON exploration for ${path}`,
    `Root type: ${stats.rootType}`,
    `Key hierarchy (${stats.keyHierarchy.length}):`,
    ...keyHierarchyLines,
    'Container/value shape:',
    `- objects: ${stats.objectCount}`,
    `- arrays: ${stats.arrayCount}`,
    `- primitives: ${stats.primitiveCount}`,
    `- nulls: ${stats.nullCount}`,
    `- max depth: ${stats.maxDepth}`,
    `- distinct array lengths: ${arrayLengthDisplay}`,
  ].join('\n');
};

const buildMalformedSummary = (path: string): string => {
  return [
    `JSON exploration for ${path}`,
    'Input classification: malformed-structured',
    'Unable to parse JSON content.',
    'Guidance: ensure valid JSON syntax and retry.',
  ].join('\n');
};

const toTextContent = (content: string | Uint8Array): string => {
  if (typeof content === 'string') {
    return content;
  }

  return new TextDecoder().decode(content);
};

const createBaseMetadata = (
  input: ExplorerInput,
  inputClassification: JsonInputClassification,
  score: number,
  confidence: number,
  constrained: ReturnType<typeof constrainSummaryToTokenBudget>,
  sampling: ReturnType<typeof applyStratifiedSampling>['metadata'],
): JsonExplorerMetadata => {
  return {
    artifactReference: createArtifactReference(input.path, input.mimeType),
    selectedExplorer: 'json-explorer',
    inputClassification,
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
  };
};

export class JsonExplorer implements ExplorerPort {
  readonly name = 'json-explorer';

  constructor(private readonly tokenizer: TokenizerPort) {}

  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number {
    void hints;
    return detectScore(mimeType, path);
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    const score = this.canHandle(input.mimeType, input.path);
    const confidence = computeConfidence(score);
    const textContent = toTextContent(input.content);
    const sampled = applyStratifiedSampling(textContent);
    const parsed = parseJsonContent(textContent, input.path);

    if (!parsed.parsed) {
      const constrained = constrainSummaryToTokenBudget(
        buildMalformedSummary(input.path),
        this.tokenizer,
        input.maxTokens,
      );

      return {
        summary: constrained.summary,
        tokenCount: constrained.tokenCount,
        metadata: {
          ...createBaseMetadata(
            input,
            'malformed-structured',
            score,
            confidence,
            constrained,
            sampled.metadata,
          ),
          failureClassification: 'malformed-structured',
          failureReason: MALFORMED_FAILURE_REASON,
          actionableGuidance: MALFORMED_ACTIONABLE_GUIDANCE,
        },
      };
    }

    const stats = collectJsonStructure(parsed.value);
    const constrained = constrainSummaryToTokenBudget(
      buildSummary(input.path, stats),
      this.tokenizer,
      input.maxTokens,
    );

    return {
      summary: constrained.summary,
      tokenCount: constrained.tokenCount,
      metadata: {
        ...createBaseMetadata(input, 'json-structured', score, confidence, constrained, sampled.metadata),
        rootType: stats.rootType,
        keyHierarchyCount: stats.keyHierarchy.length,
        maxDepth: stats.maxDepth,
        objectCount: stats.objectCount,
        arrayCount: stats.arrayCount,
        primitiveCount: stats.primitiveCount,
        nullCount: stats.nullCount,
        distinctArrayLengths: stats.distinctArrayLengths,
      },
    };
  }
}
