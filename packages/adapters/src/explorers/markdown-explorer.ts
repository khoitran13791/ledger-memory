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

type MarkdownInputClassification = 'markdown-document' | 'unsupported-unreadable';

interface ArtifactReference {
  readonly id: string | null;
  readonly path: string;
  readonly mimeType: string;
}

interface MarkdownHeading {
  readonly line: number;
  readonly level: number;
  readonly title: string;
}

interface MarkdownSection {
  readonly heading: MarkdownHeading;
  readonly startLine: number;
  readonly endLine: number;
}

interface MarkdownStructure {
  readonly lineCount: number;
  readonly headings: readonly MarkdownHeading[];
  readonly sections: readonly MarkdownSection[];
  readonly maxHeadingLevel: number;
  readonly codeFenceCount: number;
  readonly linkCount: number;
}

interface MarkdownExplorerMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactReference: ArtifactReference;
  readonly selectedExplorer: string;
  readonly inputClassification: MarkdownInputClassification;
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
  readonly lineCount?: number;
  readonly headingCount?: number;
  readonly sectionCount?: number;
  readonly maxHeadingLevel?: number;
  readonly codeFenceCount?: number;
  readonly linkCount?: number;
  readonly failureClassification?: 'unsupported-unreadable';
  readonly failureReason?: string;
  readonly actionableGuidance?: readonly string[];
}

const MARKDOWN_MD_SCORE = 10;
const MARKDOWN_MDX_SCORE = 9;
const MARKDOWN_MIME_SCORE = 7;
const UNREADABLE_FAILURE_REASON = 'Input bytes cannot be decoded as UTF-8 Markdown text.';
const UNREADABLE_ACTIONABLE_GUIDANCE = [
  'Ensure artifact content is UTF-8 encoded text before exploration.',
] as const;

const detectScore = (mimeType: MimeType, path: string): number => {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith('.md')) {
    return MARKDOWN_MD_SCORE;
  }

  if (normalizedPath.endsWith('.mdx')) {
    return MARKDOWN_MDX_SCORE;
  }

  const normalizedMimeType = mimeType.toLowerCase();
  if (
    normalizedMimeType === 'text/markdown' ||
    normalizedMimeType === 'application/markdown' ||
    normalizedMimeType.endsWith('+markdown') ||
    normalizedMimeType.includes('markdown')
  ) {
    return MARKDOWN_MIME_SCORE;
  }

  return 0;
};

const computeConfidence = (score: number): number => {
  const normalized = Math.max(0, Math.min(score, MARKDOWN_MD_SCORE)) / MARKDOWN_MD_SCORE;
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

const createBaseMetadata = (
  input: ExplorerInput,
  inputClassification: MarkdownInputClassification,
  score: number,
  confidence: number,
  constrained: ReturnType<typeof constrainSummaryToTokenBudget>,
  sampling: ReturnType<typeof applyStratifiedSampling>['metadata'],
): MarkdownExplorerMetadata => {
  return {
    artifactReference: createArtifactReference(input.path, input.mimeType),
    selectedExplorer: 'markdown-explorer',
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

const decodeUtf8 = (content: Uint8Array): string => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(content);
};

const parseMarkdownStructure = (content: string): MarkdownStructure => {
  const lines = content.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];

  let inCodeFence = false;
  let codeFenceChar: '`' | '~' | null = null;
  let codeFenceLength = 0;
  let codeFenceCount = 0;
  let linkCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch !== null) {
      const token = fenceMatch[1] ?? '';
      const tokenChar = token[0];
      const tokenLength = token.length;

      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceChar = tokenChar === '`' ? '`' : '~';
        codeFenceLength = tokenLength;
        codeFenceCount += 1;
        continue;
      }

      if (codeFenceChar === tokenChar && tokenLength >= codeFenceLength) {
        inCodeFence = false;
        codeFenceChar = null;
        codeFenceLength = 0;
        continue;
      }
    }

    if (inCodeFence) {
      continue;
    }

    const linksOnLine = [...line.matchAll(/!?\[[^\]]+\]\([^)]+\)/g)];
    linkCount += linksOnLine.filter((match) => !(match[0] ?? '').startsWith('!')).length;

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch !== null) {
      const hashes = headingMatch[1] ?? '';
      const rawTitle = (headingMatch[2] ?? '').trim();
      headings.push({
        line: index + 1,
        level: hashes.length,
        title: rawTitle.length > 0 ? rawTitle : '(empty heading)',
      });
    }
  }

  const sections: MarkdownSection[] = headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const endLine = (nextHeading?.line ?? lines.length + 1) - 1;

    return {
      heading,
      startLine: heading.line,
      endLine,
    };
  });

  return {
    lineCount: lines.length,
    headings,
    sections,
    maxHeadingLevel: headings.reduce((maxLevel, heading) => Math.max(maxLevel, heading.level), 0),
    codeFenceCount,
    linkCount,
  };
};

