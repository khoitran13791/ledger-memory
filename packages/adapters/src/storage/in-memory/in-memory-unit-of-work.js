import { InMemoryArtifactStore } from './in-memory-artifact-store';
import { InMemoryContextProjection } from './in-memory-context-projection';
import { InMemoryConversationStore } from './in-memory-conversation-store';
import { InMemoryLedgerStore } from './in-memory-ledger-store';
import { InMemorySummaryDag } from './in-memory-summary-dag';
import { applyInMemoryPersistenceState, cloneInMemoryPersistenceState, createInMemoryPersistenceState, } from './state';
const createUnitOfWorkFromState = (state) => {
    return {
        ledger: new InMemoryLedgerStore(state),
        context: new InMemoryContextProjection(state),
        dag: new InMemorySummaryDag(state),
        artifacts: new InMemoryArtifactStore(state),
        conversations: new InMemoryConversationStore(state),
    };
};
export class InMemoryUnitOfWork {
    state;
    constructor(state = createInMemoryPersistenceState()) {
        this.state = state;
    }
    async execute(work) {
        const workingState = cloneInMemoryPersistenceState(this.state);
        const workingUow = createUnitOfWorkFromState(workingState);
        const result = await work(workingUow);
        applyInMemoryPersistenceState(this.state, workingState);
        return result;
    }
}
//# sourceMappingURL=in-memory-unit-of-work.js.map