export type LocomoLegacyLedgermindBaselineName =
  | 'ledgermind'
  | 'ledgermind_no_precompaction'
  | 'ledgermind_raw_turn_injection'
  | 'ledgermind_no_precompaction_raw_turn_injection';

export type LocomoRuntimeLabeledLedgermindBaselineName =
  | 'ledgermind_static_materialize'
  | 'ledgermind_static_materialize_no_precompaction'
  | 'ledgermind_static_materialize_raw_turn_injection'
  | 'ledgermind_static_materialize_no_precompaction_raw_turn_injection'
  | 'ledgermind_agentic_loop'
  | 'ledgermind_agentic_loop_no_precompaction'
  | 'ledgermind_agentic_loop_raw_turn_injection'
  | 'ledgermind_agentic_loop_no_precompaction_raw_turn_injection';

export type LocomoBaselineName =
  | LocomoRuntimeLabeledLedgermindBaselineName
  | 'oracle_evidence'
  | 'oracle_full_conversation_llm'
  | 'truncation'
  | 'rag'
  | 'full_context';

export type LocomoBaselineCliName = LocomoBaselineName | LocomoLegacyLedgermindBaselineName;

export type LedgermindVariant =
  | 'default'
  | 'no_precompaction'
  | 'raw_turn_injection'
  | 'no_precompaction_raw_turn_injection';

export type LocomoParityMode = 'parity' | 'upper_bound';

export type LocomoPredictionMode = 'heuristic' | 'llm';

export type LocomoPredictionSource = 'heuristic' | 'llm';

export type LocomoRuntimeMode = 'static_materialize' | 'agentic_loop';

export type LocomoSummarizerType = 'locomo_deterministic_head_tail_v1' | 'locomo_llm_structured_v1';

export interface LocomoRuntimeProvenance {
  readonly runtimeMode: LocomoRuntimeMode;
  readonly summarizerType: LocomoSummarizerType;
  readonly artifactsEnabled: boolean;
  readonly artifactBearingExampleCount: number;
}

export interface LocomoExecutionProvenance {
  readonly requestedPredictionMode: LocomoPredictionMode;
  readonly actualPredictionSource?: LocomoPredictionSource;
  readonly runtime?: LocomoRuntimeProvenance;
}

export interface PredictionSourceCountSummary {
  readonly totalRows: number;
  readonly heuristicRows: number;
  readonly llmRows: number;
  readonly unknownRows: number;
}

export interface BaselineExecutionProvenanceSummary {
  readonly actualPredictionSourceCounts: PredictionSourceCountSummary;
  readonly runtime: LocomoRuntimeProvenance | null;
}

export interface RunExecutionProvenanceBaselineSummary extends BaselineExecutionProvenanceSummary {
  readonly baseline: LocomoBaselineName;
}

export interface RunExecutionProvenanceSummary {
  readonly requestedPredictionMode: LocomoPredictionMode;
  readonly baselines: readonly RunExecutionProvenanceBaselineSummary[];
}

export interface FairnessFingerprintInputs {
  readonly ledgermindRetrievalReserveFraction: number;
  readonly ledgermindRetrievalReserveMaxTokens: number;
  readonly ledgermindSummaryFormatter: string;
  readonly summarySearchScoring: string;
  readonly predictionExtractorVersion: string;
  readonly category5PromptVersion: string;
  readonly rawTurnInjectionFormatterVersion: string;
  readonly rawTurnInjectionSelectionVersion: string;
  readonly ledgermindToolLoopMaxSteps: number;
  readonly ledgermindToolLoopMaxDescribeCalls: number;
  readonly ledgermindToolLoopMaxExploreArtifactCalls: number;
  readonly ledgermindToolLoopMaxExpandCalls: number;
  readonly ledgermindToolLoopMaxGrepCalls: number;
  readonly ledgermindToolLoopMaxAddedTokens: number;
  readonly locomoArtifactMappingVersion: string;
}

