import type {
  DescribeOutput,
  DescribeArtifactPlanningSignals,
  DescribeSummaryPlanningSignals,
  RetrievalHint,
} from '@ledgermind/application';

import type {
  BaselineContextResult,
  BaselineExecutionInput,
  BaselineExecutionResult,
  BaselineStrategy,
  FairnessConfig,
  LedgermindDiagnostics,
  LedgermindSummarizationTraceEntry,
  LedgermindToolLoopDiagnostics,
  LedgermindToolStepTrace,
  LedgermindVariant,
  LocomoBaselineName,
  LocomoRuntimeLabeledLedgermindBaselineName,
  LocomoRuntimeMode,
  LocomoRuntimeProvenance,
} from './types.js';
import { buildContextLines, extractTurns, hasArtifactLikeContent } from './conversation.js';
import { createLedgermindRuntime, type LedgermindRuntime } from './ledgermind-runtime.js';
import type { LocomoBenchmarkConfig } from './config.js';
import { generatePrediction } from './predictor.js';
import { clampString, estimateTokens } from './utils.js';

const qaSystemInstructionCategoryAware = (input: { readonly category: number }): string => {
  if (input.category === 5) {
    return 'Answer strictly from the provided conversation context. If the answer is unsupported, reply exactly "Not mentioned in the conversation". Output only a short phrase.';
  }

  if (input.category === 2) {
    return 'Answer strictly from the provided conversation context. For temporal questions, prefer an approximate date from DATE fields when available. Output only a short phrase.';
  }

  return 'Answer strictly from the provided conversation context. Choose the best-supported short phrase from the evidence and avoid unnecessary abstention. Output only a short phrase.';
};

const qaPromptCategoryAware = (input: {
  readonly fairness: FairnessConfig;
  readonly question: string;
  readonly category: number;
}): string => {
  if (input.category === 5) {
    return `${input.fairness.promptTemplate}\nQuestion: ${input.question}\nIf the answer is not supported by the conversation, answer "Not mentioned in the conversation".\nShort answer:`;
  }

  if (input.category === 2) {
    return `${input.fairness.promptTemplate}\nQuestion: ${input.question}\nAnswer with an approximate date using DATE fields from the conversation when possible.\nShort answer:`;
  }

  return `${input.fairness.promptTemplate}\nQuestion: ${input.question}\nUse the strongest supporting evidence in the conversation; only answer "No information available" if there is no relevant evidence.\nShort answer:`;
};

const shouldEnableAbstentionRetry = (category: number): boolean => {
  return category === 1 || category === 2 || category === 3 || category === 4;
};

type OracleBaselineName = 'oracle_evidence' | 'oracle_full_conversation_llm';

const assertOracleLlmMode = (input: {
  readonly baselineName: OracleBaselineName;
  readonly predictionMode: 'heuristic' | 'llm';
}): void => {
  if (input.predictionMode !== 'llm') {
    throw new Error(
      `${input.baselineName} requires --prediction-mode llm so oracle baselines always use real LLM answer generation.`,
    );
  }
};

const tokenizeOverlapTerms = (text: string): readonly string[] => {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);

  return Object.freeze([...new Set(tokens)]);
};

const scoreLineForQuestion = (line: string, question: string): number => {
  const questionTokens = tokenizeOverlapTerms(question);
  if (questionTokens.length === 0) {
    return 0;
  }

  const normalizedLine = line.toLowerCase();
  let score = 0;

  for (const token of questionTokens) {
    if (normalizedLine.includes(token)) {
      score += 1;
    }
  }

  return score;
};

const scoreLineAgainstQuestionTokens = (
  line: string,
  questionTokens: readonly string[],
): { readonly overlapCount: number; readonly overlapDensity: number } => {
  if (questionTokens.length === 0) {
    return {
      overlapCount: 0,
      overlapDensity: 0,
    };
  }

  const normalizedLine = line.toLowerCase();
  let overlapCount = 0;
  for (const token of questionTokens) {
    if (normalizedLine.includes(token)) {
      overlapCount += 1;
    }
  }

  const lineTokens = tokenizeOverlapTerms(line);

  return {
    overlapCount,
    overlapDensity: lineTokens.length === 0 ? 0 : overlapCount / lineTokens.length,
  };
};

const toContextWithinBudget = (input: {
  readonly lines: readonly { readonly id: string; readonly text: string; readonly tokenEstimate: number }[];
  readonly tokenBudget: number;
  readonly includeFromEnd: boolean;
}): BaselineContextResult => {
  const ordered = input.includeFromEnd ? [...input.lines].reverse() : [...input.lines];
  const kept: { id: string; text: string; tokenEstimate: number }[] = [];

  let used = 0;
  for (const line of ordered) {
    if (used + line.tokenEstimate > input.tokenBudget) {
      continue;
    }

    kept.push({ ...line });
    used += line.tokenEstimate;
  }

  const finalized = input.includeFromEnd ? kept.reverse() : kept;

  return {
    context: finalized.map((line) => line.text).join('\n'),
    contextIds: finalized.map((line) => line.id),
    contextTokenEstimate: finalized.reduce((acc, line) => acc + line.tokenEstimate, 0),
    parityMode: 'parity',
  };
};

const toLedgermindFallbackSnippet = (context: string): string | undefined => {
  return context
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(assistant|user|system|tool):\s*/i, '').trim())
    .filter((line) => !line.toLowerCase().startsWith('you have access to memory tools'))
    .filter((line) => !line.toLowerCase().startsWith('available summaries:'))
    .filter((line) => !line.toLowerCase().startsWith('available artifacts:'))
    .map((line) => line.replace(/^\[Summary ID:[^\]]+\]\s*/i, '').trim())
    .map((line) => line.replace(/^\[(Aggressive )?Summary\]\s*/i, '').trim())
    .find((line) => line.length > 0);
};

const splitContextCandidates = (context: string): readonly string[] => {
  return context
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(assistant|user|system|tool):\s*/i, '').trim())
    .map((line) => line.replace(/^\[Summary ID:[^\]]+\]\s*/i, '').trim())
    .map((line) => line.replace(/^\[(Aggressive )?Summary\]\s*/i, '').trim())
    .filter((line) => line.length > 0)
    .flatMap((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
};

const extractDateFromContext = (context: string): string | undefined => {
  const datePrefixMatch = context.match(/\bDATE:\s*([^|\n]+)/i);
  if (datePrefixMatch?.[1] !== undefined) {
    return datePrefixMatch[1].trim();
  }

  const isoDateMatch = context.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoDateMatch?.[0] !== undefined) {
    return isoDateMatch[0].trim();
  }

  return undefined;
};

const selectBestQuestionAnchoredSnippet = (input: {
  readonly context: string;
  readonly question: string;
  readonly baselineName: LocomoBaselineName;
}): {
  readonly snippet?: string;
  readonly score: number;
} => {
  const candidates = splitContextCandidates(input.context);
  const questionTokens = tokenizeOverlapTerms(input.question);

  const ranked = candidates
    .map((candidate, index) => {
      const scored = scoreLineAgainstQuestionTokens(candidate, questionTokens);
      const dateValue = extractDateFromContext(candidate);
      return {
        candidate,
        index,
        overlapCount: scored.overlapCount,
        overlapDensity: scored.overlapDensity,
        hasDate: dateValue !== undefined,
      };
    })
    .filter((candidate) => candidate.overlapCount > 0)
    .sort((left, right) => {
      if (right.overlapDensity !== left.overlapDensity) {
        return right.overlapDensity - left.overlapDensity;
      }

      if (right.overlapCount !== left.overlapCount) {
        return right.overlapCount - left.overlapCount;
      }

      if (right.hasDate !== left.hasDate) {
        return right.hasDate ? 1 : -1;
      }

      return left.index - right.index;
    });

  if (ranked.length > 0) {
    const topCandidates = ranked.slice(0, 2).map((candidate) => candidate.candidate);
    return {
      snippet: clampString(topCandidates.join(' '), 140),
      score: ranked[0]?.overlapCount ?? 0,
    };
  }

  const fallbackSnippet =
    input.baselineName.startsWith('ledgermind_')
      ? toLedgermindFallbackSnippet(input.context)
      : input.context
          .split(/[\n.]/)
          .map((part) => part.trim())
          .find((part) => part.length > 0);

  return {
    ...(fallbackSnippet === undefined ? {} : { snippet: clampString(fallbackSnippet, 140) }),
    score: 0,
  };
};

