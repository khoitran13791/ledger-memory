import { describe, expect, it } from 'vitest';

import { InvalidDagEdgeError, InvariantViolationError } from '../../errors/domain-errors';
import {
  assertContiguousDagEdgeOrders,
  createCondensedDagEdge,
  createLeafDagEdge,
  isCondensedDagEdge,
  isLeafDagEdge,
} from '../dag-edge';
import {
  createContextItem,
  createMessageContextItemRef,
  createSummaryContextItemRef,
} from '../context-item';
import { createArtifact } from '../artifact';
import { createSummaryNode, isSummaryKind } from '../summary-node';
import { createConversationId, createEventId, createSummaryNodeId, createArtifactId } from '../../value-objects/ids';
import { createMimeType } from '../../value-objects/mime-type';
import { createTokenCount } from '../../value-objects/token-count';

describe('summary/dag/context/artifact entities', () => {
  it('creates summary node for valid inputs', () => {
    const summary = createSummaryNode({
      id: createSummaryNodeId('sum_1'),
      conversationId: createConversationId('conv_1'),
      kind: 'leaf',
      content: 'summary',
      tokenCount: createTokenCount(12),
      artifactIds: [createArtifactId('file_1')],
    });

    expect(summary.id).toBe('sum_1');
    expect(summary.kind).toBe('leaf');
    expect(summary.artifactIds).toEqual(['file_1']);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.artifactIds)).toBe(true);
    expect(isSummaryKind('leaf')).toBe(true);
    expect(isSummaryKind('other')).toBe(false);
  });

  it('rejects summary node with invalid token payload', () => {
    expect(() =>
      createSummaryNode({
        id: createSummaryNodeId('sum_1'),
        conversationId: createConversationId('conv_1'),
        kind: 'condensed',
        content: 'summary',
        tokenCount: { value: -1 },
      }),
    ).toThrow(InvariantViolationError);
  });

  it('creates dag edge variants and enforces contiguous order', () => {
    const leaf = createLeafDagEdge({
      summaryId: createSummaryNodeId('sum_1'),
      messageId: createEventId('evt_1'),
      order: 0,
    });
    const condensed = createCondensedDagEdge({
      summaryId: createSummaryNodeId('sum_2'),
      parentSummaryId: createSummaryNodeId('sum_1'),
      order: 1,
    });

    expect(isLeafDagEdge(leaf)).toBe(true);
    expect(isCondensedDagEdge(condensed)).toBe(true);
    assertContiguousDagEdgeOrders([leaf, condensed]);

    expect(() =>
      assertContiguousDagEdgeOrders([
        createLeafDagEdge({
          summaryId: createSummaryNodeId('sum_1'),
          messageId: createEventId('evt_1'),
          order: 0,
        }),
        createCondensedDagEdge({
          summaryId: createSummaryNodeId('sum_2'),
          parentSummaryId: createSummaryNodeId('sum_1'),
          order: 2,
        }),
      ]),
    ).toThrow(InvalidDagEdgeError);
  });

  it('creates context items with message and summary refs', () => {
    const conversationId = createConversationId('conv_1');

    const messageRef = createMessageContextItemRef(createEventId('evt_1'));
    const summaryRef = createSummaryContextItemRef(createSummaryNodeId('sum_1'));

    const messageItem = createContextItem({ conversationId, position: 0, ref: messageRef });
    const summaryItem = createContextItem({ conversationId, position: 1, ref: summaryRef });

    expect(messageItem.ref.type).toBe('message');
    expect(summaryItem.ref.type).toBe('summary');
    expect(Object.isFrozen(messageItem)).toBe(true);
    expect(Object.isFrozen(summaryItem)).toBe(true);
  });

  it('rejects negative context position', () => {
    expect(() =>
      createContextItem({
        conversationId: createConversationId('conv_1'),
        position: -1,
        ref: createMessageContextItemRef(createEventId('evt_1')),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('creates artifact and enforces storage/path invariant', () => {
    const artifact = createArtifact({
      id: createArtifactId('file_1'),
      conversationId: createConversationId('conv_1'),
      storageKind: 'path',
      originalPath: '/tmp/report.json',
      mimeType: createMimeType('application/json'),
      tokenCount: createTokenCount(10),
    });

    expect(artifact.storageKind).toBe('path');
    expect(artifact.originalPath).toBe('/tmp/report.json');
    expect(Object.isFrozen(artifact)).toBe(true);

    expect(() =>
      createArtifact({
        id: createArtifactId('file_2'),
        conversationId: createConversationId('conv_1'),
        storageKind: 'path',
        originalPath: null,
        mimeType: createMimeType('application/json'),
        tokenCount: createTokenCount(1),
      }),
    ).toThrow(InvariantViolationError);
  });
});
