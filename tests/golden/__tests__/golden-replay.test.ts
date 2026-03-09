import { describe, expect, it } from 'vitest';

import {
  createContextItem,
  createConversationId,
  createIdService,
  createLedgerEvent,
  createMessageContextItemRef,
  createSequenceNumber,
  createSummaryContextItemRef,
  createSummaryNode,
  type EventId,
  type HashPort,
  type LedgerEvent,
} from '@ledgermind/domain';
import type { SummarizationMessage } from '@ledgermind/application';

import type { CoreUseCasesFixture } from '../../shared/fixtures';
import { createDeterministicTestDeps } from '../../shared/stubs';
import { goldenReplayFixtures } from '../fixtures';

interface ReplaySignature {
  readonly eventIds: readonly string[];
  readonly summaryIds: readonly string[];
  readonly lineageEdges: readonly string[];
  readonly contextRefs: readonly string[];
  readonly expandedMessageIds: readonly string[];
}

const deterministicHashPort: HashPort = {
  sha256: (input) => {
    let acc = 2166136261;

    for (const byte of input) {
      acc ^= byte;
      acc = Math.imul(acc, 16777619) >>> 0;
    }

    return acc.toString(16).padStart(8, '0').repeat(8);
  },
};

const toSummarizationMessages = (events: readonly LedgerEvent[]): readonly SummarizationMessage[] => {
  return events.map((event) => ({
    role: event.role,
    content: event.content,
  }));
};

const toStringIds = (eventIds: readonly EventId[]): readonly string[] => {
  return Object.freeze(eventIds.map((eventId) => eventId));
};

const replayFixture = async (fixture: CoreUseCasesFixture): Promise<ReplaySignature> => {
  const deps = createDeterministicTestDeps({ fixedDate: new Date('2026-02-02T02:02:02.000Z') });
  const idService = createIdService(deterministicHashPort);
  const conversationId = createConversationId(`conv_${fixture.name}`);

  const ledgerEvents = fixture.events.map((event, index) => {
    const sequence = createSequenceNumber(index + 1);
    const eventId = idService.generateEventId({
      content: event.content,
      conversationId,
      role: event.role,
      sequence,
    });

    return createLedgerEvent({
      id: eventId,
      conversationId,
      sequence,
      role: event.role,
      content: event.content,
      tokenCount: deps.tokenizer.countTokens(event.content),
      occurredAt: deps.clock.now(),
      metadata: { fixture: fixture.name },
    });
  });

  const leafSummaryOutput = await deps.summarizer.summarize({
    messages: toSummarizationMessages(ledgerEvents),
    mode: 'normal',
    artifactIdsToPreserve: [],
  });

  const leafSummaryId = idService.generateSummaryId({
    content: leafSummaryOutput.content,
    conversationId,
    kind: 'leaf',
  });

  const leafSummary = createSummaryNode({
    id: leafSummaryId,
    conversationId,
    kind: 'leaf',
    content: leafSummaryOutput.content,
    tokenCount: leafSummaryOutput.tokenCount,
    artifactIds: leafSummaryOutput.preservedArtifactIds,
    createdAt: deps.clock.now(),
  });

  const condensedSummaryOutput = await deps.summarizer.summarize({
    messages: [{ role: 'assistant', content: leafSummary.content }],
    mode: 'aggressive',
    artifactIdsToPreserve: leafSummary.artifactIds,
  });

  const condensedSummaryId = idService.generateSummaryId({
    content: condensedSummaryOutput.content,
    conversationId,
    kind: 'condensed',
  });

  const condensedSummary = createSummaryNode({
    id: condensedSummaryId,
    conversationId,
    kind: 'condensed',
    content: condensedSummaryOutput.content,
    tokenCount: condensedSummaryOutput.tokenCount,
    artifactIds: condensedSummaryOutput.preservedArtifactIds,
    createdAt: deps.clock.now(),
  });

  const tailWindowSize = Math.min(3, ledgerEvents.length);
  const tailEvents = ledgerEvents.slice(ledgerEvents.length - tailWindowSize);

  const contextItems = [
    createContextItem({
      conversationId,
      position: 0,
      ref: createSummaryContextItemRef(condensedSummary.id),
    }),
    ...tailEvents.map((event, index) =>
      createContextItem({
        conversationId,
        position: index + 1,
        ref: createMessageContextItemRef(event.id),
      }),
    ),
  ];

  const eventIds = toStringIds(ledgerEvents.map((event) => event.id));

  return Object.freeze({
    eventIds,
    summaryIds: Object.freeze([leafSummary.id, condensedSummary.id]),
    lineageEdges: Object.freeze([
      `${leafSummary.id}->${eventIds.join(',')}`,
      `${condensedSummary.id}->${leafSummary.id}`,
    ]),
    contextRefs: Object.freeze(
      contextItems.map((item) =>
        item.ref.type === 'summary'
          ? `summary:${item.ref.summaryId}`
          : `message:${item.ref.messageId}`,
      ),
    ),
    expandedMessageIds: eventIds,
  });
};

describe('golden replay determinism', () => {
  it.each(goldenReplayFixtures)('produces stable IDs and equivalent lineage for $name', async (fixture) => {
    const first = await replayFixture(fixture);
    const second = await replayFixture(fixture);

    expect(second).toEqual(first);
    expect(first.eventIds).toHaveLength(fixture.events.length);
    expect(first.expandedMessageIds).toHaveLength(fixture.events.length);
    expect(first.summaryIds.every((summaryId) => summaryId.startsWith(fixture.expected.summaryIdPrefix))).toBe(
      true,
    );
    expect(first.lineageEdges).toHaveLength(2);
    expect(first.contextRefs[0]?.startsWith('summary:sum_')).toBe(true);
  });
});