const derivePredictionFromContext = (input: {
  readonly baselineName: LocomoBaselineName;
  readonly context: string;
  readonly question: string;
  readonly category: number;
  readonly contextIds: readonly string[];
}): string => {
  if (input.category === 2) {
    const date = extractDateFromContext(input.context);
    if (date !== undefined && date.length > 0) {
      return clampString(date, 140);
    }
  }

  const best = selectBestQuestionAnchoredSnippet({
    context: input.context,
    question: input.question,
    baselineName: input.baselineName,
  });

  if (input.category === 5) {
    if (best.score < 2) {
      return 'Not mentioned in the conversation';
    }

    return best.snippet ?? 'Not mentioned in the conversation';
  }

  if (best.snippet !== undefined) {
    return best.snippet;
  }

  if (input.contextIds.length > 0) {
    return `See evidence around ${input.contextIds[0]}.`;
  }

  return 'No information available';
};

const selectRetryEvidenceSnippets = (input: {
  readonly context: string;
  readonly question: string;
  readonly category: number;
  readonly baselineName: LocomoBaselineName;
}): readonly string[] => {
  const candidates = splitContextCandidates(input.context);
  const questionTokens = tokenizeOverlapTerms(input.question);

  const ranked = candidates
    .map((candidate, index) => {
      const scored = scoreLineAgainstQuestionTokens(candidate, questionTokens);
      return {
        candidate,
        index,
        overlapCount: scored.overlapCount,
        overlapDensity: scored.overlapDensity,
        hasDate: extractDateFromContext(candidate) !== undefined,
      };
    })
    .filter((candidate) => candidate.overlapCount > 0)
    .sort((left, right) => {
      if (input.category === 2 && right.hasDate !== left.hasDate) {
        return right.hasDate ? 1 : -1;
      }

      if (right.overlapDensity !== left.overlapDensity) {
        return right.overlapDensity - left.overlapDensity;
      }

      if (right.overlapCount !== left.overlapCount) {
        return right.overlapCount - left.overlapCount;
      }

      return left.index - right.index;
    });

  const topSnippets = [...new Set(ranked.slice(0, input.category === 2 ? 3 : 2).map((entry) => entry.candidate))];
  if (topSnippets.length > 0) {
    return topSnippets;
  }

  if (input.category === 2) {
    const date = extractDateFromContext(input.context);
    if (date !== undefined && date.length > 0) {
      return [clampString(date, 140)];
    }
  }

  const fallbackSnippet = selectBestQuestionAnchoredSnippet({
    context: input.context,
    question: input.question,
    baselineName: input.baselineName,
  }).snippet;

  return fallbackSnippet === undefined ? [] : [fallbackSnippet];
};

const buildAbstentionRetryInput = (input: {
  readonly fairness: FairnessConfig;
  readonly question: string;
  readonly category: number;
  readonly context: string;
  readonly baselineName: LocomoBaselineName;
}): {
  readonly retryPrompt: string;
  readonly retryContext: string;
} => {
  const evidenceLines = selectRetryEvidenceSnippets({
    context: input.context,
    question: input.question,
    category: input.category,
    baselineName: input.baselineName,
  });

  if (evidenceLines.length === 0) {
    return {
      retryPrompt: qaPromptCategoryAware({
        fairness: input.fairness,
        question: input.question,
        category: input.category,
      }),
      retryContext: '',
    };
  }

  const retryPrompt =
    input.category === 2
      ? `${input.fairness.promptTemplate}\nQuestion: ${input.question}\nEvidence snippets:\n- ${evidenceLines.join('\n- ')}\nUse only the snippets. Prefer an approximate date from DATE fields when possible. Output only a short phrase.\nShort answer:`
      : `${input.fairness.promptTemplate}\nQuestion: ${input.question}\nEvidence snippets:\n- ${evidenceLines.join('\n- ')}\nUse only the snippets. Provide the best-supported short answer. Only answer "No information available" if none of the snippets support an answer.\nShort answer:`;

  return {
    retryPrompt,
    retryContext: evidenceLines.join('\n'),
  };
};

const finalizeExecution = async (input: {
  readonly baselineName: LocomoBaselineName;
  readonly parityMode: 'parity' | 'upper_bound';
  readonly fairness: FairnessConfig;
  readonly predictionMode: 'heuristic' | 'llm';
  readonly seed: number;
  readonly llmBaseUrl: string | undefined;
  readonly llmApiKey: string | undefined;
  readonly llmTimeoutMs: number;
  readonly contextResult: BaselineContextResult;
  readonly question: string;
  readonly category: number;
  readonly diagnostics?: LedgermindDiagnostics;
  readonly runtimeProvenance?: LocomoRuntimeProvenance;
}): Promise<BaselineExecutionResult> => {
  const prompt = qaPromptCategoryAware({
    fairness: input.fairness,
    question: input.question,
    category: input.category,
  });

  const fallbackPrediction = derivePredictionFromContext({
    baselineName: input.baselineName,
    context: input.contextResult.context,
    question: input.question,
    category: input.category,
    contextIds: input.contextResult.contextIds,
  });

  const retryInput = buildAbstentionRetryInput({
    fairness: input.fairness,
    question: input.question,
    category: input.category,
    context: input.contextResult.context,
    baselineName: input.baselineName,
  });

  const generated = await generatePrediction({
    fairness: input.fairness,
    predictionMode: input.predictionMode,
    seed: input.seed,
    systemInstruction: qaSystemInstructionCategoryAware({
      category: input.category,
    }),
    prompt,
    context: input.contextResult.context,
    category: input.category,
    llmBaseUrl: input.llmBaseUrl,
    llmApiKey: input.llmApiKey,
    llmTimeoutMs: input.llmTimeoutMs,
    fallbackPrediction,
    retryOnAbstention: {
      enabled: shouldEnableAbstentionRetry(input.category),
      retryPrompt: retryInput.retryPrompt,
      retryContext: retryInput.retryContext,
    },
  });

  const totalTokens = generated.promptTokens + generated.completionTokens;

  return {
    prediction: generated.prediction,
    contextResult: {
      ...input.contextResult,
      parityMode: input.parityMode,
    },
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
    totalTokens,
    costUsd: 0,
    predictionSource: generated.predictionSource,
    abstentionRetried: generated.abstentionRetried,
    provenance: {
      requestedPredictionMode: input.predictionMode,
      actualPredictionSource: generated.predictionSource,
      ...(input.runtimeProvenance === undefined ? {} : { runtime: input.runtimeProvenance }),
    },
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  };
};

const toErrorCode = (error: unknown): string => {
  if (error instanceof Error) {
    return (error as { readonly code?: string }).code ?? error.name;
  }

  return 'UNKNOWN_ERROR';
};

const toToolLoopTargetId = (id: string): string => {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  if (trimmed.startsWith('sum_') || trimmed.startsWith('file_')) {
    return trimmed;
  }

  return `sum_${trimmed}`;
};

