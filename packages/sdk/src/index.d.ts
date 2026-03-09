import type { MemoryEngine, RunCompactionConfig } from '@ledgermind/application';
export type { AppendLedgerEventsInput, AppendLedgerEventsOutput, ArtifactReference, ArtifactSource, CheckIntegrityInput, CheckIntegrityOutput, DescribeInput, DescribeOutput, ExpandInput, ExpandOutput, ExploreArtifactInput, ExploreArtifactOutput, ExplorerHints, GrepInput, GrepMatch, GrepOutput, MaterializeContextInput, MaterializeContextOutput, MemoryEngine, Metadata, ModelMessage, NewLedgerEvent, PinRule, RetrievalHint, RunCompactionInput, RunCompactionOutput, StoreArtifactInput, StoreArtifactOutput, SummaryReference, } from '@ledgermind/application';
export type MemoryEngineTokenizerConfig = {
    readonly type: 'deterministic';
} | {
    readonly type: 'model-aligned';
    readonly modelFamily?: 'gpt-4o-mini';
};
export interface MemoryEngineConfig {
    readonly storage: {
        readonly type: 'in-memory';
    } | {
        readonly type: 'postgres';
        readonly connectionString: string;
    };
    readonly summarizer?: {
        readonly type: 'deterministic';
    };
    readonly tokenizer?: MemoryEngineTokenizerConfig;
    readonly compaction?: Partial<RunCompactionConfig>;
}
export declare function createMemoryEngine(config: MemoryEngineConfig): MemoryEngine;
//# sourceMappingURL=index.d.ts.map