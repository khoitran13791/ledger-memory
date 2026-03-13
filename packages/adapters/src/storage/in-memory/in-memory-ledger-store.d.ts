import type { LedgerAppendPort, LedgerReadGrepMatch, LedgerReadPort, SequenceRange } from '@ledgermind/application';
import { type ConversationId, type LedgerEvent, type SequenceNumber, type SummaryNodeId } from '@ledgermind/domain';
import type { InMemoryPersistenceState } from './state';
export declare class InMemoryLedgerStore implements LedgerAppendPort, LedgerReadPort {
    private readonly state;
    constructor(state?: InMemoryPersistenceState);
    appendEvents(conversationId: ConversationId, events: readonly LedgerEvent[]): Promise<void>;
    getNextSequence(conversationId: ConversationId): Promise<SequenceNumber>;
    getEvents(conversationId: ConversationId, range?: SequenceRange): Promise<readonly LedgerEvent[]>;
    searchEvents(conversationId: ConversationId, query: string, scope?: SummaryNodeId): Promise<readonly LedgerEvent[]>;
    regexSearchEvents(conversationId: ConversationId, pattern: string, scope?: SummaryNodeId): Promise<readonly LedgerReadGrepMatch[]>;
}
//# sourceMappingURL=in-memory-ledger-store.d.ts.map