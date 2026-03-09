export interface SegmentRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface StratifiedSamplingMetadata {
  readonly samplingApplied: boolean;
  readonly samplingStrategy: 'stratified-begin-middle-end' | 'none';
  readonly segmentCount: number;
  readonly segmentRanges: readonly SegmentRange[];
  readonly sampledChars: number;
}

export interface StratifiedSamplingResult {
  readonly content: string;
  readonly metadata: StratifiedSamplingMetadata;
}

export interface StratifiedSamplingOptions {
  readonly largeArtifactThresholdChars?: number;
  readonly segmentChars?: number;
}

const DEFAULT_LARGE_ARTIFACT_THRESHOLD_CHARS = 4096;
const DEFAULT_SEGMENT_CHARS = 1024;

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const collectSegment = (content: string, range: SegmentRange): string => {
  return content.slice(range.startOffset, range.endOffset);
};

/**
 * Applies deterministic beginning/middle/end stratified sampling for large text artifacts.
 * For non-large artifacts, returns original content with sampling metadata disabled.
 */
export const applyStratifiedSampling = (
  content: string,
  options?: StratifiedSamplingOptions,
): StratifiedSamplingResult => {
  const threshold = normalizePositiveInteger(
    options?.largeArtifactThresholdChars,
    DEFAULT_LARGE_ARTIFACT_THRESHOLD_CHARS,
  );

  if (content.length <= threshold) {
    return {
      content,
      metadata: {
        samplingApplied: false,
        samplingStrategy: 'none',
        segmentCount: 0,
        segmentRanges: [],
        sampledChars: content.length,
      },
    };
  }

  const configuredSegmentChars = normalizePositiveInteger(options?.segmentChars, DEFAULT_SEGMENT_CHARS);
  const segmentLength = Math.max(1, Math.min(configuredSegmentChars, Math.floor(content.length / 3)));

  const beginning: SegmentRange = {
    startOffset: 0,
    endOffset: segmentLength,
  };

  const ending: SegmentRange = {
    startOffset: content.length - segmentLength,
    endOffset: content.length,
  };

  const minMiddleStart = beginning.endOffset;
  const maxMiddleStart = ending.startOffset - segmentLength;
  const centeredMiddleStart = Math.floor((content.length - segmentLength) / 2);
  const middleStart = clamp(centeredMiddleStart, minMiddleStart, maxMiddleStart);

  const middle: SegmentRange = {
    startOffset: middleStart,
    endOffset: middleStart + segmentLength,
  };

  const ranges: readonly SegmentRange[] = [beginning, middle, ending];
  const sampled = ranges
    .map((range) => collectSegment(content, range))
    .join('\n\n[... stratified sample boundary ...]\n\n');

  return {
    content: sampled,
    metadata: {
      samplingApplied: true,
      samplingStrategy: 'stratified-begin-middle-end',
      segmentCount: ranges.length,
      segmentRanges: ranges,
      sampledChars: sampled.length,
    },
  };
};
