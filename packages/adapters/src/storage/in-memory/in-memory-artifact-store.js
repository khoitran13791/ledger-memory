import { createArtifact, InvariantViolationError, } from '@ledgermind/domain';
import { cloneArtifactContent, createInMemoryPersistenceState } from './state';
export class InMemoryArtifactStore {
    state;
    constructor(state = createInMemoryPersistenceState()) {
        this.state = state;
    }
    async store(artifact, content) {
        if (this.state.artifactsById.has(artifact.id)) {
            return;
        }
        this.state.artifactsById.set(artifact.id, {
            artifact,
            content: cloneArtifactContent(content ?? null),
        });
    }
    async getMetadata(id) {
        return this.state.artifactsById.get(id)?.artifact ?? null;
    }
    async getContent(id) {
        const record = this.state.artifactsById.get(id);
        if (!record) {
            return null;
        }
        return cloneArtifactContent(record.content);
    }
    async updateExploration(id, summary, explorerUsed) {
        const record = this.state.artifactsById.get(id);
        if (!record) {
            throw new InvariantViolationError('Cannot update exploration for unknown artifact.');
        }
        const updatedArtifact = createArtifact({
            id: record.artifact.id,
            conversationId: record.artifact.conversationId,
            storageKind: record.artifact.storageKind,
            originalPath: record.artifact.originalPath,
            mimeType: record.artifact.mimeType,
            tokenCount: record.artifact.tokenCount,
            explorationSummary: summary,
            explorerUsed,
        });
        this.state.artifactsById.set(id, {
            artifact: updatedArtifact,
            content: cloneArtifactContent(record.content),
        });
    }
}
//# sourceMappingURL=in-memory-artifact-store.js.map