const diagnosticsFromMaterialized = (input: {
  readonly base: Omit<LedgermindDiagnostics, 'contextSource'>;
  readonly artifactBearingExample: boolean;
  readonly materialized: {
    readonly budgetUsed: { readonly value: number };
    readonly summaryReferences: readonly { readonly id: unknown }[];
    readonly artifactReferences: readonly { readonly id: unknown }[];
    readonly modelMessages: readonly { readonly role: unknown; readonly content: unknown }[];
    readonly retrievalMatchCount?: number;
    readonly retrievalAddedCount?: number;
    readonly retrievalDiagnostics?: readonly {
      readonly hintQuery: string;
      readonly scopeSummaryId?: unknown;
      readonly limit: number;
      readonly stageQueries: readonly {
        readonly stage: 'primary' | 'keywords' | 'anchors';
        readonly query: string;
        readonly matchCount: number;
      }[];
      readonly candidateDecisions: readonly {
        readonly summaryId: unknown;
        readonly score: number;
        readonly stageHits: number;
        readonly overlapCount: number;
        readonly tokenCount: number;
        readonly selected: boolean;
        readonly reason: 'selected' | 'already_in_context' | 'over_budget' | 'limit_reached';
      }[];
      readonly selectedSummaryIds: readonly unknown[];
    }[];
    readonly compactionTriggered?: boolean;
    readonly trimmedToFit?: boolean;
    readonly droppedMessageCount?: number;
    readonly droppedSummaryCount?: number;
  };
  readonly withHintsError?: unknown;
  readonly retrievalHintCount?: number;
}): LedgermindDiagnostics => {
  return {
    ...input.base,
    contextSource: 'materialized',
    ...(input.withHintsError === undefined
      ? {}
      : {
          materializationErrorStage: 'with_hints',
          materializationErrorCode: toErrorCode(input.withHintsError),
        }),
    budgetUsedTokens: input.materialized.budgetUsed.value,
    summaryReferenceCount: input.materialized.summaryReferences.length,
    summaryReferenceIds: input.materialized.summaryReferences.map((reference) => String(reference.id)),
    artifactReferenceCount: input.materialized.artifactReferences.length,
    artifactReferenceIds: input.materialized.artifactReferences.map((reference) => String(reference.id)),
    artifactBearingExample: input.artifactBearingExample,
    modelMessageCount: input.materialized.modelMessages.length,
    ...(input.retrievalHintCount === undefined ? {} : { retrievalHintCount: input.retrievalHintCount }),
    ...(input.materialized.retrievalMatchCount === undefined
      ? {}
      : { retrievalMatchCount: input.materialized.retrievalMatchCount }),
    ...(input.materialized.retrievalAddedCount === undefined
      ? {}
      : { retrievalAddedCount: input.materialized.retrievalAddedCount }),
    ...(input.materialized.retrievalDiagnostics === undefined
      ? {}
      : {
          retrievalHints: input.materialized.retrievalDiagnostics.map((hint) => ({
            hintQuery: hint.hintQuery,
            ...(hint.scopeSummaryId === undefined ? {} : { scopeSummaryId: String(hint.scopeSummaryId) }),
            limit: hint.limit,
            stageQueries: hint.stageQueries.map((stageQuery) => ({
              stage: stageQuery.stage,
              query: stageQuery.query,
              matchCount: stageQuery.matchCount,
            })),
            candidateDecisions: hint.candidateDecisions.map((candidate) => ({
              summaryId: String(candidate.summaryId),
              score: candidate.score,
              stageHits: candidate.stageHits,
              overlapCount: candidate.overlapCount,
              tokenCount: candidate.tokenCount,
              selected: candidate.selected,
              reason: candidate.reason,
            })),
            selectedSummaryIds: hint.selectedSummaryIds.map((summaryId) => String(summaryId)),
          })),
        }),
    ...(input.materialized.compactionTriggered === undefined
      ? {}
      : { compactionTriggered: input.materialized.compactionTriggered }),
    ...(input.materialized.trimmedToFit === undefined ? {} : { trimmedToFit: input.materialized.trimmedToFit }),
    ...(input.materialized.droppedMessageCount === undefined
      ? {}
      : { droppedMessageCount: input.materialized.droppedMessageCount }),
    ...(input.materialized.droppedSummaryCount === undefined
      ? {}
      : { droppedSummaryCount: input.materialized.droppedSummaryCount }),
  };
};

const extractEvidenceIdsFromStrings = (values: readonly string[]): readonly string[] => {
  const ids = values.flatMap((value) => {
    return [...value.matchAll(/D\d+:\d+/gi)]
      .map((match) => match[0]?.trim().toUpperCase())
      .filter((id): id is string => id !== undefined && id.length > 0);
  });

  return Object.freeze([...new Set(ids)]);
};

const extractEvidenceIdsFromContext = (context: string): readonly string[] => {
  return extractEvidenceIdsFromStrings([context]);
};

const collectCandidateSummaryIds = (ids: readonly string[]): readonly string[] => {
  return Object.freeze(
    [...new Set(ids)]
      .map((id) => toToolLoopTargetId(id))
      .filter((id) => id.startsWith('sum_'))
      .sort((left, right) => left.localeCompare(right)),
  );
};

const collectCandidateArtifactIds = (ids: readonly string[]): readonly string[] => {
  return Object.freeze(
    [...new Set(ids)]
      .map((id) => id.trim())
      .filter((id) => id.startsWith('file_'))
      .sort((left, right) => left.localeCompare(right)),
  );
};

const extractArtifactIdsFromContext = (context: string): readonly string[] => {
  const ids = [...context.matchAll(/\bfile_[a-zA-Z0-9_-]+\b/g)]
    .map((match) => match[0]?.trim())
    .filter((id): id is string => id !== undefined && id.length > 0);

  return Object.freeze([...new Set(ids)].sort((left, right) => left.localeCompare(right)));
};

const toArtifactToolMessage = (input: {
  readonly artifactId: string;
  readonly summary: string;
  readonly explorerUsed: string;
}): string => {
  const compactSummary = input.summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ');

  return `tool: [artifact:${input.artifactId}] explorer=${input.explorerUsed} summary=${clampString(compactSummary, 400)}`;
};

interface NormalizedDescribeSignal {
  readonly id: string;
  readonly kind: 'summary' | 'artifact';
  readonly entities: readonly string[];
  readonly dates: readonly string[];
  readonly commitments: readonly string[];
  readonly outcomes: readonly string[];
  readonly lexicalAnchors: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly hasExplorationSummary?: boolean;
  readonly originalPath?: string;
  readonly explorerUsed?: string;
}

interface RankedSummarySelection {
  readonly targetId: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

interface RankedArtifactSelection {
  readonly artifactId: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

interface RankedGrepSelection {
  readonly query: string;
  readonly scope?: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

const toNormalizedStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const values = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);

  return Object.freeze([...new Set(values)]);
};

const isSummaryPlanningSignals = (value: unknown): value is DescribeSummaryPlanningSignals => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record['entities']) &&
    Array.isArray(record['dates']) &&
    Array.isArray(record['commitments']) &&
    Array.isArray(record['outcomes']) &&
    Array.isArray(record['lexicalAnchors']) &&
    Array.isArray(record['evidenceIds'])
  );
};

const isArtifactPlanningSignals = (value: unknown): value is DescribeArtifactPlanningSignals => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record['hasExplorationSummary'] === 'boolean' &&
    Array.isArray(record['lexicalAnchors']) &&
    Array.isArray(record['evidenceIds'])
  );
};

const toNormalizedDescribeSignal = (id: string, output: DescribeOutput): NormalizedDescribeSignal => {
  const fallbackEvidenceIds = extractEvidenceIdsFromStrings([String(output.metadata['content'] ?? '')]);

  if (output.kind === 'summary' && isSummaryPlanningSignals(output.planningSignals)) {
    return {
      id,
      kind: 'summary',
      entities: toNormalizedStringArray(output.planningSignals.entities),
      dates: toNormalizedStringArray(output.planningSignals.dates),
      commitments: toNormalizedStringArray(output.planningSignals.commitments),
      outcomes: toNormalizedStringArray(output.planningSignals.outcomes),
      lexicalAnchors: toNormalizedStringArray(output.planningSignals.lexicalAnchors),
      evidenceIds: toNormalizedStringArray(output.planningSignals.evidenceIds),
    };
  }

  if (output.kind === 'artifact' && isArtifactPlanningSignals(output.planningSignals)) {
    return {
      id,
      kind: 'artifact',
      entities: [],
      dates: [],
      commitments: [],
      outcomes: [],
      lexicalAnchors: toNormalizedStringArray(output.planningSignals.lexicalAnchors),
      evidenceIds: toNormalizedStringArray(output.planningSignals.evidenceIds),
      hasExplorationSummary: output.planningSignals.hasExplorationSummary,
      ...(output.planningSignals.originalPath === undefined
        ? {}
        : { originalPath: output.planningSignals.originalPath }),
      ...(output.planningSignals.explorerUsed === undefined
        ? {}
        : { explorerUsed: output.planningSignals.explorerUsed }),
    };
  }

  if (output.kind === 'artifact') {
    return {
      id,
      kind: 'artifact',
      entities: [],
      dates: [],
      commitments: [],
      outcomes: [],
      lexicalAnchors: [],
      evidenceIds: fallbackEvidenceIds,
      hasExplorationSummary: output.explorationSummary !== undefined,
      ...(typeof output.metadata['originalPath'] === 'string' && output.metadata['originalPath'].trim().length > 0
        ? { originalPath: output.metadata['originalPath'].trim() }
        : {}),
      ...(typeof output.metadata['explorerUsed'] === 'string' && output.metadata['explorerUsed'].trim().length > 0
        ? { explorerUsed: output.metadata['explorerUsed'].trim() }
        : {}),
    };
  }

  return {
    id,
    kind: 'summary',
    entities: [],
    dates: [],
    commitments: [],
    outcomes: [],
    lexicalAnchors: [],
    evidenceIds: fallbackEvidenceIds,
  };
};

