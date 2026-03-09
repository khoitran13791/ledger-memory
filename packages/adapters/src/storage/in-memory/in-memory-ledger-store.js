import { InvariantViolationError, NonMonotonicSequenceError, createSequenceNumber, } from '@ledgermind/domain';
import { createInMemoryPersistenceState } from './state';
const sortEventsBySequence = (events) => {
    return [...events].sort((left, right) => left.sequence - right.sequence);
};
const toLowerCase = (value) => value.toLocaleLowerCase();
const getRangeBounds = (range) => {
    if (!range) {
        return {};
    }
    const bounds = {};
    if (range.start !== undefined) {
        bounds.start = range.start;
    }
    if (range.end !== undefined) {
        bounds.end = range.end;
    }
    return bounds;
};
const createExcerpt = (content, start, length) => {
    const excerptStart = Math.max(0, start - 24);
    const excerptEnd = Math.min(content.length, start + Math.max(1, length) + 24);
    return content.slice(excerptStart, excerptEnd);
};
const collectScopedMessageIds = (state, scope) => {
    if (!state.summaryNodesById.has(scope)) {
        return new Set();
    }
    const visited = new Set();
    const messageIds = new Set();
    const visit = (summaryId) => {
        if (visited.has(summaryId)) {
            return;
        }
        visited.add(summaryId);
        const directMessages = state.leafMessageEdgesBySummary.get(summaryId) ?? [];
        for (const messageId of directMessages) {
            messageIds.add(messageId);
        }
        const parents = state.condensedParentEdgesBySummary.get(summaryId) ?? [];
        for (const parentId of parents) {
            visit(parentId);
        }
    };
    visit(scope);
    return messageIds;
};
export class InMemoryLedgerStore {
    state;
    constructor(state = createInMemoryPersistenceState()) {
        this.state = state;
    }
    async appendEvents(conversationId, events) {
        const existing = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
        const next = [...existing];
        for (const event of events) {
            if (event.conversationId !== conversationId) {
                throw new InvariantViolationError('LedgerEvent conversation mismatch during append.');
            }
            if (this.state.ledgerEventsById.has(event.id)) {
                continue;
            }
            const expectedSequence = next.length + 1;
            if (event.sequence !== expectedSequence) {
                throw new NonMonotonicSequenceError(`LedgerEvent sequence must be gap-free. Expected ${expectedSequence}, received ${event.sequence}.`);
            }
            next.push(event);
        }
        this.state.ledgerEventsByConversation.set(conversationId, next);
        for (const event of next) {
            this.state.ledgerEventsById.set(event.id, event);
        }
    }
    async getNextSequence(conversationId) {
        const events = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
        return createSequenceNumber(events.length + 1);
    }
    async getEvents(conversationId, range) {
        const events = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
        const sorted = sortEventsBySequence(events);
        if (!range) {
            return sorted;
        }
        const { start, end } = getRangeBounds(range);
        return sorted.filter((event) => {
            if (start !== undefined && event.sequence < start) {
                return false;
            }
            if (end !== undefined && event.sequence > end) {
                return false;
            }
            return true;
        });
    }
    async searchEvents(conversationId, query) {
        const normalizedQuery = toLowerCase(query.trim());
        if (normalizedQuery.length === 0) {
            return [];
        }
        const events = this.state.ledgerEventsByConversation.get(conversationId) ?? [];
        return sortEventsBySequence(events).filter((event) => {
            return toLowerCase(event.content).includes(normalizedQuery);
        });
    }
    async regexSearchEvents(conversationId, pattern, scope) {
        const regex = new RegExp(pattern);
        const events = sortEventsBySequence(this.state.ledgerEventsByConversation.get(conversationId) ?? []);
        const scopedMessageIds = scope ? collectScopedMessageIds(this.state, scope) : null;
        const matches = [];
        for (const event of events) {
            if (scopedMessageIds && !scopedMessageIds.has(event.id)) {
                continue;
            }
            const match = regex.exec(event.content);
            if (!match || match.index === undefined) {
                continue;
            }
            const result = scope === undefined
                ? {
                    eventId: event.id,
                    sequence: event.sequence,
                    excerpt: createExcerpt(event.content, match.index, match[0]?.length ?? 0),
                }
                : {
                    eventId: event.id,
                    sequence: event.sequence,
                    excerpt: createExcerpt(event.content, match.index, match[0]?.length ?? 0),
                    coveringSummaryId: scope,
                };
            matches.push(result);
        }
        return matches;
    }
}
//# sourceMappingURL=in-memory-ledger-store.js.map