import { describe, expect, it } from 'vitest';

import { createArtifactId, createConversationId, createSummaryNodeId } from '@ledgermind/domain';

import { InvalidReferenceError } from '../../errors/application-errors';
import { DescribeUseCase } from '../describe';
import {
  createTestArtifact,
  createTestSummary,
  FakeArtifactStorePort,
  FakeSummaryDagPort,
} from './retrieval-test-doubles';

const conversationId = createConversationId('conv_describe_uc');
const summaryId = createSummaryNodeId('sum_describe_uc');
const artifactId = createArtifactId('file_describe_uc');
const unknownId = createSummaryNodeId('sum_unknown_describe_uc');

describe('DescribeUseCase', () => {
  it('returns summary metadata, token count, and planning signals', async () => {
    const summary = createTestSummary({
      idValue: 'sum_describe_uc',
      conversationId,
      kind: 'leaf',
      content: [
        '[Summary]',
        '[Structured Summary]',
        'entities: Alice ; Bob',
        'dates: 1 Jan 2026',
        'commitments: Alice promised status update',
        'outcomes: Checklist approved',
        'lexical_anchors: ZX-41 ; SilverOtter',
        'message_facts:',
        '- #1 | role:assistant | date:1 Jan 2026 | speaker:Alice | fact:Alice referenced D1:1 for rollout update | anchor:ZX-41',
      ].join('\n'),
      tokenCount: 25,
    });

    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const artifactStore = new FakeArtifactStorePort();
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const output = await useCase.execute({ id: summaryId });

    expect(output.kind).toBe('summary');
    expect(output.tokenCount).toEqual(summary.tokenCount);
    expect(output.metadata).toEqual({ content: summary.content });
    expect(output.planningSignals).toEqual({
      entities: ['Alice', 'Bob'],
      dates: ['1 Jan 2026'],
      commitments: ['Alice promised status update'],
      outcomes: ['Checklist approved'],
      lexicalAnchors: ['ZX-41', 'SilverOtter'],
      evidenceIds: ['D1:1'],
    });
    expect(output.explorationSummary).toBeUndefined();
  });

  it('returns artifact metadata, planning signals, and exploration summary when present', async () => {
    const artifact = createTestArtifact({
      idValue: 'file_describe_uc',
      conversationId,
      storageKind: 'path',
      originalPath: '/tmp/data.json',
      mimeType: 'application/json',
      tokenCount: 55,
      explorationSummary: 'json schema overview with rollout anchor ZX-41 and evidence D1:2',
      explorerUsed: 'json-explorer',
    });

    const summaryDag = new FakeSummaryDagPort();
    const artifactStore = new FakeArtifactStorePort([artifact]);
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const output = await useCase.execute({ id: artifactId });

    expect(output.kind).toBe('artifact');
    expect(output.tokenCount).toEqual(artifact.tokenCount);
    expect(output.metadata).toEqual({
      originalPath: '/tmp/data.json',
      explorerUsed: 'json-explorer',
    });
    expect(output.planningSignals).toEqual({
      originalPath: '/tmp/data.json',
      explorerUsed: 'json-explorer',
      hasExplorationSummary: true,
      lexicalAnchors: [],
      evidenceIds: ['D1:2'],
    });
    expect(output.explorationSummary).toBe('json schema overview with rollout anchor ZX-41 and evidence D1:2');
  });

  it('falls back to empty summary planning signals for unstructured summary content', async () => {
    const summary = createTestSummary({
      idValue: 'sum_plain_describe_uc',
      conversationId,
      kind: 'leaf',
      content: 'plain summary without structured markers',
      tokenCount: 11,
    });

    const plainSummaryId = createSummaryNodeId('sum_plain_describe_uc');
    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const artifactStore = new FakeArtifactStorePort();
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const output = await useCase.execute({ id: plainSummaryId });

    expect(output.kind).toBe('summary');
    expect(output.planningSignals).toEqual({
      entities: [],
      dates: [],
      commitments: [],
      outcomes: [],
      lexicalAnchors: [],
      evidenceIds: [],
    });
  });

  it('returns default artifact planning signals when exploration summary is absent', async () => {
    const artifactWithoutSummary = createTestArtifact({
      idValue: 'file_describe_without_summary_uc',
      conversationId,
      storageKind: 'path',
      originalPath: '/tmp/raw.log',
      mimeType: 'text/plain',
      tokenCount: 14,
      explorationSummary: null,
      explorerUsed: null,
    });

    const artifactWithoutSummaryId = createArtifactId('file_describe_without_summary_uc');
    const summaryDag = new FakeSummaryDagPort();
    const artifactStore = new FakeArtifactStorePort([artifactWithoutSummary]);
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const output = await useCase.execute({ id: artifactWithoutSummaryId });

    expect(output.kind).toBe('artifact');
    expect(output.planningSignals).toEqual({
      originalPath: '/tmp/raw.log',
      hasExplorationSummary: false,
      lexicalAnchors: [],
      evidenceIds: [],
    });
    expect(output.explorationSummary).toBeUndefined();
  });

  it('returns parentIds for condensed summaries', async () => {
    const parentSummary = createTestSummary({
      idValue: 'sum_parent_describe_uc',
      conversationId,
      kind: 'leaf',
      content: 'parent summary',
      tokenCount: 20,
    });

    const condensedSummary = createTestSummary({
      idValue: 'sum_condensed_describe_uc',
      conversationId,
      kind: 'condensed',
      content: 'condensed summary',
      tokenCount: 15,
    });

    const parentId = createSummaryNodeId('sum_parent_describe_uc');
    const condensedId = createSummaryNodeId('sum_condensed_describe_uc');

    const summaryDag = new FakeSummaryDagPort({
      summaries: [parentSummary, condensedSummary],
      parentEdgesBySummaryId: new Map([[condensedId, [parentId]]]),
    });
    const artifactStore = new FakeArtifactStorePort();
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const output = await useCase.execute({ id: condensedId });

    expect(output.kind).toBe('summary');
    expect(output.parentIds).toEqual([parentId]);
  });

  it('throws typed invalid-reference error for unknown id', async () => {
    const summaryDag = new FakeSummaryDagPort();
    const artifactStore = new FakeArtifactStorePort();
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const execution = useCase.execute({ id: unknownId });

    await expect(execution).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(execution).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      referenceKind: 'summary_or_artifact',
      referenceId: unknownId,
    });
  });
});