const scoreSummarySelection = (input: {
  readonly summaryId: string;
  readonly signal: NormalizedDescribeSignal | undefined;
  readonly questionTokens: readonly string[];
}): RankedSummarySelection => {
  const reasons: string[] = [];
  let score = 0;

  if (input.signal !== undefined) {
    const combined = [
      ...input.signal.entities,
      ...input.signal.dates,
      ...input.signal.commitments,
      ...input.signal.outcomes,
      ...input.signal.lexicalAnchors,
      ...input.signal.evidenceIds,
    ];

    const normalizedQuestion = input.questionTokens;
    let overlapCount = 0;
    for (const value of combined) {
      const normalized = value.toLowerCase();
      if (normalizedQuestion.some((token) => normalized.includes(token))) {
        overlapCount += 1;
      }
    }

    if (overlapCount > 0) {
      score += overlapCount * 3;
      reasons.push(`signal_overlap:${overlapCount}`);
    }

    if (input.signal.evidenceIds.length > 0) {
      score += input.signal.evidenceIds.length * 5;
      reasons.push(`signal_evidence:${input.signal.evidenceIds.length}`);
    }

    if (input.signal.lexicalAnchors.length > 0) {
      score += input.signal.lexicalAnchors.length * 2;
      reasons.push(`signal_anchors:${input.signal.lexicalAnchors.length}`);
    }
  }

  if (input.summaryId.includes('leaf')) {
    score += 1;
    reasons.push('leaf_bias');
  }

  return {
    targetId: input.summaryId,
    score,
    reasons: Object.freeze(reasons.length > 0 ? reasons : ['default_order']),
  };
};

const scoreArtifactSelection = (input: {
  readonly artifactId: string;
  readonly signal: NormalizedDescribeSignal | undefined;
  readonly questionTokens: readonly string[];
}): RankedArtifactSelection => {
  const reasons: string[] = [];
  let score = 0;

  if (input.signal !== undefined) {
    if (input.signal.hasExplorationSummary === true) {
      score += 4;
      reasons.push('has_exploration_summary');
    }

    if (input.signal.lexicalAnchors.length > 0) {
      score += input.signal.lexicalAnchors.length * 2;
      reasons.push(`signal_anchors:${input.signal.lexicalAnchors.length}`);
    }

    const overlapSource = [...input.signal.lexicalAnchors, ...(input.signal.originalPath === undefined ? [] : [input.signal.originalPath])];
    let overlapCount = 0;
    for (const value of overlapSource) {
      const normalized = value.toLowerCase();
      if (input.questionTokens.some((token) => normalized.includes(token))) {
        overlapCount += 1;
      }
    }

    if (overlapCount > 0) {
      score += overlapCount * 3;
      reasons.push(`signal_overlap:${overlapCount}`);
    }
  }

  return {
    artifactId: input.artifactId,
    score,
    reasons: Object.freeze(reasons.length > 0 ? reasons : ['default_order']),
  };
};

const scoreGrepSelection = (input: {
  readonly query: string;
  readonly scope?: string;
  readonly scopeSignal: NormalizedDescribeSignal | undefined;
  readonly questionTokens: readonly string[];
}): RankedGrepSelection => {
  const reasons: string[] = [];
  let score = 0;

  if (input.scope === undefined) {
    score += 1;
    reasons.push('global_scope');
  }

  if (input.scopeSignal !== undefined) {
    if (input.scopeSignal.evidenceIds.length > 0) {
      score += input.scopeSignal.evidenceIds.length * 4;
      reasons.push(`scope_evidence:${input.scopeSignal.evidenceIds.length}`);
    }

    const scopeTerms = [...input.scopeSignal.lexicalAnchors, ...input.scopeSignal.entities, ...input.scopeSignal.dates];
    let overlapCount = 0;
    for (const value of scopeTerms) {
      const normalized = value.toLowerCase();
      if (input.questionTokens.some((token) => normalized.includes(token))) {
        overlapCount += 1;
      }
    }

    if (overlapCount > 0) {
      score += overlapCount * 2;
      reasons.push(`scope_overlap:${overlapCount}`);
    }
  }

  return {
    query: input.query,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    score,
    reasons: Object.freeze(reasons.length > 0 ? reasons : ['default_order']),
  };
};

interface ToolLoopBuildResult {
  readonly contextResult: BaselineContextResult;
  readonly diagnostics: LedgermindToolLoopDiagnostics;
}

