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
  it('returns summary metadata and token count', async () => {
    const summary = createTestSummary({
      idValue: 'sum_describe_uc',
      conversationId,
      kind: 'leaf',
      content: 'important summarized context',
      tokenCount: 25,
    });

    const summaryDag = new FakeSummaryDagPort({ summaries: [summary] });
    const artifactStore = new FakeArtifactStorePort();
    const useCase = new DescribeUseCase({ summaryDag, artifactStore });

    const output = await useCase.execute({ id: summaryId });

    expect(output.kind).toBe('summary');
    expect(output.tokenCount).toEqual(summary.tokenCount);
    expect(output.metadata).toEqual({ content: 'important summarized context' });
    expect(output.explorationSummary).toBeUndefined();
  });

  it('returns artifact metadata and exploration summary when present', async () => {
    const artifact = createTestArtifact({
      idValue: 'file_describe_uc',
      conversationId,
      storageKind: 'path',
      originalPath: '/tmp/data.json',
      mimeType: 'application/json',
      tokenCount: 55,
      explorationSummary: 'json schema overview',
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
    expect(output.explorationSummary).toBe('json schema overview');
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
