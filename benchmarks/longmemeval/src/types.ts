export type LongMemEvalBaselineName =
  | 'full_history_upper_bound'
  | 'ledgermind_static_materialize'
  | 'ledgermind_agentic_loop';

export type LongMemEvalParityMode = 'parity' | 'upper_bound';

export type LongMemEvalRuntimeMode = 'static_materialize' | 'agentic_loop';

export type LongMemEvalScorerMode = 'official_python' | 'fallback_exact_match';

export interface LongMemEvalFairnessConfig {
  readonly modelName: string;
  readonly promptTemplate: string;
  readonly temperature: number;
  readonly topP: number;
  readonly tokenBudget: number;
  readonly maxAnswerTokens: number;
}

export interface LongMemEvalRunCliOptions {
  readonly smoke: boolean;
  readonly canary: boolean;
  readonly outDir?: string;
  readonly runtimeMode?: LongMemEvalRuntimeMode;
}

export interface LongMemEvalBenchmarkConfig {
  readonly smoke: boolean;
  readonly canary: boolean;
  readonly runtimeMode: LongMemEvalRuntimeMode;
  readonly baselines: readonly LongMemEvalBaselineName[];
  readonly fairness: LongMemEvalFairnessConfig;
  readonly datasetPath: string;
  readonly scorerPath: string;
  readonly smokeExampleIdsPath: string;
  readonly canaryExampleIdsPath: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly costPer1kPromptUsd: number;
  readonly costPer1kCompletionUsd: number;
}

export interface LongMemEvalHistoryTurn {
  readonly turnId: string;
  readonly role: string;
  readonly content: string;
  readonly sourceIndex: number;
  readonly hasAnswer: boolean;
}

export interface LongMemEvalHistorySession {
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly sourceIndex: number;
  readonly turns: readonly LongMemEvalHistoryTurn[];
}

export interface LongMemEvalExampleMetadata {
  readonly questionType: string;
  readonly questionDate: string;
  readonly haystackSessionIds: readonly string[];
  readonly haystackDates: readonly string[];
}

export interface LongMemEvalExample {
  readonly exampleId: string;
  readonly question: string;
  readonly answer: string;
  readonly history: readonly LongMemEvalHistorySession[];
  readonly goldEvidenceIds?: readonly string[];
  readonly metadata: LongMemEvalExampleMetadata;
}

export interface LongMemEvalTraceToolStep {
  readonly step: number;
  readonly kind: 'describe' | 'expand' | 'grep';
  readonly targetId?: string;
  readonly query?: string;
  readonly matchCount?: number;
  readonly addedTokens?: number;
  readonly outcome: 'ok' | 'error' | 'skipped';
}

export interface LongMemEvalTraceRecord {
  readonly exampleId: string;
  readonly baseline: LongMemEvalBaselineName;
  readonly parityMode: LongMemEvalParityMode;
  readonly toolSteps: readonly LongMemEvalTraceToolStep[];
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedCostUsd: number;
}

export interface LongMemEvalPerExampleRecord {
  readonly exampleId: string;
  readonly baseline: LongMemEvalBaselineName;
  readonly parityMode: LongMemEvalParityMode;
  readonly prediction: string;
  readonly answer: string;
  readonly score: number;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedCostUsd: number;
  readonly scorerMode: LongMemEvalScorerMode;
}

export interface LongMemEvalBaselineSummary {
  readonly baseline: LongMemEvalBaselineName;
  readonly parityMode: LongMemEvalParityMode;
  readonly averageScore: number;
  readonly averagePromptTokens: number;
  readonly averageCompletionTokens: number;
  readonly averageLatencyMs: number;
  readonly averageCostUsd: number;
  readonly scorerMode: LongMemEvalScorerMode;
}

export interface LongMemEvalRunSummary {
  readonly runId: string;
  readonly exampleCount: number;
  readonly baselines: readonly LongMemEvalBaselineSummary[];
}

export interface LongMemEvalConfigSnapshot extends Readonly<Record<string, unknown>> {
  readonly runId?: string;
  readonly smoke?: boolean;
  readonly canary?: boolean;
}

export interface LongMemEvalOfficialTurn {
  readonly role: string;
  readonly content: string;
  readonly has_answer?: boolean;
}

export interface LongMemEvalOfficialExample {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer: string;
  readonly question_date: string;
  readonly haystack_session_ids: readonly string[];
  readonly haystack_dates: readonly string[];
  readonly haystack_sessions: readonly (readonly LongMemEvalOfficialTurn[])[];
  readonly answer_session_ids?: readonly string[];
}

export interface LongMemEvalScoringInput {
  readonly baseline: LongMemEvalBaselineName;
  readonly prediction: string;
  readonly answer: string;
  readonly promptTokens: number;
  readonly parityTokenBudget: number;
  readonly scorerPath: string;
}

export interface LongMemEvalScoringResult {
  readonly normalizedPrediction: string;
  readonly normalizedAnswer: string;
  readonly score: number;
  readonly parityMode: LongMemEvalParityMode;
  readonly scorerMode: LongMemEvalScorerMode;
}