export interface LocomoConfigSnapshot extends Readonly<Record<string, unknown>> {
  readonly dataset?: {
    readonly path?: string;
    readonly sha256?: string;
    readonly sampleCount?: number;
    readonly selectedExampleCount?: number;
    readonly smoke?: boolean;
    readonly canary?: boolean;
  };
  readonly prediction?: {
    readonly mode?: LocomoPredictionMode;
    readonly seedMode?: 'ignored' | 'forwarded';
    readonly llmBaseUrl?: string;
    readonly llmTimeoutMs?: number;
  };
  readonly runtime?: {
    readonly mode: LocomoRuntimeMode;
    readonly summarizerType: LocomoSummarizerType;
    readonly artifactsEnabled: boolean;
  };
  readonly fairnessFingerprintInputs?: FairnessFingerprintInputs;
  readonly executionProvenance?: RunExecutionProvenanceSummary;
}

export interface LocomoQaItem {
  readonly question: string;
  readonly answer?: string | number;
  readonly adversarial_answer?: string | number;
  readonly evidence: readonly string[];
  readonly category: number;
}

export interface LocomoConversationTurn {
  readonly speaker: string;
  readonly dia_id: string;
  readonly text: string;
  readonly blip_caption?: string;
}

export type LocomoConversation = Readonly<Record<string, unknown>>;

export interface LocomoConversationSample {
  readonly sample_id: string;
  readonly conversation: LocomoConversation;
  readonly qa: readonly LocomoQaItem[];
}

export interface LocomoExample {
  readonly sampleId: string;
  readonly qaIndex: number;
  readonly category: number;
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly string[];
}

export interface FairnessConfig {
  readonly modelName: string;
  readonly promptTemplate: string;
  readonly temperature: number;
  readonly topP: number;
  readonly tokenBudget: number;
  readonly overheadTokens: number;
  readonly maxAnswerTokens: number;
}

export interface BaselineContextResult {
  readonly context: string;
  readonly contextIds: readonly string[];
  readonly contextTokenEstimate: number;
  readonly parityMode: LocomoParityMode;
}

export interface BaselineExecutionInput {
  readonly sample: LocomoConversationSample;
  readonly example: LocomoExample;
  readonly fairness: FairnessConfig;
  readonly seed: number;
}

export type LocomoFailureCategory =
  | 'none'
  | 'reachability_failure'
  | 'answer_synthesis_failure'
  | 'unsupported_evidence';

export interface LedgermindToolStepTrace {
  readonly step: number;
  readonly tool: 'describe' | 'explore_artifact' | 'expand' | 'grep';
  readonly status: 'ok' | 'error';
  readonly targetId?: string;
  readonly query?: string;
  readonly addedCount?: number;
  readonly addedTokens?: number;
  readonly matchCount?: number;
  readonly note?: string;
}

