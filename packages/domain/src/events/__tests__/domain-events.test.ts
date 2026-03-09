import { describe, expect, it } from 'vitest';

import type { StorageKind } from '../../entities/artifact';
import type { SummaryKind } from '../../entities/summary-node';
import {
  createArtifactId,
  createConversationId,
  createEventId,
  createSequenceNumber,
  createSummaryNodeId,
} from '../../value-objects/ids';
import { createTokenCount } from '../../value-objects/token-count';
import type {
  ArtifactStored,
  CompactionCompleted,
  CompactionTriggered,
  ContextMaterialized,
  DomainEvent,
  LedgerEventAppended,
  SummaryNodeCreated,
} from '../domain-events';

const conversationId = createConversationId('conv_us3');

describe('domain events contracts', () => {
  it('covers all required event variants in the DomainEvent union', () => {
    const ledgerEventAppended: LedgerEventAppended = {
      type: 'LedgerEventAppended',
      conversationId,
      eventId: createEventId('evt_us3'),
      sequence: createSequenceNumber(1),
      tokenCount: createTokenCount(10),
    };

    const compactionTriggered: CompactionTriggered = {
      type: 'CompactionTriggered',
      conversationId,
      trigger: 'soft',
      currentTokens: createTokenCount(100),
      threshold: createTokenCount(80),
    };

    const summaryNodeCreated: SummaryNodeCreated = {
      type: 'SummaryNodeCreated',
      conversationId,
      nodeId: createSummaryNodeId('sum_us3'),
      kind: 'leaf',
      level: 2,
      inputTokens: createTokenCount(100),
      outputTokens: createTokenCount(40),
      coveredItemCount: 3,
    };

    const compactionCompleted: CompactionCompleted = {
      type: 'CompactionCompleted',
      conversationId,
      rounds: 2,
      nodesCreated: [createSummaryNodeId('sum_us3_a'), createSummaryNodeId('sum_us3_b')],
      tokensFreed: createTokenCount(60),
      converged: true,
    };

    const artifactStored: ArtifactStored = {
      type: 'ArtifactStored',
      conversationId,
      artifactId: createArtifactId('file_us3'),
      storageKind: 'inline_text',
      tokenCount: createTokenCount(25),
    };

    const contextMaterialized: ContextMaterialized = {
      type: 'ContextMaterialized',
      conversationId,
      budgetUsed: createTokenCount(300),
      budgetTotal: createTokenCount(500),
      itemCount: 4,
    };

    const events: readonly DomainEvent[] = [
      ledgerEventAppended,
      compactionTriggered,
      summaryNodeCreated,
      compactionCompleted,
      artifactStored,
      contextMaterialized,
    ];

    expect(events).toHaveLength(6);
    expect(events.map((event) => event.type)).toEqual([
      'LedgerEventAppended',
      'CompactionTriggered',
      'SummaryNodeCreated',
      'CompactionCompleted',
      'ArtifactStored',
      'ContextMaterialized',
    ]);
  });

  it('exposes required event payload fields with branded IDs and value objects', () => {
    const summaryEvent: SummaryNodeCreated = {
      type: 'SummaryNodeCreated',
      conversationId,
      nodeId: createSummaryNodeId('sum_contract'),
      kind: 'condensed',
      level: 3,
      inputTokens: createTokenCount(512),
      outputTokens: createTokenCount(128),
      coveredItemCount: 6,
    };

    const artifactEvent: ArtifactStored = {
      type: 'ArtifactStored',
      conversationId,
      artifactId: createArtifactId('file_contract'),
      storageKind: 'path',
      tokenCount: createTokenCount(75),
    };

    expect(summaryEvent.kind satisfies SummaryKind).toBe('condensed');
    expect(summaryEvent.level).toBe(3);
    expect(summaryEvent.inputTokens.value).toBe(512);
    expect(summaryEvent.outputTokens.value).toBe(128);
    expect(summaryEvent.coveredItemCount).toBe(6);

    expect(artifactEvent.storageKind satisfies StorageKind).toBe('path');
    expect(artifactEvent.tokenCount.value).toBe(75);
  });

  it('supports exhaustive narrowing over the DomainEvent union by type discriminator', () => {
    const events: readonly DomainEvent[] = [
      {
        type: 'LedgerEventAppended',
        conversationId,
        eventId: createEventId('evt_narrow'),
        sequence: createSequenceNumber(2),
        tokenCount: createTokenCount(12),
      },
      {
        type: 'CompactionTriggered',
        conversationId,
        trigger: 'hard',
        currentTokens: createTokenCount(900),
        threshold: createTokenCount(700),
      },
      {
        type: 'SummaryNodeCreated',
        conversationId,
        nodeId: createSummaryNodeId('sum_narrow'),
        kind: 'leaf',
        level: 1,
        inputTokens: createTokenCount(120),
        outputTokens: createTokenCount(60),
        coveredItemCount: 2,
      },
      {
        type: 'CompactionCompleted',
        conversationId,
        rounds: 1,
        nodesCreated: [createSummaryNodeId('sum_done')],
        tokensFreed: createTokenCount(60),
        converged: false,
      },
      {
        type: 'ArtifactStored',
        conversationId,
        artifactId: createArtifactId('file_narrow'),
        storageKind: 'inline_binary',
        tokenCount: createTokenCount(33),
      },
      {
        type: 'ContextMaterialized',
        conversationId,
        budgetUsed: createTokenCount(100),
        budgetTotal: createTokenCount(150),
        itemCount: 2,
      },
    ];

    const summaries = events.map((event) => {
      switch (event.type) {
        case 'LedgerEventAppended':
          return `event:${event.eventId}:${event.sequence}`;
        case 'CompactionTriggered':
          return `trigger:${event.trigger}:${event.threshold.value}`;
        case 'SummaryNodeCreated':
          return `summary:${event.kind}:${event.level}`;
        case 'CompactionCompleted':
          return `complete:${event.rounds}:${event.converged}`;
        case 'ArtifactStored':
          return `artifact:${event.storageKind}:${event.tokenCount.value}`;
        case 'ContextMaterialized':
          return `context:${event.budgetUsed.value}/${event.budgetTotal.value}`;
      }
    });

    expect(summaries).toEqual([
      'event:evt_narrow:2',
      'trigger:hard:700',
      'summary:leaf:1',
      'complete:1:false',
      'artifact:inline_binary:33',
      'context:100/150',
    ]);
  });
});
