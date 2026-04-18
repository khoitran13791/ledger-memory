import { InvalidReferenceError } from '../errors/application-errors';
import type { SummaryNodeId } from '@ledgermind/domain';
import type {
  GrepMatch as LedgerReadGrepMatch,
  LedgerReadPort,
} from '../ports/driven/persistence/ledger-read.port';
import type { SummaryDagPort } from '../ports/driven/persistence/summary-dag.port';
import type {
  GrepGroup,
  GrepInput,
  GrepMatch,
  GrepOutput,
} from '../ports/driving/memory-engine.port';

export interface GrepUseCaseDeps {
  readonly ledgerRead: LedgerReadPort;
  readonly summaryDag: SummaryDagPort;
}

const DEFAULT_GREP_LIMIT = 25;
const MAX_GREP_LIMIT = 100;

const normalizeOffset = (value: number | undefined): number => {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    return 0;
  }

  return value;
};

const normalizeLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return DEFAULT_GREP_LIMIT;
  }

  return Math.min(value, MAX_GREP_LIMIT);
};

const toPublicMatch = (match: LedgerReadGrepMatch): GrepMatch => {
  return {
    eventId: match.eventId,
    sequence: match.sequence,
    excerpt: match.excerpt,
  };
};

const toPublicGroups = (matches: readonly LedgerReadGrepMatch[]): readonly GrepGroup[] => {
  const groups: Array<{
    coveringSummaryId: SummaryNodeId | null;
    matches: GrepMatch[];
  }> = [];

  for (const match of matches) {
    const current = groups.at(-1);

    if (current !== undefined && current.coveringSummaryId === match.coveringSummaryId) {
      current.matches.push(toPublicMatch(match));
      continue;
    }

    groups.push({
      coveringSummaryId: match.coveringSummaryId ?? null,
      matches: [toPublicMatch(match)],
    });
  }

  return groups.map((group): GrepGroup => {
    if (group.coveringSummaryId === null) {
      return {
        matches: group.matches,
      };
    }

    return {
      coveringSummaryId: group.coveringSummaryId,
      matches: group.matches,
    };
  });
};

export class GrepUseCase {
  constructor(private readonly deps: GrepUseCaseDeps) {}

  async execute(input: GrepInput): Promise<GrepOutput> {
    if (input.scope) {
      const summaryNode = await this.deps.summaryDag.getNode(input.scope);
      if (!summaryNode || summaryNode.conversationId !== input.conversationId) {
        throw new InvalidReferenceError(
          'summary_scope',
          input.scope,
          `Unknown summary scope reference: ${input.scope}`,
        );
      }
    }

    const offset = normalizeOffset(input.offset);
    const limit = normalizeLimit(input.limit);
    const page = await this.deps.ledgerRead.regexSearchEvents(input.conversationId, input.pattern, {
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      offset,
      limit,
    });
    const returnedMatchCount = page.matches.length;
    const nextOffset = offset + returnedMatchCount;

    return {
      groups: toPublicGroups(page.matches),
      page: {
        offset,
        limit,
        returnedMatchCount,
        totalMatchCount: page.totalMatchCount,
        hasMore: nextOffset < page.totalMatchCount,
        ...(nextOffset < page.totalMatchCount ? { nextOffset } : {}),
      },
    };
  }
}