const buildHeadingHierarchy = (headings: readonly MarkdownHeading[]): string[] => {
  const lines = [`### Heading Hierarchy (${headings.length})`];

  if (headings.length === 0) {
    lines.push('- (none)');
    return lines;
  }

  for (const heading of headings) {
    lines.push(`${'  '.repeat(Math.max(0, heading.level - 1))}- H${heading.level} ${heading.title} (line ${heading.line})`);
  }

  return lines;
};

const buildSectionOutline = (sections: readonly MarkdownSection[]): string[] => {
  const lines = [`### Section Outline (${sections.length})`];

  if (sections.length === 0) {
    lines.push('- (none)');
    return lines;
  }

  sections.forEach((section, index) => {
    const span = Math.max(0, section.endLine - section.startLine + 1);
    lines.push(
      `- ${index + 1}. H${section.heading.level} ${section.heading.title} (lines ${section.startLine}-${section.endLine}, span ${span})`,
    );
  });

  return lines;
};

const buildDocumentStats = (structure: MarkdownStructure): string[] => {
  return [
    '### Document Stats',
    `- lines: ${structure.lineCount}`,
    `- headings: ${structure.headings.length}`,
    `- sections: ${structure.sections.length}`,
    `- max heading level: ${structure.maxHeadingLevel}`,
    `- fenced code blocks: ${structure.codeFenceCount}`,
    `- links: ${structure.linkCount}`,
  ];
};

const buildSummary = (path: string, structure: MarkdownStructure): string => {
  return [
    `## File: ${path} (Markdown)`,
    ...buildHeadingHierarchy(structure.headings),
    ...buildSectionOutline(structure.sections),
    ...buildDocumentStats(structure),
  ].join('\n');
};

export class MarkdownExplorer implements ExplorerPort {
  readonly name = 'markdown-explorer';

  constructor(private readonly tokenizer: TokenizerPort) {}

  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number {
    void hints;
    return detectScore(mimeType, path);
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    const score = this.canHandle(input.mimeType, input.path);
    const confidence = computeConfidence(score);

    let content: string;
    try {
      content = typeof input.content === 'string' ? input.content : decodeUtf8(input.content);
    } catch {
      const failureSummary = [
        `Markdown exploration unavailable for ${input.path}`,
        'Reason: unable to decode input bytes as UTF-8 text.',
        'Guidance: provide readable UTF-8 Markdown content.',
      ].join('\n');

      const constrainedFailure = constrainSummaryToTokenBudget(failureSummary, this.tokenizer, input.maxTokens);
      return {
        summary: constrainedFailure.summary,
        tokenCount: constrainedFailure.tokenCount,
        metadata: {
          ...createBaseMetadata(
            input,
            'unsupported-unreadable',
            score,
            confidence,
            constrainedFailure,
            {
              samplingApplied: false,
              samplingStrategy: 'none',
              segmentCount: 0,
              segmentRanges: [],
              sampledChars: 0,
            },
          ),
          failureClassification: 'unsupported-unreadable',
          failureReason: UNREADABLE_FAILURE_REASON,
          actionableGuidance: UNREADABLE_ACTIONABLE_GUIDANCE,
        },
      };
    }

    const sampled = applyStratifiedSampling(content);
    const structure = parseMarkdownStructure(sampled.content);
    const constrained = constrainSummaryToTokenBudget(
      buildSummary(input.path, structure),
      this.tokenizer,
      input.maxTokens,
    );

    return {
      summary: constrained.summary,
      tokenCount: constrained.tokenCount,
      metadata: {
        ...createBaseMetadata(input, 'markdown-document', score, confidence, constrained, sampled.metadata),
        lineCount: structure.lineCount,
        headingCount: structure.headings.length,
        sectionCount: structure.sections.length,
        maxHeadingLevel: structure.maxHeadingLevel,
        codeFenceCount: structure.codeFenceCount,
        linkCount: structure.linkCount,
      },
    };
  }
}
