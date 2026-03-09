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

type FallbackInputClassification =
  | 'unsupported-readable'
  | 'unsupported-unreadable'
  | 'malformed-structured';

type FallbackFailureClassification =
  | 'unsupported-readable'
  | 'unsupported-unreadable'
  | 'malformed-structured';

interface ArtifactReference {
  readonly id: string | null;
  readonly path: string;
  readonly mimeType: string;
}

interface FallbackFailureMetadata {
  readonly classification: FallbackFailureClassification;
  readonly reason: string;
  readonly actionableGuidance: readonly string[];
}

interface FallbackExplorerMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactReference: ArtifactReference;
  readonly selectedExplorer: 'fallback-explorer';
  readonly inputClassification: FallbackInputClassification;
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
  readonly mimeType: string;
  readonly path: string;
  readonly contentKind: 'text' | 'binary';
  readonly characterCount?: number;
  readonly byteLength?: number;
  readonly previewLineCount: number;
  readonly failureClassification?: FallbackFailureClassification;
  readonly failureReason?: string;
  readonly actionableGuidance?: readonly string[];
}

interface ExplorationDraft {
  readonly summary: string;
  readonly inputClassification: FallbackInputClassification;
  readonly contentKind: 'text' | 'binary';
  readonly characterCount?: number;
  readonly byteLength?: number;
  readonly failure?: FallbackFailureMetadata;
}

const DEFAULT_PREVIEW_LINE_COUNT = 5;
const FALLBACK_SCORE = 1;
const FALLBACK_MAX_SCORE = 10;

const UNSUPPORTED_UNREADABLE_REASON = 'Input bytes cannot be decoded as UTF-8 text.';
const UNSUPPORTED_UNREADABLE_GUIDANCE = [
  'Ensure artifact content is UTF-8 encoded text before exploration.',
  'If content is intentionally binary, use a binary-aware workflow instead of text exploration.',
] as const;

const MALFORMED_STRUCTURED_REASON = 'Structured content is malformed and could not be parsed.';
const MALFORMED_STRUCTURED_GUIDANCE = [
  'Fix structured syntax issues (for JSON/JSONL: commas, quotes, and brackets) and retry exploration.',
  'If partial data is intentional, provide a cleaned or schema-valid snippet for exploration.',
] as const;

const TEXT_LIKE_EXTENSIONS = [
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.csv',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.json',
  '.jsonl',
  '.log',
  '.ini',
  '.cfg',
  '.conf',
  '.toml',
] as const;


const summarizeText = (content: string, path: string, mimeType: MimeType): string => {
  const lines = content.split(/\r?\n/);
  const previewLines = lines.slice(0, DEFAULT_PREVIEW_LINE_COUNT);

  return [
    `Fallback exploration for ${path}`,
    `MIME type: ${mimeType}`,
    `Text lines: ${lines.length}`,
    `Characters: ${content.length}`,
    'Preview:',
    ...previewLines.map((line, index) => `${index + 1}. ${line}`),
  ].join('\n');
};

const summarizeBinary = (content: Uint8Array, path: string, mimeType: MimeType): string => {
  const previewBytes = [...content.slice(0, 16)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join(' ');

  return [
    `Fallback exploration for ${path}`,
    `MIME type: ${mimeType}`,
    `Binary bytes: ${content.byteLength}`,
    `Preview bytes: ${previewBytes}`,
  ].join('\n');
};

const summarizeUnsupportedUnreadable = (path: string, mimeType: MimeType): string => {
  return [
    `Fallback exploration unavailable for ${path}`,
    `MIME type: ${mimeType}`,
    'Input classification: unsupported-unreadable',
    `Reason: ${UNSUPPORTED_UNREADABLE_REASON}`,
    'Guidance:',
    ...UNSUPPORTED_UNREADABLE_GUIDANCE.map((guidance) => `- ${guidance}`),
  ].join('\n');
};

const summarizeMalformedStructured = (path: string, mimeType: MimeType): string => {
  return [
    `Fallback exploration for ${path}`,
    `MIME type: ${mimeType}`,
    'Input classification: malformed-structured',
    `Reason: ${MALFORMED_STRUCTURED_REASON}`,
    'Guidance:',
    ...MALFORMED_STRUCTURED_GUIDANCE.map((guidance) => `- ${guidance}`),
  ].join('\n');
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

const computeConfidence = (score: number): number => {
  const normalized = Math.max(0, Math.min(score, FALLBACK_MAX_SCORE)) / FALLBACK_MAX_SCORE;
  return Number(normalized.toFixed(2));
};

const isJsonLikeInput = (path: string, mimeType: MimeType): boolean => {
  const normalizedPath = path.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase();
  return (
    normalizedPath.endsWith('.json') ||
    normalizedPath.endsWith('.jsonl') ||
    normalizedMimeType.includes('json') ||
    normalizedMimeType.includes('ndjson')
  );
};

const hasTextLikeExtension = (path: string): boolean => {
  const normalizedPath = path.toLowerCase();
  return TEXT_LIKE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
};

const isTextLikeMimeType = (mimeType: MimeType): boolean => {
  const normalizedMimeType = mimeType.toLowerCase();
  return (
    normalizedMimeType.startsWith('text/') ||
    normalizedMimeType.includes('json') ||
    normalizedMimeType.includes('xml') ||
    normalizedMimeType.includes('yaml') ||
    normalizedMimeType.includes('csv') ||
    normalizedMimeType.includes('javascript')
  );
};

const shouldAttemptTextDecode = (path: string, mimeType: MimeType): boolean => {
  return isJsonLikeInput(path, mimeType) || hasTextLikeExtension(path) || isTextLikeMimeType(mimeType);
};

const parseJsonLike = (content: string, path: string): boolean => {
  try {
    JSON.parse(content);
    return true;
  } catch {
    // Fallback to line-delimited JSON parsing when path indicates jsonl.
  }

  if (!path.toLowerCase().endsWith('.jsonl')) {
    return false;
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return true;
  }

  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }

  return true;
};

const decodeUtf8 = (content: Uint8Array): string => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(content);
};