const runLedgermindToolLoop = async (input: {
  readonly runtime: LedgermindRuntime;
  readonly question: string;
  readonly baseContextResult: BaselineContextResult;
  readonly maxSteps: number;
  readonly maxDescribeCalls: number;
  readonly maxExploreArtifactCalls: number;
  readonly maxExpandCalls: number;
  readonly maxGrepCalls: number;
  readonly maxAddedTokens: number;
}): Promise<ToolLoopBuildResult> => {
  const preToolContextIds = [...new Set(input.baseContextResult.contextIds.map((id) => id.trim()))];
  const preToolEvidenceIds = extractEvidenceIdsFromContext(input.baseContextResult.context);
  const addedMessages: { readonly id: string; readonly text: string; readonly tokenEstimate: number }[] = [];
  const addedMessageIds = new Set<string>();

  const describedIds: string[] = [];
  const exploredArtifactIds: string[] = [];
  const expandedSummaryIds: string[] = [];
  const grepQueries: string[] = [];
  const describeSignals: NormalizedDescribeSignal[] = [];
  const expandSelection: RankedSummarySelection[] = [];
  const artifactSelection: RankedArtifactSelection[] = [];
  const grepSelection: RankedGrepSelection[] = [];
  const describedSignalById = new Map<string, NormalizedDescribeSignal>();
  const steps: LedgermindToolStepTrace[] = [];

  const normalizedQuestion = input.question.trim();
  const questionPattern = normalizedQuestion.length === 0 ? '.*' : normalizedQuestion;

  let step = 0;
  let describeCalls = 0;
  let exploreArtifactCalls = 0;
  let expandCalls = 0;
  let grepCalls = 0;
  let addedTokens = 0;

  const appendStep = (entry: Omit<LedgermindToolStepTrace, 'step'>): void => {
    step += 1;
    steps.push({
      step,
      ...entry,
    });
  };

  const summaryDescribeTargets = collectCandidateSummaryIds(preToolContextIds);
  const artifactExploreTargets = collectCandidateArtifactIds([
    ...preToolContextIds,
    ...extractArtifactIdsFromContext(input.baseContextResult.context),
  ]);
  const describeTargets = [...summaryDescribeTargets, ...artifactExploreTargets];

  for (const targetId of describeTargets) {
    if (step >= input.maxSteps || describeCalls >= input.maxDescribeCalls) {
      break;
    }

    try {
      const described = await input.runtime.engine.describe({ id: targetId as never });
      const normalizedSignal = toNormalizedDescribeSignal(targetId, described);
      describedSignalById.set(targetId, normalizedSignal);
      describeSignals.push(normalizedSignal);
      describedIds.push(targetId);
      describeCalls += 1;
      appendStep({
        tool: 'describe',
        status: 'ok',
        targetId,
      });
    } catch (error) {
      describeCalls += 1;
      appendStep({
        tool: 'describe',
        status: 'error',
        targetId,
        note: toErrorCode(error),
      });
    }
  }

  const questionTokens = tokenizeOverlapTerms(input.question);

  const rankedArtifactTargets = [...artifactExploreTargets]
    .map((artifactId) =>
      scoreArtifactSelection({
        artifactId,
        signal: describedSignalById.get(artifactId),
        questionTokens,
      }),
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.artifactId.localeCompare(right.artifactId);
    });

  artifactSelection.push(...rankedArtifactTargets);

  for (const selection of rankedArtifactTargets) {
    const artifactId = selection.artifactId;
    if (
      step >= input.maxSteps ||
      exploreArtifactCalls >= input.maxExploreArtifactCalls ||
      addedTokens >= input.maxAddedTokens
    ) {
      break;
    }

    try {
      const explored = await input.runtime.engine.exploreArtifact({
        artifactId: artifactId as never,
      });

      const text = toArtifactToolMessage({
        artifactId,
        summary: explored.summary,
        explorerUsed: explored.explorerUsed,
      });
      const tokenEstimate = estimateTokens(text);
      const canAdd = addedTokens + tokenEstimate <= input.maxAddedTokens;

      exploreArtifactCalls += 1;
      exploredArtifactIds.push(artifactId);
      if (canAdd) {
        const syntheticId = `artifact:${artifactId}`;
        if (!addedMessageIds.has(syntheticId)) {
          addedMessageIds.add(syntheticId);
          addedMessages.push({
            id: syntheticId,
            text,
            tokenEstimate,
          });
          addedTokens += tokenEstimate;
        }
      }

      appendStep({
        tool: 'explore_artifact',
        status: 'ok',
        targetId: artifactId,
        addedCount: canAdd ? 1 : 0,
        addedTokens: canAdd ? tokenEstimate : 0,
      });
    } catch (error) {
      exploreArtifactCalls += 1;
      appendStep({
        tool: 'explore_artifact',
        status: 'error',
        targetId: artifactId,
        note: toErrorCode(error),
      });
    }
  }

  const rankedExpandTargets = [...collectCandidateSummaryIds(preToolContextIds)]
    .map((summaryId) =>
      scoreSummarySelection({
        summaryId,
        signal: describedSignalById.get(summaryId),
        questionTokens,
      }),
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.targetId.localeCompare(right.targetId);
    });

  expandSelection.push(...rankedExpandTargets);

  for (const selection of rankedExpandTargets) {
    const summaryId = selection.targetId;
    if (step >= input.maxSteps || expandCalls >= input.maxExpandCalls) {
      break;
    }

    try {
      const expanded = await input.runtime.engine.expand({
        summaryId: summaryId as never,
        callerContext: {
          conversationId: input.runtime.conversationId,
          isSubAgent: true,
        },
      });

      const unseenMessages = expanded.messages.filter((message) => {
        const messageId = String(message.id).trim();
        return !addedMessageIds.has(messageId);
      });

      let addedCount = 0;
      let addedTokenCount = 0;
      for (const message of unseenMessages) {
        const text = `${message.role}: ${message.content}`;
        const tokenEstimate = estimateTokens(text);
        if (addedTokens + tokenEstimate > input.maxAddedTokens) {
          break;
        }

        const messageId = String(message.id).trim();
        addedMessageIds.add(messageId);
        addedMessages.push({
          id: messageId,
          text,
          tokenEstimate,
        });
        addedCount += 1;
        addedTokens += tokenEstimate;
        addedTokenCount += tokenEstimate;
      }

      expandCalls += 1;
      expandedSummaryIds.push(summaryId);
      appendStep({
        tool: 'expand',
        status: 'ok',
        targetId: summaryId,
        addedCount,
        addedTokens: addedTokenCount,
      });
    } catch (error) {
      expandCalls += 1;
      appendStep({
        tool: 'expand',
        status: 'error',
        targetId: summaryId,
        note: toErrorCode(error),
      });
    }
  }

  const grepScopes = collectCandidateSummaryIds(preToolContextIds);
  const rankedGrepSearches = (grepScopes.length === 0
    ? [scoreGrepSelection({ query: questionPattern, scopeSignal: undefined, questionTokens })]
    : [
        scoreGrepSelection({ query: questionPattern, scopeSignal: undefined, questionTokens }),
        ...grepScopes.map((scope) =>
          scoreGrepSelection({
            query: questionPattern,
            scope,
            scopeSignal: describedSignalById.get(scope),
            questionTokens,
          }),
        ),
      ]).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    if ((left.scope ?? '') !== (right.scope ?? '')) {
      return (left.scope ?? '').localeCompare(right.scope ?? '');
    }

    return left.query.localeCompare(right.query);
  });

  grepSelection.push(...rankedGrepSearches);

  for (const search of rankedGrepSearches) {
    if (step >= input.maxSteps || grepCalls >= input.maxGrepCalls || addedTokens >= input.maxAddedTokens) {
      break;
    }

    try {
      const grepOutput = await input.runtime.engine.grep({
        conversationId: input.runtime.conversationId,
        pattern: search.query,
        ...(search.scope === undefined ? {} : { scope: search.scope as never }),
      });

      let addedCount = 0;
      let addedTokenCount = 0;
      for (const match of grepOutput.matches) {
        if (addedTokens >= input.maxAddedTokens) {
          break;
        }

        const eventId = String(match.eventId).trim();
        if (addedMessageIds.has(eventId)) {
          continue;
        }

        const text = `tool: [grep] ${match.excerpt}`;
        const tokenEstimate = estimateTokens(text);
        if (addedTokens + tokenEstimate > input.maxAddedTokens) {
          break;
        }

        addedMessageIds.add(eventId);
        addedMessages.push({
          id: eventId,
          text,
          tokenEstimate,
        });
        addedCount += 1;
        addedTokens += tokenEstimate;
        addedTokenCount += tokenEstimate;
      }

      grepCalls += 1;
      grepQueries.push(search.scope === undefined ? search.query : `${search.query}::${search.scope}`);
      appendStep({
        tool: 'grep',
        status: 'ok',
        query: search.scope === undefined ? search.query : `${search.query} [scope=${search.scope}]`,
        matchCount: grepOutput.matches.length,
        addedCount,
        addedTokens: addedTokenCount,
      });
    } catch (error) {
      grepCalls += 1;
      appendStep({
        tool: 'grep',
        status: 'error',
        query: search.scope === undefined ? search.query : `${search.query} [scope=${search.scope}]`,
        note: toErrorCode(error),
      });
    }
  }

  const extraContext = addedMessages.map((message) => message.text).join('\n');
  const context = extraContext.length === 0 ? input.baseContextResult.context : `${extraContext}\n${input.baseContextResult.context}`;
  const contextIds = [...addedMessages.map((message) => message.id), ...preToolContextIds];
  const contextResult: BaselineContextResult = {
    context,
    contextIds,
    contextTokenEstimate: estimateTokens(context),
    parityMode: input.baseContextResult.parityMode,
  };

  const postToolEvidenceIds = extractEvidenceIdsFromContext(contextResult.context);

  return {
    contextResult,
    diagnostics: {
      enabled: true,
      maxSteps: input.maxSteps,
      maxDescribeCalls: input.maxDescribeCalls,
      maxExploreArtifactCalls: input.maxExploreArtifactCalls,
      maxExpandCalls: input.maxExpandCalls,
      maxGrepCalls: input.maxGrepCalls,
      maxAddedTokens: input.maxAddedTokens,
      stepsUsed: steps.length,
      describedIds: Object.freeze(describedIds),
      exploredArtifactIds: Object.freeze(exploredArtifactIds),
      expandedSummaryIds: Object.freeze(expandedSummaryIds),
      grepQueries: Object.freeze(grepQueries),
      addedMessageCount: addedMessages.length,
      addedTokens,
      preToolContextIds: Object.freeze(preToolContextIds),
      preToolEvidenceIds,
      postToolEvidenceIds,
      describeSignals: Object.freeze(
        describeSignals.map((signal) => ({
          id: signal.id,
          kind: signal.kind,
          entities: Object.freeze([...signal.entities]),
          dates: Object.freeze([...signal.dates]),
          commitments: Object.freeze([...signal.commitments]),
          outcomes: Object.freeze([...signal.outcomes]),
          lexicalAnchors: Object.freeze([...signal.lexicalAnchors]),
          evidenceIds: Object.freeze([...signal.evidenceIds]),
          ...(signal.hasExplorationSummary === undefined
            ? {}
            : { hasExplorationSummary: signal.hasExplorationSummary }),
          ...(signal.originalPath === undefined ? {} : { originalPath: signal.originalPath }),
          ...(signal.explorerUsed === undefined ? {} : { explorerUsed: signal.explorerUsed }),
        })),
      ),
      expandSelection: Object.freeze(
        expandSelection.map((entry) => ({
          targetId: entry.targetId,
          score: entry.score,
          reasons: Object.freeze([...entry.reasons]),
        })),
      ),
      artifactSelection: Object.freeze(
        artifactSelection.map((entry) => ({
          targetId: entry.artifactId,
          score: entry.score,
          reasons: Object.freeze([...entry.reasons]),
        })),
      ),
      grepSelection: Object.freeze(
        grepSelection.map((entry) => ({
          query: entry.query,
          ...(entry.scope === undefined ? {} : { scope: entry.scope }),
          score: entry.score,
          reasons: Object.freeze([...entry.reasons]),
        })),
      ),
      steps: Object.freeze(steps),
    },
  };
};

