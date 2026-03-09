import { describe, expect, it } from 'vitest';

import {
  createCompactionThresholds,
  createConversationConfig,
  createTokenCount,
  InvariantViolationError,
} from '@ledgermind/domain';

import type { ConformanceAdapterDefinition } from '../run-conformance';

const createConversationCfg = (modelName: string) => {
  return createConversationConfig({
    modelName,
    contextWindow: createTokenCount(4096),
    thresholds: createCompactionThresholds(0.6, 1),
  });
};

export const registerConversationConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe('conversation contract', () => {
    it('returns ancestor chains in root-to-parent order', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const root = await runtime.conversations.create(createConversationCfg('root'));
        const child = await runtime.conversations.create(createConversationCfg('child'), root.id);

        const chain = await runtime.conversations.getAncestorChain(child.id);
        expect(chain).toEqual([root.id]);
      } finally {
        await runtime.destroy();
      }
    });

    it('returns null and empty chains for unknown conversation IDs', async () => {
      const runtime = await adapter.createRuntime();

      try {
        const unknownConversationId = 'conv_999999' as never;
        const loaded = await runtime.conversations.get(unknownConversationId);
        const chain = await runtime.conversations.getAncestorChain(unknownConversationId);

        expect(loaded).toBeNull();
        expect(chain).toEqual([]);
      } finally {
        await runtime.destroy();
      }
    });

    it('rejects creating a child conversation when parent does not exist', async () => {
      const runtime = await adapter.createRuntime();

      try {
        await expect(
          runtime.conversations.create(createConversationCfg('orphan-child'), 'conv_missing_parent' as never),
        ).rejects.toBeInstanceOf(InvariantViolationError);
      } finally {
        await runtime.destroy();
      }
    });
  });
};
