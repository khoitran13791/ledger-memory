import { createHash } from 'node:crypto';
import { createIdService, createTimestamp } from '@ledgermind/domain';
import { AppendLedgerEventsUseCase, CheckIntegrityUseCase, DescribeUseCase, ExpandUseCase, ExploreArtifactUseCase, GrepUseCase, MaterializeContextUseCase, RunCompactionUseCase, StoreArtifactUseCase, TokenizerConfigurationError, } from '@ledgermind/application';
import { createDefaultExplorerRegistry, createInMemoryPersistenceState, DeterministicSummarizerAdapter, InMemoryArtifactStore, InMemoryContextProjection, InMemoryConversationStore, InMemoryLedgerStore, InMemorySummaryDag, InMemoryUnitOfWork, SimpleTokenizerAdapter, SubAgentAuthorizationAdapter, TiktokenTokenizerAdapter, ValidatingTokenizerAdapter, } from '@ledgermind/adapters';
// ---------------------------------------------------------------------------
// NodeCryptoHashPort — SHA-256 via Node.js crypto
// ---------------------------------------------------------------------------
class NodeCryptoHashPort {
    sha256(input) {
        return createHash('sha256').update(input).digest('hex');
    }
}
// ---------------------------------------------------------------------------
// WallClock — production clock backed by system time
// ---------------------------------------------------------------------------
class WallClock {
    now() {
        return createTimestamp(new Date());
    }
}
const SUPPORTED_TOKENIZER_TYPES = '"deterministic", "model-aligned"';
const DEFAULT_MODEL_FAMILY = 'gpt-4o-mini';
const resolveTokenizer = (tokenizerConfig) => {
    if (tokenizerConfig === undefined) {
        return new ValidatingTokenizerAdapter(new SimpleTokenizerAdapter());
    }
    if (typeof tokenizerConfig !== 'object' || tokenizerConfig === null) {
        throw new TokenizerConfigurationError('unknown', `Tokenizer config must be an object. Supported values: ${SUPPORTED_TOKENIZER_TYPES}.`);
    }
    const rawType = tokenizerConfig.type;
    if (rawType === 'deterministic') {
        return new ValidatingTokenizerAdapter(new SimpleTokenizerAdapter());
    }
    if (rawType === 'model-aligned') {
        const rawModelFamily = tokenizerConfig.modelFamily;
        if (rawModelFamily !== undefined && typeof rawModelFamily !== 'string') {
            throw new TokenizerConfigurationError('model-aligned', `modelFamily must be a string when provided. Received ${typeof rawModelFamily}.`);
        }
        const modelFamily = rawModelFamily ?? DEFAULT_MODEL_FAMILY;
        if (modelFamily !== DEFAULT_MODEL_FAMILY) {
            throw new TokenizerConfigurationError('model-aligned', `Unsupported modelFamily "${modelFamily}". Supported values: "${DEFAULT_MODEL_FAMILY}".`);
        }
        return new ValidatingTokenizerAdapter(new TiktokenTokenizerAdapter({ model: modelFamily }), {
            tokenizerName: `TiktokenTokenizerAdapter(${modelFamily})`,
        });
    }
    if (rawType === undefined) {
        throw new TokenizerConfigurationError('unknown', `Missing tokenizer type. Supported values: ${SUPPORTED_TOKENIZER_TYPES}.`);
    }
    throw new TokenizerConfigurationError(String(rawType), `Unsupported tokenizer type "${String(rawType)}". Supported values: ${SUPPORTED_TOKENIZER_TYPES}.`);
};
// ---------------------------------------------------------------------------
// createMemoryEngine — composition root
// ---------------------------------------------------------------------------
export function createMemoryEngine(config) {
    if (config.storage.type === 'postgres') {
        // TODO: Wire Pg adapters from @ledgermind/infrastructure when a full
        //       integration test harness is available. The Pg adapter classes
        //       exist (PgLedgerStore, PgSummaryDag, etc.) but require a PgPool
        //       instance whose lifecycle the SDK does not yet manage.
        throw new Error('Postgres storage is not yet supported by createMemoryEngine(). Use in-memory storage for Phase 1.');
    }
    // ---- shared in-memory state ------------------------------------------
    const state = createInMemoryPersistenceState();
    // ---- adapters ---------------------------------------------------------
    const ledgerStore = new InMemoryLedgerStore(state);
    const summaryDag = new InMemorySummaryDag(state);
    const contextProjection = new InMemoryContextProjection(state);
    const conversationStore = new InMemoryConversationStore(state);
    const artifactStore = new InMemoryArtifactStore(state);
    const unitOfWork = new InMemoryUnitOfWork(state);
    const tokenizer = resolveTokenizer(config.tokenizer);
    const summarizer = new DeterministicSummarizerAdapter(tokenizer);
    const authorization = new SubAgentAuthorizationAdapter();
    const explorerRegistry = createDefaultExplorerRegistry(tokenizer);
    const hashPort = new NodeCryptoHashPort();
    const idService = createIdService(hashPort);
    const clock = new WallClock();
    // ---- use cases --------------------------------------------------------
    const runCompactionUseCase = new RunCompactionUseCase({
        unitOfWork,
        ledgerRead: ledgerStore,
        summarizer,
        tokenizer,
        idService,
        clock,
        ...(config.compaction !== undefined ? { config: config.compaction } : {}),
    });
    const appendUseCase = new AppendLedgerEventsUseCase({
        unitOfWork,
        ledgerRead: ledgerStore,
        idService,
        hashPort,
        clock,
    });
    const materializeUseCase = new MaterializeContextUseCase({
        conversations: conversationStore,
        contextProjection,
        summaryDag,
        ledgerRead: ledgerStore,
        artifactStore,
        runCompaction: (input) => runCompactionUseCase.execute(input),
    });
    const checkIntegrityUseCase = new CheckIntegrityUseCase({
        conversations: conversationStore,
        summaryDag,
    });
    const grepUseCase = new GrepUseCase({
        ledgerRead: ledgerStore,
        summaryDag,
    });
    const describeUseCase = new DescribeUseCase({
        summaryDag,
        artifactStore,
    });
    const expandUseCase = new ExpandUseCase({
        authorization,
        summaryDag,
    });
    const storeArtifactUseCase = new StoreArtifactUseCase({
        unitOfWork,
        idService,
        hashPort,
        tokenizer,
    });
    const exploreArtifactUseCase = new ExploreArtifactUseCase({
        artifactStore,
        explorerRegistry,
    });
    // ---- facade -----------------------------------------------------------
    const engine = {
        append: (input) => appendUseCase.execute(input),
        materializeContext: (input) => materializeUseCase.execute(input),
        runCompaction: (input) => runCompactionUseCase.execute(input),
        checkIntegrity: (input) => checkIntegrityUseCase.execute(input),
        grep: (input) => grepUseCase.execute(input),
        describe: (input) => describeUseCase.execute(input),
        expand: (input) => expandUseCase.execute(input),
        storeArtifact: (input) => storeArtifactUseCase.execute(input),
        exploreArtifact: (input) => exploreArtifactUseCase.execute(input),
    };
    return engine;
}
//# sourceMappingURL=index.js.map