const injectRawTurnsIntoContext = (input: {
  readonly context: string;
  readonly contextIds: readonly string[];
  readonly contextTokenEstimate: number;
  readonly question: string;
  readonly tokenBudget: number;
  readonly runtimeContextLines: readonly { readonly id: string; readonly text: string; readonly tokenEstimate: number }[];
  readonly topK: number;
  readonly injectionMaxTokens: number;
}): {
  readonly contextResult: BaselineContextResult;
  readonly candidateCount: number;
  readonly addedCount: number;
  readonly budgetTokens: number;
} => {
  const questionTokens = tokenizeOverlapTerms(input.question);
  const ranked = [...input.runtimeContextLines]
    .map((line) => {
      const scored = scoreLineAgainstQuestionTokens(line.text, questionTokens);
      return {
        ...line,
        overlapCount: scored.overlapCount,
        overlapDensity: scored.overlapDensity,
      };
    })
    .filter((line) => line.overlapCount > 0)
    .sort((left, right) => {
      if (right.overlapDensity !== left.overlapDensity) {
        return right.overlapDensity - left.overlapDensity;
      }

      if (right.overlapCount !== left.overlapCount) {
        return right.overlapCount - left.overlapCount;
      }

      return left.id.localeCompare(right.id);
    });

  const candidateCount = ranked.length;
  const cappedBudget = Math.max(0, Math.min(input.injectionMaxTokens, input.tokenBudget));

  const selected: { id: string; text: string; tokenEstimate: number }[] = [];
  let used = 0;
  for (const line of ranked.slice(0, input.topK)) {
    if (input.context.includes(line.text)) {
      continue;
    }

    if (used + line.tokenEstimate > cappedBudget) {
      continue;
    }

    selected.push({ id: line.id, text: line.text, tokenEstimate: line.tokenEstimate });
    used += line.tokenEstimate;
  }

  if (selected.length === 0) {
    return {
      contextResult: {
        context: input.context,
        contextIds: input.contextIds,
        contextTokenEstimate: input.contextTokenEstimate,
        parityMode: 'parity',
      },
      candidateCount,
      addedCount: 0,
      budgetTokens: cappedBudget,
    };
  }

  const rawSection = selected.map((line) => line.text).join('\n');

  const rawSectionTokens = estimateTokens(rawSection);
  const remainingBudget = Math.max(0, input.tokenBudget - rawSectionTokens);

  const contextLines = input.context
    .split('\n')
    .map((line, index) => ({
      id: `ctx:${index}`,
      text: line,
      tokenEstimate: estimateTokens(line),
    }))
    .filter((line) => line.text.trim().length > 0);

  const baseWithinBudget = toContextWithinBudget({
    lines: contextLines,
    tokenBudget: remainingBudget,
    includeFromEnd: false,
  });

  const combinedContext = `${rawSection}\n${baseWithinBudget.context}`.trim();
  const combinedIds = [...selected.map((line) => line.id), ...input.contextIds];

  return {
    contextResult: {
      context: combinedContext,
      contextIds: combinedIds,
      contextTokenEstimate: estimateTokens(combinedContext),
      parityMode: 'parity',
    },
    candidateCount,
    addedCount: selected.length,
    budgetTokens: cappedBudget,
  };
};

const createTruncationBaseline = (config: LocomoBenchmarkConfig): BaselineStrategy => {
  return {
    name: 'truncation',
    parityMode: 'parity',
    async run(input: BaselineExecutionInput): Promise<BaselineExecutionResult> {
      const lines = buildContextLines(input.sample);
      const contextBudget = Math.max(1, input.fairness.tokenBudget - input.fairness.overheadTokens);

      const contextResult = toContextWithinBudget({
        lines,
        tokenBudget: contextBudget,
        includeFromEnd: true,
      });

      return finalizeExecution({
        baselineName: 'truncation',
        parityMode: 'parity',
        fairness: input.fairness,
        predictionMode: config.predictionMode,
        seed: input.seed,
        llmBaseUrl: config.llmBaseUrl,
        llmApiKey: config.llmApiKey,
        llmTimeoutMs: config.llmTimeoutMs,
        contextResult,
        question: input.example.question,
        category: input.example.category,
      });
    },
  };
};

const createRagBaseline = (config: LocomoBenchmarkConfig): BaselineStrategy => {
  return {
    name: 'rag',
    parityMode: 'parity',
    async run(input: BaselineExecutionInput): Promise<BaselineExecutionResult> {
      const lines = buildContextLines(input.sample);
      const ranked = [...lines]
        .map((line) => ({
          ...line,
          score: scoreLineForQuestion(line.text, input.example.question),
        }))
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }

          return left.id.localeCompare(right.id);
        });

      const contextBudget = Math.max(1, input.fairness.tokenBudget - input.fairness.overheadTokens);
      const selected = toContextWithinBudget({
        lines: ranked.slice(0, Math.max(1, config.ragTopK)),
        tokenBudget: contextBudget,
        includeFromEnd: false,
      });

      const execution = await finalizeExecution({
        baselineName: 'rag',
        parityMode: 'parity',
        fairness: input.fairness,
        predictionMode: config.predictionMode,
        seed: input.seed,
        llmBaseUrl: config.llmBaseUrl,
        llmApiKey: config.llmApiKey,
        llmTimeoutMs: config.llmTimeoutMs,
        contextResult: selected,
        question: input.example.question,
        category: input.example.category,
      });

      return {
        ...execution,
        retrievalQuery: input.example.question,
      };
    },
  };
};

const buildOracleEvidenceContext = (input: {
  readonly sample: BaselineExecutionInput['sample'];
  readonly example: BaselineExecutionInput['example'];
  readonly tokenBudget: number;
}): BaselineContextResult => {
  const allLines = buildContextLines(input.sample);
  const byId = new Map(allLines.map((line) => [line.id, line] as const));

  const evidenceIds = Object.freeze(
    [...new Set(input.example.evidence.flatMap((value) => value.split(/[;\s]+/)).map((value) => value.trim()))].filter(
      (value) => /^D\d+:\d+$/i.test(value),
    ),
  );

  const evidenceLines = evidenceIds
    .map((id) => byId.get(id))
    .filter((line): line is { readonly id: string; readonly text: string; readonly tokenEstimate: number } =>
      line !== undefined,
    );

  const remainingEvidenceIds = new Set(evidenceLines.map((line) => line.id));
  const remainderLines = allLines.filter((line) => !remainingEvidenceIds.has(line.id));

  const ordered = [...evidenceLines, ...remainderLines];

  return toContextWithinBudget({
    lines: ordered,
    tokenBudget: input.tokenBudget,
    includeFromEnd: false,
  });
};

const createOracleEvidenceBaseline = (config: LocomoBenchmarkConfig): BaselineStrategy => {
  return {
    name: 'oracle_evidence',
    parityMode: 'parity',
    async run(input: BaselineExecutionInput): Promise<BaselineExecutionResult> {
      assertOracleLlmMode({
        baselineName: 'oracle_evidence',
        predictionMode: config.predictionMode,
      });

      const contextBudget = Math.max(1, input.fairness.tokenBudget - input.fairness.overheadTokens);
      const contextResult = buildOracleEvidenceContext({
        sample: input.sample,
        example: input.example,
        tokenBudget: contextBudget,
      });

      return finalizeExecution({
        baselineName: 'oracle_evidence',
        parityMode: 'parity',
        fairness: input.fairness,
        predictionMode: config.predictionMode,
        seed: input.seed,
        llmBaseUrl: config.llmBaseUrl,
        llmApiKey: config.llmApiKey,
        llmTimeoutMs: config.llmTimeoutMs,
        contextResult,
        question: input.example.question,
        category: input.example.category,
      });
    },
  };
};

