import type { ExplorerHints, ExplorerPort, ExplorerRegistryPort } from '@ledgermind/application';
import { InvariantViolationError, type MimeType } from '@ledgermind/domain';

const EXTENSION_WEIGHT = 60;
const MIME_WEIGHT = 25;
const SNIFFING_WEIGHT = 15;
const UNKNOWN_MIME_TYPE = 'application/x-ledgermind-unknown' as MimeType;

export interface ResolverCandidateRanking {
  readonly totalScore: number;
  readonly extensionContribution: number;
  readonly mimeContribution: number;
  readonly sniffingContribution: number;
  readonly index: number;
}

interface Candidate extends ResolverCandidateRanking {
  readonly explorer: ExplorerPort;
  readonly extensionRaw: number;
  readonly mimeRaw: number;
  readonly sniffingRaw: number;
}

const sanitizeScore = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
};

const roundToStablePrecision = (value: number): number => {
  return Number(value.toFixed(6));
};

const stripFileExtension = (path: string): string => {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const lastDot = path.lastIndexOf('.');

  if (lastDot <= lastSlash + 1) {
    return path;
  }

  return path.slice(0, lastDot);
};

const normalizeContribution = (raw: number, maxRaw: number, weight: number): number => {
  if (raw <= 0 || maxRaw <= 0) {
    return 0;
  }

  const normalized = (raw / maxRaw) * weight;
  const clamped = Math.max(0, Math.min(weight, normalized));
  return roundToStablePrecision(clamped);
};

const withWeightedContributions = (candidates: readonly Candidate[]): Candidate[] => {
  const maxExtensionRaw = candidates.reduce((maxRaw, candidate) => Math.max(maxRaw, candidate.extensionRaw), 0);
  const maxMimeRaw = candidates.reduce((maxRaw, candidate) => Math.max(maxRaw, candidate.mimeRaw), 0);
  const maxSniffingRaw = candidates.reduce((maxRaw, candidate) => Math.max(maxRaw, candidate.sniffingRaw), 0);

  return candidates.map((candidate) => {
    const extensionContribution = normalizeContribution(
      candidate.extensionRaw,
      maxExtensionRaw,
      EXTENSION_WEIGHT,
    );
    const mimeContribution = normalizeContribution(candidate.mimeRaw, maxMimeRaw, MIME_WEIGHT);
    const sniffingContribution = normalizeContribution(
      candidate.sniffingRaw,
      maxSniffingRaw,
      SNIFFING_WEIGHT,
    );
    const totalScore = roundToStablePrecision(
      extensionContribution + mimeContribution + sniffingContribution,
    );

    return {
      ...candidate,
      extensionContribution,
      mimeContribution,
      sniffingContribution,
      totalScore,
    };
  });
};

export const compareResolverCandidates = (
  left: ResolverCandidateRanking,
  right: ResolverCandidateRanking,
): number => {
  if (left.totalScore !== right.totalScore) {
    return right.totalScore - left.totalScore;
  }

  if (left.extensionContribution !== right.extensionContribution) {
    return right.extensionContribution - left.extensionContribution;
  }

  if (left.mimeContribution !== right.mimeContribution) {
    return right.mimeContribution - left.mimeContribution;
  }

  if (left.sniffingContribution !== right.sniffingContribution) {
    return right.sniffingContribution - left.sniffingContribution;
  }

  return left.index - right.index;
};

const createCandidate = (
  explorer: ExplorerPort,
  index: number,
  mimeType: MimeType,
  path: string,
  hints?: ExplorerHints,
): Candidate => {
  const pathWithoutExtension = stripFileExtension(path);

  const fullScore = sanitizeScore(explorer.canHandle(mimeType, path, hints));
  const noExtensionScore = sanitizeScore(explorer.canHandle(mimeType, pathWithoutExtension, hints));
  const noMimeScore = sanitizeScore(explorer.canHandle(UNKNOWN_MIME_TYPE, path, hints));
  const neutralScore = sanitizeScore(explorer.canHandle(UNKNOWN_MIME_TYPE, pathWithoutExtension, hints));

  return {
    explorer,
    index,
    extensionRaw: Math.max(0, fullScore - noExtensionScore),
    mimeRaw: Math.max(0, fullScore - noMimeScore),
    sniffingRaw: Math.max(0, neutralScore),
    extensionContribution: 0,
    mimeContribution: 0,
    sniffingContribution: 0,
    totalScore: 0,
  };
};

export class ExplorerRegistry implements ExplorerRegistryPort {
  private readonly explorers: ExplorerPort[] = [];

  register(explorer: ExplorerPort): void {
    this.explorers.push(explorer);
  }

  resolve(mimeType: MimeType, path: string, hints?: ExplorerHints): ExplorerPort {
    const candidates = withWeightedContributions(
      this.explorers.map((explorer, index) => createCandidate(explorer, index, mimeType, path, hints)),
    )
      .filter((candidate) => candidate.totalScore > 0)
      .sort(compareResolverCandidates);

    const selected = candidates[0];
    if (selected === undefined) {
      throw new InvariantViolationError(
        `No explorer can handle path=${path} mimeType=${mimeType}. Register a fallback explorer.`,
      );
    }

    return selected.explorer;
  }
}
