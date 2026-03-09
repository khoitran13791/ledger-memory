import { describe, expect, it } from 'vitest';

import { InMemoryConversationStore, createInMemoryPersistenceState } from '@ledgermind/adapters';
import { createCompactionThresholds } from '@ledgermind/domain';
import { InvariantViolationError } from '@ledgermind/domain';
import { createConversationConfig } from '@ledgermind/domain';
import { createConversationId } from '@ledgermind/domain';
import { createTokenCount } from '@ledgermind/domain';

const createConfig = (modelName: string) => {
  return createConversationConfig({
    modelName,
    contextWindow: createTokenCount(8_192),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

describe('InMemoryConversationStore', () => {
  it('creates conversations with deterministic incremental IDs', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryConversationStore(state);

    const first = await store.create(createConfig('model-a'));
    const second = await store.create(createConfig('model-b'));

    expect(first.id).toBe('conv_000001');
    expect(second.id).toBe('conv_000002');
  });

  it('returns conversation by id and ancestor chain root-to-parent order', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryConversationStore(state);

    const root = await store.create(createConfig('root'));
    const child = await store.create(createConfig('child'), root.id);
    const grandChild = await store.create(createConfig('grandchild'), child.id);

    const fetched = await store.get(grandChild.id);
    expect(fetched?.id).toBe(grandChild.id);

    const ancestors = await store.getAncestorChain(grandChild.id);
    expect(ancestors).toEqual([root.id, child.id]);
  });

  it('throws when creating conversation with missing parent', async () => {
    const state = createInMemoryPersistenceState();
    const store = new InMemoryConversationStore(state);

    await expect(
      store.create(createConfig('invalid'), createConversationId('conv_missing')),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });
});