const createOracleFullConversationLlmBaseline = (config: LocomoBenchmarkConfig): BaselineStrategy => {
  return {
    name: 'oracle_full_conversation_llm',
    parityMode: 'upper_bound',
    async run(input: BaselineExecutionInput): Promise<BaselineExecutionResult> {
      assertOracleLlmMode({
        baselineName: 'oracle_full_conversation_llm',
        predictionMode: config.predictionMode,
      });

      const lines = buildContextLines(input.sample);
      const context = lines.map((line) => line.text).join('\n');
      const tokenEstimate = lines.reduce((acc, line) => acc + line.tokenEstimate, 0);

      const contextResult: BaselineContextResult = {
        context,
        contextIds: lines.map((line) => line.id),
        contextTokenEstimate: tokenEstimate,
        parityMode: tokenEstimate <= input.fairness.tokenBudget ? 'parity' : 'upper_bound',
      };

      return finalizeExecution({
        baselineName: 'oracle_full_conversation_llm',
        parityMode: contextResult.parityMode,
        fairness: input.fairness,
        predictionMode: config.predictionMode,
        seed: input.seed,
        llmBaseUrl: config.llmBaseUrl,
        llmApiKey: config.llmApiKey,
        llmTimeoutMs: config.llmTimeoutMs,
        contextResult,
        question: input.example.question,
        category: input.example.category,
      });
    },
  };
};

const createFullContextBaseline = (config: LocomoBenchmarkConfig): BaselineStrategy => {
  return {
    name: 'full_context',
    parityMode: 'upper_bound',
    async run(input: BaselineExecutionInput): Promise<BaselineExecutionResult> {
      const lines = buildContextLines(input.sample);
      const context = lines.map((line) => line.text).join('\n');
      const tokenEstimate = lines.reduce((acc, line) => acc + line.tokenEstimate, 0);

      const contextResult: BaselineContextResult = {
        context,
        contextIds: lines.map((line) => line.id),
        contextTokenEstimate: tokenEstimate,
        parityMode: tokenEstimate <= input.fairness.tokenBudget ? 'parity' : 'upper_bound',
      };

      return finalizeExecution({
        baselineName: 'full_context',
        parityMode: contextResult.parityMode,
        fairness: input.fairness,
        predictionMode: config.predictionMode,
        seed: input.seed,
        llmBaseUrl: config.llmBaseUrl,
        llmApiKey: config.llmApiKey,
        llmTimeoutMs: config.llmTimeoutMs,
        contextResult,
        question: input.example.question,
        category: input.example.category,
      });
    },
  };
};

interface LedgermindBaselineOptions {
  readonly name: LocomoRuntimeLabeledLedgermindBaselineName;
  readonly variant: LedgermindVariant;
  readonly preCompactionEnabled: boolean;
  readonly rawTurnInjectionEnabled: boolean;
  readonly runtimeMode: LocomoRuntimeMode;
}

const summarizeTraceEntries = (runtime: LedgermindRuntime): readonly LedgermindSummarizationTraceEntry[] => {
  return runtime.flushSummarizationTrace();
};

const createLedgermindBaseline = (
  config: LocomoBenchmarkConfig,
  options: LedgermindBaselineOptions,
): BaselineStrategy => {
  return {
    name: options.name,
    parityMode: 'parity',
    async run(input: BaselineExecutionInput): Promise<BaselineExecutionResult> {
      const runtime = await createLedgermindRuntime({
        sample: input.sample,
        fairness: input.fairness,
        runtimeMode: options.runtimeMode,
        summarizerType: config.summarizerType,
        llmBaseUrl: config.llmBaseUrl,
        llmApiKey: config.llmApiKey,
        llmTimeoutMs: config.llmTimeoutMs,
        precompact: options.preCompactionEnabled,
        artifactsEnabled: config.artifactsEnabled,
      });

      const contextBudget = Math.max(1, input.fairness.tokenBudget - input.fairness.overheadTokens);
      const artifactBearingExample = extractTurns(input.sample).some((turn) => hasArtifactLikeContent(turn));
      const reservedForToolLoopTokens =
        options.runtimeMode === 'agentic_loop' ? Math.max(32, Math.floor(contextBudget * 0.15)) : 0;
      const materializeBudget = Math.max(1, contextBudget - reservedForToolLoopTokens);
      const reservedForRetrievalTokens = Math.max(
        0,
        materializeBudget > 0 ? Math.min(256, Math.floor(materializeBudget * 0.2)) : 0,
      );

      let baseScopeSummaryId: RetrievalHint['scope'] | undefined;
      if (options.runtimeMode === 'agentic_loop') {
        try {
          const scopeProbe = await runtime.engine.materializeContext({
            conversationId: runtime.conversationId,
            budgetTokens: materializeBudget,
            overheadTokens: input.fairness.overheadTokens,
          });
          baseScopeSummaryId = scopeProbe.summaryReferences[0]?.id;
        } catch {
          baseScopeSummaryId = undefined;
        }
      }

      const applyRawTurnInjectionIfNeeded = (contextResult: BaselineContextResult): {
        readonly contextResult: BaselineContextResult;
        readonly rawTurnInjectionCandidateCount?: number;
        readonly rawTurnInjectionAddedCount?: number;
        readonly rawTurnInjectionBudgetTokens?: number;
      } => {
        if (!options.rawTurnInjectionEnabled) {
          return { contextResult };
        }

        const injected = injectRawTurnsIntoContext({
          context: contextResult.context,
          contextIds: contextResult.contextIds,
          contextTokenEstimate: contextResult.contextTokenEstimate,
          question: input.example.question,
          tokenBudget: contextBudget,
          runtimeContextLines: runtime.contextLines,
          topK: config.ledgermindRawTurnInjectionTopK,
          injectionMaxTokens: config.ledgermindRawTurnInjectionMaxTokens,
        });

        return {
          contextResult: injected.contextResult,
          rawTurnInjectionCandidateCount: injected.candidateCount,
          rawTurnInjectionAddedCount: injected.addedCount,
          rawTurnInjectionBudgetTokens: injected.budgetTokens,
        };
      };

      const applyToolLoopIfNeeded = async (contextResult: BaselineContextResult): Promise<{
        readonly contextResult: BaselineContextResult;
        readonly toolLoop?: LedgermindToolLoopDiagnostics;
      }> => {
        if (options.runtimeMode !== 'agentic_loop') {
          return { contextResult };
        }

        const toolLoop = await runLedgermindToolLoop({
          runtime,
          question: input.example.question,
          baseContextResult: contextResult,
          maxSteps: config.ledgermindToolLoopMaxSteps,
          maxDescribeCalls: config.ledgermindToolLoopMaxDescribeCalls,
          maxExploreArtifactCalls: config.ledgermindToolLoopMaxExploreArtifactCalls,
          maxExpandCalls: config.ledgermindToolLoopMaxExpandCalls,
          maxGrepCalls: config.ledgermindToolLoopMaxGrepCalls,
          maxAddedTokens: config.ledgermindToolLoopMaxAddedTokens,
        });

        return {
          contextResult: toolLoop.contextResult,
          toolLoop: toolLoop.diagnostics,
        };
      };

      try {
        const diagnosticsBase: Omit<LedgermindDiagnostics, 'contextSource'> = {
          materializationAttempted: true,
          availableBudgetTokens: contextBudget,
          reservedForToolLoopTokens,
          reservedForRetrievalTokens,
          retrievalHintCount: 1,
          variant: options.variant,
          preCompactionEnabled: options.preCompactionEnabled,
          rawTurnInjectionEnabled: options.rawTurnInjectionEnabled,
          artifactBearingExample,
        };

        const withSummarizationTrace = (diagnostics: LedgermindDiagnostics): LedgermindDiagnostics => {
          const summarizationTrace = summarizeTraceEntries(runtime);
          if (summarizationTrace.length === 0) {
            return diagnostics;
          }

          return {
            ...diagnostics,
            summarizationTrace,
          };
        };

        try {
          const retrievalHints: RetrievalHint[] = [
            {
              query: input.example.question,
              limit: config.retrievedSummaryLimit,
            },
            ...(baseScopeSummaryId === undefined
              ? []
              : [
                  {
                    query: input.example.question,
                    scope: baseScopeSummaryId as never,
                    limit: config.retrievedSummaryLimit,
                  },
                ]),
          ];

          const materialized = await runtime.engine.materializeContext({
            conversationId: runtime.conversationId,
            budgetTokens: materializeBudget,
            overheadTokens: input.fairness.overheadTokens,
            retrievalHints,
          });

          const context = [
            materialized.systemPreamble,
            ...materialized.modelMessages.map((message) => `${message.role}: ${message.content}`),
          ]
            .filter((line) => line.trim().length > 0)
            .join('\n');

          const contextResult: BaselineContextResult = {
            context,
            contextIds: [
              ...materialized.summaryReferences.map((reference) => String(reference.id)),
              ...materialized.artifactReferences.map((reference) => String(reference.id)),
            ],
            contextTokenEstimate: materialized.budgetUsed.value,
            parityMode: 'parity',
          };

          const rawTurnInjection = applyRawTurnInjectionIfNeeded(contextResult);
          const toolLoop = await applyToolLoopIfNeeded(rawTurnInjection.contextResult);

          return finalizeExecution({
            baselineName: options.name,
            parityMode: 'parity',
            fairness: input.fairness,
            predictionMode: config.predictionMode,
            seed: input.seed,
            llmBaseUrl: config.llmBaseUrl,
            llmApiKey: config.llmApiKey,
            llmTimeoutMs: config.llmTimeoutMs,
            contextResult: toolLoop.contextResult,
            question: input.example.question,
            category: input.example.category,
            diagnostics: withSummarizationTrace(
              diagnosticsFromMaterialized({
                base: {
                  ...diagnosticsBase,
                  ...rawTurnInjection,
                  ...(toolLoop.toolLoop === undefined ? {} : { toolLoop: toolLoop.toolLoop }),
                },
                artifactBearingExample,
                materialized,
                retrievalHintCount: baseScopeSummaryId === undefined ? 1 : 2,
              }),
            ),
            runtimeProvenance: runtime.provenance,
          });
        } catch (errorWithHints) {
          try {
            const materialized = await runtime.engine.materializeContext({
              conversationId: runtime.conversationId,
              budgetTokens: materializeBudget,
              overheadTokens: input.fairness.overheadTokens,
            });

            const context = [
              materialized.systemPreamble,
              ...materialized.modelMessages.map((message) => `${message.role}: ${message.content}`),
            ]
              .filter((line) => line.trim().length > 0)
              .join('\n');

            const contextResult: BaselineContextResult = {
              context,
              contextIds: [
                ...materialized.summaryReferences.map((reference) => String(reference.id)),
                ...materialized.artifactReferences.map((reference) => String(reference.id)),
              ],
              contextTokenEstimate: materialized.budgetUsed.value,
              parityMode: 'parity',
            };

            const rawTurnInjection = applyRawTurnInjectionIfNeeded(contextResult);
            const toolLoop = await applyToolLoopIfNeeded(rawTurnInjection.contextResult);

            return finalizeExecution({
              baselineName: options.name,
              parityMode: 'parity',
              fairness: input.fairness,
              predictionMode: config.predictionMode,
              seed: input.seed,
              llmBaseUrl: config.llmBaseUrl,
              llmApiKey: config.llmApiKey,
              llmTimeoutMs: config.llmTimeoutMs,
              contextResult: toolLoop.contextResult,
              question: input.example.question,
              category: input.example.category,
              diagnostics: withSummarizationTrace(
                diagnosticsFromMaterialized({
                  base: {
                    ...diagnosticsBase,
                    ...rawTurnInjection,
                    ...(toolLoop.toolLoop === undefined ? {} : { toolLoop: toolLoop.toolLoop }),
                  },
                  artifactBearingExample,
                  materialized,
                  withHintsError: errorWithHints,
                  retrievalHintCount: 0,
                }),
              ),
              runtimeProvenance: runtime.provenance,
            });
          } catch (errorWithoutHints) {
            const fallbackContext = toContextWithinBudget({
              lines: buildContextLines(input.sample),
              tokenBudget: contextBudget,
              includeFromEnd: true,
            });

            const rawTurnInjection = applyRawTurnInjectionIfNeeded(fallbackContext);
            const toolLoop = await applyToolLoopIfNeeded(rawTurnInjection.contextResult);

            return finalizeExecution({
              baselineName: options.name,
              parityMode: 'parity',
              fairness: input.fairness,
              predictionMode: config.predictionMode,
              seed: input.seed,
              llmBaseUrl: config.llmBaseUrl,
              llmApiKey: config.llmApiKey,
              llmTimeoutMs: config.llmTimeoutMs,
              contextResult: toolLoop.contextResult,
              question: input.example.question,
              category: input.example.category,
              diagnostics: withSummarizationTrace({
                ...diagnosticsBase,
                ...rawTurnInjection,
                ...(toolLoop.toolLoop === undefined ? {} : { toolLoop: toolLoop.toolLoop }),
                contextSource: 'fallback_truncation',
                materializationErrorStage: 'without_hints',
                materializationErrorCode: toErrorCode(errorWithoutHints),
                budgetUsedTokens: toolLoop.contextResult.contextTokenEstimate,
                summaryReferenceCount: 0,
                summaryReferenceIds: [],
                artifactReferenceCount: 0,
                artifactReferenceIds: [],
                modelMessageCount:
                  toolLoop.contextResult.context.length === 0
                    ? 0
                    : toolLoop.contextResult.context.split('\n').length,
              }),
              runtimeProvenance: runtime.provenance,
            });
          }
        }
      } finally {
        await runtime.destroy();
      }
    },
  };
};

