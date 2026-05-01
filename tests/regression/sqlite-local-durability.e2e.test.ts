import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCompactionThresholds,
  createConversationConfig,
  createMimeType,
  createTokenCount,
} from '@ledgermind/domain';
import { createSqliteMemoryEngine } from '@ledgermind/sdk';

import {
  openSqliteDatabase,
  SqliteConversationStore,
} from '../../packages/infrastructure/src/sqlite';

const createTestConversationConfig = () =>
  createConversationConfig({
    modelName: 'sqlite-local-durability-smoke',
    contextWindow: createTokenCount(8192),
    thresholds: createCompactionThresholds(0.6, 1),
  });

describe('sqlite local durability e2e', () => {
  it('persists continuity state across SQLite engine recreation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ledgermind-sqlite-durability-'));
    const sqlitePath = join(tempDir, 'memory.sqlite');
    let firstEngine: ReturnType<typeof createSqliteMemoryEngine> | undefined;
    let reopenedEngine: ReturnType<typeof createSqliteMemoryEngine> | undefined;

    try {
      const seedDatabase = await openSqliteDatabase({ path: sqlitePath });
      const conversation = await (async () => {
        try {
          return await new SqliteConversationStore(seedDatabase.db).create(
            createTestConversationConfig(),
          );
        } finally {
          seedDatabase.close();
        }
      })();

      firstEngine = createSqliteMemoryEngine({ path: sqlitePath });
      const artifact = await firstEngine.storeArtifact({
        conversationId: conversation.id,
        source: {
          kind: 'text',
          content: 'SQLite artifact durability survives engine recreation.',
        },
        mimeType: createMimeType('text/plain'),
      });

      await firstEngine.append({
        conversationId: conversation.id,
        events: [
          {
            role: 'system',
            content: 'You are checking SQLite local durability.',
            tokenCount: createTokenCount(18),
          },
          {
            role: 'user',
            content: 'The active goal is local durable continuity.',
            tokenCount: createTokenCount(18),
          },
          {
            role: 'assistant',
            content: 'Stored an artifact and continuity decision for restart verification.',
            tokenCount: createTokenCount(18),
            metadata: { artifactIds: [artifact.artifactId] },
          },
          {
            role: 'user',
            content: 'Remember that summary DAG nodes must survive reopening the SQLite file.',
            tokenCount: createTokenCount(18),
          },
          {
            role: 'assistant',
            content: 'Will compact enough history to create a durable summary node.',
            tokenCount: createTokenCount(18),
            metadata: { artifactIds: [artifact.artifactId] },
          },
          {
            role: 'user',
            content: 'Materialized context after restart should include artifact references.',
            tokenCount: createTokenCount(18),
          },
          {
            role: 'assistant',
            content: 'Integrity checks should pass after the SQLite restart smoke.',
            tokenCount: createTokenCount(18),
          },
        ],
        idempotencyKey: 'sqlite-local-durability:append',
      });
      await firstEngine.recordContinuity({
        conversationId: conversation.id,
        kind: 'decision',
        title: 'Persist continuity locally',
        content: 'SQLite local durability keeps continuity records after engine recreation.',
        importance: 'high',
        idempotencyKey: 'sqlite-local-durability:decision',
      });
      const compaction = await firstEngine.runCompaction({
        conversationId: conversation.id,
        trigger: 'soft',
        targetTokens: createTokenCount(90),
      });
      expect(compaction.nodesCreated.length).toBeGreaterThan(0);
      await firstEngine.close();

      reopenedEngine = createSqliteMemoryEngine({ path: sqlitePath });
      const state = await reopenedEngine.getCurrentState({ conversationId: conversation.id });
      const materialized = await reopenedEngine.materializeContext({
        conversationId: conversation.id,
        budgetTokens: 240,
        overheadTokens: 20,
      });
      const describedArtifact = await reopenedEngine.describe({ id: artifact.artifactId });
      const integrity = await reopenedEngine.checkIntegrity({ conversationId: conversation.id });

      expect(state.decisions).toEqual([
        expect.objectContaining({
          recordId: 'sqlite-local-durability:decision',
          conversationId: conversation.id,
          kind: 'decision',
          status: 'active',
          importance: 'high',
          title: 'Persist continuity locally',
          content: 'SQLite local durability keeps continuity records after engine recreation.',
        }),
      ]);
      expect(state.activeRecordCount).toBe(1);
      expect(state.staleRecordCount).toBe(0);
      expect(materialized.summaryReferences.length).toBeGreaterThan(0);
      expect(materialized.artifactReferences).toContainEqual(
        expect.objectContaining({
          id: artifact.artifactId,
          explorationSummary: expect.stringContaining('SQLite artifact durability'),
        }),
      );
      expect(describedArtifact.kind).toBe('artifact');
      expect(describedArtifact.explorationSummary).toContain('SQLite artifact durability');
      expect(integrity.report.passed).toBe(true);
    } finally {
      await firstEngine?.close();
      await reopenedEngine?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
