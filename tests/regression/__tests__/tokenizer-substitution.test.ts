import { describe, expect, it } from 'vitest';

import { createConversationId, createTokenCount } from '@ledgermind/domain';
import {
  createMemoryEngine,
  type MemoryEngine,
  type MemoryEngineTokenizerConfig,
} from '@ledgermind/sdk';

const createEngine = (tokenizer?: MemoryEngineTokenizerConfig): MemoryEngine => {
  return createMemoryEngine({
    storage: { type: 'in-memory' },
    ...(tokenizer === undefined ? {} : { tokenizer }),
  });
};

const conversationId = createConversationId('conv_tokenizer_substitution_000001');

const expectConversationNotFoundOnTokenAwareOperations = async (
  tokenizerConfig: MemoryEngineTokenizerConfig,
): Promise<void> => {
  const engine = createEngine(tokenizerConfig);

  await expect(
    engine.storeArtifact({
      conversationId,
      source: { kind: 'text', content: 'tokenizer substitution probe' },
    }),
  ).rejects.toMatchObject({
    code: 'CONVERSATION_NOT_FOUND',
    conversationId,
  });

  await expect(
    engine.runCompaction({
      conversationId,
      trigger: 'soft',
      targetTokens: createTokenCount(1),
    }),
  ).rejects.toMatchObject({
    code: 'CONVERSATION_NOT_FOUND',
    conversationId,
  });
};

describe('tokenizer substitution safety across token-dependent use cases', () => {
  it('supports deterministic tokenizer in StoreArtifact and RunCompaction without contract changes', async () => {
    await expectConversationNotFoundOnTokenAwareOperations({ type: 'deterministic' });
  });

  it('supports model-aligned tokenizer in StoreArtifact and RunCompaction without contract changes', async () => {
    await expectConversationNotFoundOnTokenAwareOperations({ type: 'model-aligned' });
  });
});