export const createBaselineStrategies = (
  config: LocomoBenchmarkConfig,
): Readonly<Record<LocomoBaselineName, BaselineStrategy>> => {
  const baselines: Record<LocomoBaselineName, BaselineStrategy> = {
    ledgermind_static_materialize: createLedgermindBaseline(config, {
      name: 'ledgermind_static_materialize',
      variant: 'default',
      preCompactionEnabled: true,
      rawTurnInjectionEnabled: true,
      runtimeMode: 'static_materialize',
    }),
    ledgermind_static_materialize_no_precompaction: createLedgermindBaseline(config, {
      name: 'ledgermind_static_materialize_no_precompaction',
      variant: 'no_precompaction',
      preCompactionEnabled: false,
      rawTurnInjectionEnabled: false,
      runtimeMode: 'static_materialize',
    }),
    ledgermind_static_materialize_raw_turn_injection: createLedgermindBaseline(config, {
      name: 'ledgermind_static_materialize_raw_turn_injection',
      variant: 'raw_turn_injection',
      preCompactionEnabled: true,
      rawTurnInjectionEnabled: true,
      runtimeMode: 'static_materialize',
    }),
    ledgermind_static_materialize_no_precompaction_raw_turn_injection: createLedgermindBaseline(config, {
      name: 'ledgermind_static_materialize_no_precompaction_raw_turn_injection',
      variant: 'no_precompaction_raw_turn_injection',
      preCompactionEnabled: false,
      rawTurnInjectionEnabled: true,
      runtimeMode: 'static_materialize',
    }),
    ledgermind_agentic_loop: createLedgermindBaseline(config, {
      name: 'ledgermind_agentic_loop',
      variant: 'default',
      preCompactionEnabled: true,
      rawTurnInjectionEnabled: true,
      runtimeMode: 'agentic_loop',
    }),
    ledgermind_agentic_loop_no_precompaction: createLedgermindBaseline(config, {
      name: 'ledgermind_agentic_loop_no_precompaction',
      variant: 'no_precompaction',
      preCompactionEnabled: false,
      rawTurnInjectionEnabled: false,
      runtimeMode: 'agentic_loop',
    }),
    ledgermind_agentic_loop_raw_turn_injection: createLedgermindBaseline(config, {
      name: 'ledgermind_agentic_loop_raw_turn_injection',
      variant: 'raw_turn_injection',
      preCompactionEnabled: true,
      rawTurnInjectionEnabled: true,
      runtimeMode: 'agentic_loop',
    }),
    ledgermind_agentic_loop_no_precompaction_raw_turn_injection: createLedgermindBaseline(config, {
      name: 'ledgermind_agentic_loop_no_precompaction_raw_turn_injection',
      variant: 'no_precompaction_raw_turn_injection',
      preCompactionEnabled: false,
      rawTurnInjectionEnabled: true,
      runtimeMode: 'agentic_loop',
    }),
    oracle_evidence: createOracleEvidenceBaseline(config),
    oracle_full_conversation_llm: createOracleFullConversationLlmBaseline(config),
    truncation: createTruncationBaseline(config),
    rag: createRagBaseline(config),
    full_context: createFullContextBaseline(config),
  };

  return Object.freeze(baselines);
};