export interface LedgermindDescribeSignalTrace {
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

export interface LedgermindToolSelectionTrace {
  readonly targetId: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface LedgermindGrepSelectionTrace {
  readonly query: string;
  readonly scope?: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface LedgermindToolLoopDiagnostics {
  readonly enabled: boolean;
  readonly maxSteps: number;
  readonly maxDescribeCalls: number;
  readonly maxExploreArtifactCalls: number;
  readonly maxExpandCalls: number;
  readonly maxGrepCalls: number;
  readonly maxAddedTokens: number;
  readonly stepsUsed: number;
  readonly describedIds: readonly string[];
  readonly exploredArtifactIds: readonly string[];
  readonly expandedSummaryIds: readonly string[];
  readonly grepQueries: readonly string[];
  readonly addedMessageCount: number;
  readonly addedTokens: number;
  readonly preToolContextIds: readonly string[];
  readonly preToolEvidenceIds: readonly string[];
  readonly postToolEvidenceIds: readonly string[];
  readonly describeSignals?: readonly LedgermindDescribeSignalTrace[];
  readonly expandSelection?: readonly LedgermindToolSelectionTrace[];
  readonly artifactSelection?: readonly LedgermindToolSelectionTrace[];
  readonly grepSelection?: readonly LedgermindGrepSelectionTrace[];
  readonly steps: readonly LedgermindToolStepTrace[];
}

export interface LedgermindSummarizationTraceEntry {
  readonly summarizerType: LocomoSummarizerType;
  readonly mode: 'normal' | 'aggressive';
  readonly targetTokens?: number;
  readonly messageCount: number;
  readonly outputContent: string;
  readonly outputTokenCount: number;
  readonly preservedArtifactIds: readonly string[];
}

export interface LedgermindRetrievalStageTrace {
  readonly stage: 'primary' | 'keywords' | 'anchors';
  readonly query: string;
  readonly matchCount: number;
}

export interface LedgermindRetrievalCandidateDecisionTrace {
  readonly summaryId: string;
  readonly score: number;
  readonly stageHits: number;
  readonly overlapCount: number;
  readonly tokenCount: number;
  readonly selected: boolean;
  readonly reason: 'selected' | 'already_in_context' | 'over_budget' | 'limit_reached';
}

export interface LedgermindRetrievalHintTrace {
  readonly hintQuery: string;
  readonly scopeSummaryId?: string;
  readonly limit: number;
  readonly stageQueries: readonly LedgermindRetrievalStageTrace[];
  readonly candidateDecisions: readonly LedgermindRetrievalCandidateDecisionTrace[];
  readonly selectedSummaryIds: readonly string[];
}

export interface LedgermindDiagnostics {
  readonly contextSource: 'materialized' | 'fallback_truncation';
  readonly materializationAttempted: boolean;
  readonly materializationErrorCode?: string;
  readonly materializationErrorStage?: 'with_hints' | 'without_hints';
  readonly variant?: LedgermindVariant;
  readonly preCompactionEnabled?: boolean;
  readonly rawTurnInjectionEnabled?: boolean;
  readonly rawTurnInjectionCandidateCount?: number;
  readonly rawTurnInjectionAddedCount?: number;
  readonly rawTurnInjectionBudgetTokens?: number;
  readonly availableBudgetTokens?: number;
  readonly reservedForToolLoopTokens?: number;
  readonly reservedForRetrievalTokens?: number;
  readonly budgetUsedTokens?: number;
  readonly summaryReferenceCount?: number;
  readonly summaryReferenceIds?: readonly string[];
  readonly artifactReferenceCount?: number;
  readonly artifactReferenceIds?: readonly string[];
  readonly artifactBearingExample?: boolean;
  readonly modelMessageCount?: number;
  readonly retrievalHintCount?: number;
  readonly retrievalMatchCount?: number;
  readonly retrievalAddedCount?: number;
  readonly retrievalHints?: readonly LedgermindRetrievalHintTrace[];
  readonly compactionTriggered?: boolean;
  readonly trimmedToFit?: boolean;
  readonly droppedMessageCount?: number;
  readonly droppedSummaryCount?: number;
  readonly toolLoop?: LedgermindToolLoopDiagnostics;
  readonly summarizationTrace?: readonly LedgermindSummarizationTraceEntry[];
}

export interface BaselineExecutionResult {
  readonly prediction: string;
  readonly contextResult: BaselineContextResult;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly predictionSource?: LocomoPredictionSource;
  readonly abstentionRetried?: boolean;
  readonly retrievalQuery?: string;
  readonly diagnostics?: LedgermindDiagnostics;
  readonly provenance?: LocomoExecutionProvenance;
}

export interface BaselineStrategy {
  readonly name: LocomoBaselineName;
  readonly parityMode: LocomoParityMode;
  run(input: BaselineExecutionInput): Promise<BaselineExecutionResult>;
}

export interface LocomoEvidenceInContextMetrics {
  readonly goldEvidenceIds: readonly string[];
  readonly matchedEvidenceIds: readonly string[];
  readonly missingEvidenceIds: readonly string[];
  readonly recall: number;
  readonly hasGoldEvidenceInContext: boolean;
  readonly hasAllGoldEvidenceInContext: boolean;
}

export interface PerExampleRecord {
  readonly runId: string;
  readonly baseline: LocomoBaselineName;
  readonly parityMode: LocomoParityMode;
  readonly seed: number;
  readonly sampleId: string;
  readonly qaIndex: number;
  readonly category: number;
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly string[];
  readonly prediction: string;
  readonly predictionKey: string;
  readonly predictionSource?: LocomoPredictionSource;
  readonly abstentionRetried?: boolean;
  readonly officialScore: number;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly contextTokenEstimate: number;
  readonly contextIds: readonly string[];
  readonly artifactBearingExample?: boolean;
  readonly evidenceInContext: LocomoEvidenceInContextMetrics;
  readonly costUsd: number;
  readonly fairnessFingerprint: string;
  readonly diagnostics?: LedgermindDiagnostics;
  readonly provenance?: LocomoExecutionProvenance;
  readonly status: 'ok';
}

export interface LocomoTraceTokenSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly contextTokens: number;
}

export interface LocomoTraceContextSelection {
  readonly contextIds: readonly string[];
  readonly summaryReferenceIds: readonly string[];
  readonly artifactReferenceIds: readonly string[];
  readonly artifactBearingExample?: boolean;
}

export interface LocomoTraceEvidenceDiagnostics {
  readonly goldEvidenceIds: readonly string[];
  readonly matchedEvidenceIds: readonly string[];
  readonly missingEvidenceIds: readonly string[];
  readonly recall: number;
  readonly hasGoldEvidenceInContext: boolean;
  readonly hasAllGoldEvidenceInContext: boolean;
}

export interface LocomoTraceRetrievalDiagnostics {
  readonly query?: string;
  readonly hintCount?: number;
  readonly matchCount?: number;
  readonly addedCount?: number;
  readonly hints?: readonly LedgermindRetrievalHintTrace[];
  readonly reservedForToolLoopTokens?: number;
  readonly reservedForRetrievalTokens?: number;
}

export interface LocomoTraceToolLoopDiagnostics {
  readonly enabled: boolean;
  readonly maxSteps: number;
  readonly maxDescribeCalls: number;
  readonly maxExploreArtifactCalls: number;
  readonly maxExpandCalls: number;
  readonly maxGrepCalls: number;
  readonly maxAddedTokens: number;
  readonly stepsUsed: number;
  readonly describedIds: readonly string[];
  readonly exploredArtifactIds: readonly string[];
  readonly expandedSummaryIds: readonly string[];
  readonly grepQueries: readonly string[];
  readonly addedMessageCount: number;
  readonly addedTokens: number;
  readonly preToolEvidenceIds: readonly string[];
  readonly postToolEvidenceIds: readonly string[];
  readonly describeSignals?: readonly LedgermindDescribeSignalTrace[];
  readonly expandSelection?: readonly LedgermindToolSelectionTrace[];
  readonly artifactSelection?: readonly LedgermindToolSelectionTrace[];
  readonly grepSelection?: readonly LedgermindGrepSelectionTrace[];
  readonly steps: readonly LedgermindToolStepTrace[];
}

export interface LocomoTraceMaterializationDiagnostics {
  readonly attempted: boolean;
  readonly contextSource?: LedgermindDiagnostics['contextSource'];
  readonly errorStage?: LedgermindDiagnostics['materializationErrorStage'];
  readonly errorCode?: string;
}

export interface LocomoTraceFailureClassification {
  readonly category: LocomoFailureCategory;
  readonly reason: string;
  readonly goldEvidenceReachable: boolean;
  readonly hasGoldEvidenceInContext: boolean;
  readonly hasAllGoldEvidenceInContext: boolean;
  readonly unsupportedEvidenceIds?: readonly string[];
}

export interface LocomoTraceExecutionError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

interface LocomoTraceRecordBase {
  readonly traceSchemaVersion: 'locomo_trace_v2';
  readonly runId: string;
  readonly executionIndex: number;
  readonly totalExecutionsPlanned: number;
  readonly baseline: LocomoBaselineName;
  readonly parityMode: LocomoParityMode;
  readonly seed: number;
  readonly sampleId: string;
  readonly qaIndex: number;
  readonly exampleId: string;
  readonly category: number;
  readonly question: string;
  readonly answer: string;
  readonly answerSource: LocomoPredictionSource | 'unknown';
  readonly contextSelection: LocomoTraceContextSelection;
  readonly evidenceDiagnostics: LocomoTraceEvidenceDiagnostics;
  readonly retrievalDiagnostics?: LocomoTraceRetrievalDiagnostics;
  readonly materializationDiagnostics?: LocomoTraceMaterializationDiagnostics;
  readonly toolLoopDiagnostics?: LocomoTraceToolLoopDiagnostics;
  readonly summarizationTrace?: readonly LedgermindSummarizationTraceEntry[];
  readonly failureClassification: LocomoTraceFailureClassification;
  readonly provenance?: LocomoExecutionProvenance;
}

export interface LocomoTraceSuccessRecord extends LocomoTraceRecordBase {
  readonly status: 'ok';
  readonly finalAnswer: string;
  readonly latencyMs: number;
  readonly tokens: LocomoTraceTokenSummary;
}

export interface LocomoTraceErrorRecord extends LocomoTraceRecordBase {
  readonly status: 'error';
  readonly latencyMs: number;
  readonly error: LocomoTraceExecutionError;
}

export type LocomoTraceRecord = LocomoTraceSuccessRecord | LocomoTraceErrorRecord;

export interface SeedScoreSummary {
  readonly seed: number;
  readonly aggregate: number;
  readonly categoryScores: Readonly<Record<number, number>>;
  readonly countByCategory: Readonly<Record<number, number>>;
}

export interface StatsSummary {
  readonly mean: number;
  readonly std: number;
}

export interface BaselineDiagnosticsSummary {
  readonly totalRows: number;
  readonly materializedRows: number;
  readonly fallbackRows: number;
  readonly fallbackRate: number;
  readonly averageSummaryReferenceCount: number;
  readonly averageArtifactReferenceCount: number;
  readonly averageRetrievalMatchCount: number;
  readonly averageRetrievalAddedCount: number;
  readonly averageRawTurnInjectionCandidateCount: number;
  readonly averageRawTurnInjectionAddedCount: number;
  readonly artifactBearingExampleRate: number;
  readonly preCompactionEnabledRate: number;
  readonly rawTurnInjectionEnabledRate: number;
  readonly topMaterializationErrorCodes: readonly {
    readonly code: string;
    readonly count: number;
  }[];
}

export interface BaselineEvidenceRecallSummary {
  readonly overall: StatsSummary;
  readonly categoryRecall: Readonly<Record<number, StatsSummary>>;
  readonly hasAnyEvidenceInContextRate: StatsSummary;
  readonly hasAllEvidenceInContextRate: StatsSummary;
}

export interface BaselineAggregateSummary {
  readonly baseline: LocomoBaselineName;
  readonly parityMode: LocomoParityMode;
  readonly aggregate: StatsSummary;
  readonly categoryScores: Readonly<Record<number, StatsSummary>>;
  readonly tokens: {
    readonly prompt: StatsSummary;
    readonly completion: StatsSummary;
    readonly total: StatsSummary;
  };
  readonly latencyMs: StatsSummary;
  readonly costUsd: StatsSummary;
  readonly seedScores: readonly SeedScoreSummary[];
  readonly evidenceRecall: BaselineEvidenceRecallSummary;
  readonly diagnostics?: BaselineDiagnosticsSummary;
  readonly provenance?: BaselineExecutionProvenanceSummary;
}

export interface PromotionGateResult {
  readonly baseline: LocomoBaselineName;
  readonly aggregateDelta: number;
  readonly categoryDeltas: Readonly<Record<number, number>>;
  readonly improvedCategoryCount: number;
  readonly meetsAggregateGate: boolean;
  readonly meetsCategoryGate: boolean;
  readonly promoted: boolean;
}

export interface LocomoRunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly baselines: readonly BaselineAggregateSummary[];
  readonly fairnessFingerprint: string;
  readonly executionProvenance?: RunExecutionProvenanceSummary;
  readonly promotionGates?: readonly PromotionGateResult[];
}
