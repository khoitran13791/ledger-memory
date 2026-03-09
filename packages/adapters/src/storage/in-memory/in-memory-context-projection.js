import { StaleContextVersionError } from '@ledgermind/application';
import { createContextItem, createContextVersion, createTokenCount, InvariantViolationError, } from '@ledgermind/domain';
import { cloneContextItem, createInMemoryPersistenceState, getContextVersionOrDefault, } from './state';
const sortByPosition = (items) => {
    return [...items].sort((left, right) => left.position - right.position);
};
const normalizePositions = (conversationId, items) => {
    const sorted = sortByPosition(items);
    return sorted.map((item, index) => createContextItem({
        conversationId,
        position: index,
        ref: item.ref,
    }));
};
const buildContextItemsForAppend = (conversationId, base, itemsToAppend) => {
    const result = [...base];
    for (const item of itemsToAppend) {
        if (item.conversationId !== conversationId) {
            throw new InvariantViolationError('Context item conversation mismatch during append.');
        }
        result.push(createContextItem({
            conversationId,
            position: result.length,
            ref: item.ref,
        }));
    }
    return result;
};
const dedupeAndSortPositions = (positions) => {
    return [...new Set(positions)].sort((left, right) => left - right);
};
export class InMemoryContextProjection {
    state;
    constructor(state = createInMemoryPersistenceState()) {
        this.state = state;
    }
    async getCurrentContext(conversationId) {
        const items = this.state.contextItemsByConversation.get(conversationId) ?? [];
        const normalized = normalizePositions(conversationId, items).map((item) => cloneContextItem(item));
        return {
            items: normalized,
            version: getContextVersionOrDefault(this.state, conversationId),
        };
    }
    async getContextTokenCount(conversationId) {
        const items = this.state.contextItemsByConversation.get(conversationId) ?? [];
        let total = 0;
        for (const item of items) {
            if (item.ref.type === 'message') {
                const message = this.state.ledgerEventsById.get(item.ref.messageId);
                if (message) {
                    total += message.tokenCount.value;
                }
                continue;
            }
            const summary = this.state.summaryNodesById.get(item.ref.summaryId);
            if (summary) {
                total += summary.tokenCount.value;
            }
        }
        return createTokenCount(total);
    }
    async appendContextItems(conversationId, items) {
        if (items.length === 0) {
            return getContextVersionOrDefault(this.state, conversationId);
        }
        const existing = this.state.contextItemsByConversation.get(conversationId) ?? [];
        const normalizedExisting = normalizePositions(conversationId, existing);
        const nextItems = buildContextItemsForAppend(conversationId, normalizedExisting, items);
        this.state.contextItemsByConversation.set(conversationId, nextItems.map((item) => cloneContextItem(item)));
        const nextVersion = createContextVersion(getContextVersionOrDefault(this.state, conversationId) + 1);
        this.state.contextVersionsByConversation.set(conversationId, nextVersion);
        return nextVersion;
    }
    async replaceContextItems(conversationId, expectedVersion, positionsToRemove, replacement) {
        const currentVersion = getContextVersionOrDefault(this.state, conversationId);
        if (currentVersion !== expectedVersion) {
            throw new StaleContextVersionError(expectedVersion, currentVersion);
        }
        if (replacement.conversationId !== conversationId) {
            throw new InvariantViolationError('Replacement context item conversation mismatch.');
        }
        const existing = normalizePositions(conversationId, this.state.contextItemsByConversation.get(conversationId) ?? []);
        const removalPositions = dedupeAndSortPositions(positionsToRemove);
        if (removalPositions.length === 0) {
            return currentVersion;
        }
        for (const position of removalPositions) {
            if (!Number.isSafeInteger(position) || position < 0 || position >= existing.length) {
                throw new InvariantViolationError('positionsToRemove contains an out-of-range context position.');
            }
        }
        const removalSet = new Set(removalPositions);
        const insertionIndex = removalPositions[0];
        if (insertionIndex === undefined) {
            return currentVersion;
        }
        const retained = existing.filter((item) => !removalSet.has(item.position));
        const merged = [
            ...retained.slice(0, insertionIndex),
            createContextItem({
                conversationId,
                position: insertionIndex,
                ref: replacement.ref,
            }),
            ...retained.slice(insertionIndex),
        ];
        const normalized = merged.map((item, index) => createContextItem({
            conversationId,
            position: index,
            ref: item.ref,
        }));
        this.state.contextItemsByConversation.set(conversationId, normalized.map((item) => cloneContextItem(item)));
        const nextVersion = createContextVersion(currentVersion + 1);
        this.state.contextVersionsByConversation.set(conversationId, nextVersion);
        return nextVersion;
    }
}
//# sourceMappingURL=in-memory-context-projection.js.map