const createDraftFromText = (content: string, path: string, mimeType: MimeType): ExplorationDraft => {
  if (isJsonLikeInput(path, mimeType) && !parseJsonLike(content, path)) {
    return {
      summary: summarizeMalformedStructured(path, mimeType),
      inputClassification: 'malformed-structured',
      contentKind: 'text',
      characterCount: content.length,
      failure: {
        classification: 'malformed-structured',
        reason: MALFORMED_STRUCTURED_REASON,
        actionableGuidance: MALFORMED_STRUCTURED_GUIDANCE,
      },
    };
  }

  return {
    summary: summarizeText(content, path, mimeType),
    inputClassification: 'unsupported-readable',
    contentKind: 'text',
    characterCount: content.length,
  };
};

const createDraftFromBinary = (content: Uint8Array, path: string, mimeType: MimeType): ExplorationDraft => {
  if (!shouldAttemptTextDecode(path, mimeType)) {
    return {
      summary: summarizeBinary(content, path, mimeType),
      inputClassification: 'unsupported-readable',
      contentKind: 'binary',
      byteLength: content.byteLength,
    };
  }

  try {
    const decoded = decodeUtf8(content);

    if (isJsonLikeInput(path, mimeType) && !parseJsonLike(decoded, path)) {
      return {
        summary: summarizeMalformedStructured(path, mimeType),
        inputClassification: 'malformed-structured',
        contentKind: 'text',
        characterCount: decoded.length,
        failure: {
          classification: 'malformed-structured',
          reason: MALFORMED_STRUCTURED_REASON,
          actionableGuidance: MALFORMED_STRUCTURED_GUIDANCE,
        },
      };
    }

    return {
      summary: summarizeText(decoded, path, mimeType),
      inputClassification: 'unsupported-readable',
      contentKind: 'text',
      characterCount: decoded.length,
    };
  } catch {
    return {
      summary: summarizeUnsupportedUnreadable(path, mimeType),
      inputClassification: 'unsupported-unreadable',
      contentKind: 'binary',
      byteLength: content.byteLength,
      failure: {
        classification: 'unsupported-unreadable',
        reason: UNSUPPORTED_UNREADABLE_REASON,
        actionableGuidance: UNSUPPORTED_UNREADABLE_GUIDANCE,
      },
    };
  }
};

const createMetadata = (
  input: ExplorerInput,
  score: number,
  confidence: number,
  constrained: ReturnType<typeof constrainSummaryToTokenBudget>,
  draft: ExplorationDraft,
  sampling: ReturnType<typeof applyStratifiedSampling>['metadata'],
): FallbackExplorerMetadata => {
  return {
    artifactReference: createArtifactReference(input.path, input.mimeType),
    selectedExplorer: 'fallback-explorer',
    inputClassification: draft.inputClassification,
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
    mimeType: input.mimeType,
    path: input.path,
    contentKind: draft.contentKind,
    ...(draft.characterCount === undefined ? {} : { characterCount: draft.characterCount }),
    ...(draft.byteLength === undefined ? {} : { byteLength: draft.byteLength }),
    previewLineCount: DEFAULT_PREVIEW_LINE_COUNT,
    ...(draft.failure === undefined
      ? {}
      : {
          failureClassification: draft.failure.classification,
          failureReason: draft.failure.reason,
          actionableGuidance: draft.failure.actionableGuidance,
        }),
  };
};

export class FallbackExplorer implements ExplorerPort {
  readonly name = 'fallback-explorer';

  constructor(private readonly tokenizer: TokenizerPort) {}

  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number {
    void mimeType;
    void path;
    void hints;
    return FALLBACK_SCORE;
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    const score = this.canHandle(input.mimeType, input.path);
    const confidence = computeConfidence(score);

    const sampling =
      typeof input.content === 'string'
        ? applyStratifiedSampling(input.content)
        : {
            content: input.content,
            metadata: {
              samplingApplied: false,
              samplingStrategy: 'none' as const,
              segmentCount: 0,
              segmentRanges: [],
              sampledChars: 0,
            },
          };

    const draft =
      typeof sampling.content === 'string'
        ? createDraftFromText(sampling.content, input.path, input.mimeType)
        : createDraftFromBinary(sampling.content, input.path, input.mimeType);

    const constrained = constrainSummaryToTokenBudget(draft.summary, this.tokenizer, input.maxTokens);

    return {
      summary: constrained.summary,
      metadata: createMetadata(input, score, confidence, constrained, draft, sampling.metadata),
      tokenCount: constrained.tokenCount,
    };
  }
}
