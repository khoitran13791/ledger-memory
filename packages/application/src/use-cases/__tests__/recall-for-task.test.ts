import { describe, expect, it } from 'vitest';

import {
  createArtifactId,
  createConversationId,
  createEventId,
  createMimeType,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
  type TokenCount,
} from '@ledgermind/domain';

import type { TokenizerPort } from '../../ports/driven/llm/tokenizer.port';
import type {
  ContinuityRecord,
  GetCurrentStateInput,
  GetCurrentStateOutput,
} from '../../ports/driving/continuity.port';
import type {
  MaterializeContextInput,
  MaterializeContextOutput,
} from '../../ports/driving/memory-engine.port';
import { RecallForTaskUseCase } from '../recall-for-task';

const conversationId = createConversationId('conv_recall_for_task');
const task = 'Implement Task 6 recall';
const now = createTimestamp(new Date('2026-04-28T10:00:00.000Z'));

class WordTokenizer implements TokenizerPort {
  countTokens(text: string): TokenCount {
    const trimmed = text.trim();
    return createTokenCount(trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length);
  }

  estimateFromBytes(byteLength: number): TokenCount {
    return createTokenCount(byteLength);
  }
}

const record = (
  index: number,
  kind: ContinuityRecord['kind'],
  title: string,
  content: string,
  overrides: Partial<ContinuityRecord> = {},
): ContinuityRecord => ({
  recordId: `${kind}:${index}`,
  conversationId,
  kind,
  status: 'active',
  title,
  content,
  importance: 'normal',
  provenance: {},
  relatedRecordIds: [],
  supersedesRecordIds: [],
  createdAt: now,
  eventId: createEventId(`evt_recall_${index}`),
  ...overrides,
});

const emptyState = (overrides: Partial<GetCurrentStateOutput> = {}): GetCurrentStateOutput => ({
  goalRecords: [],
  decisions: [],
  constraints: [],
  progress: [],
  nextSteps: [],
  handoffs: [],
  verification: [],
  failures: [],
  openQuestions: [],
  artifactChanges: [],
  sessionSummaries: [],
  activeRecordCount: 0,
  staleRecordCount: 0,
  ...overrides,
});

const materializedContext = (
  overrides: Partial<MaterializeContextOutput> = {},
): MaterializeContextOutput => ({
  systemPreamble: '',
  modelMessages: [],
  summaryReferences: [],
  artifactReferences: [],
  budgetUsed: createTokenCount(0),
  ...overrides,
});

const createUseCase = (
  currentState: GetCurrentStateOutput,
  materializeOutput: MaterializeContextOutput = materializedContext(),
) => {
  const getCurrentStateCalls: GetCurrentStateInput[] = [];
  const materializeContextCalls: MaterializeContextInput[] = [];
  const tokenizer = new WordTokenizer();
  const useCase = new RecallForTaskUseCase({
    getCurrentState: async (input) => {
      getCurrentStateCalls.push(input);
      return currentState;
    },
    materializeContext: async (input) => {
      materializeContextCalls.push(input);
      return materializeOutput;
    },
    tokenizer,
  });

  return { getCurrentStateCalls, materializeContextCalls, tokenizer, useCase };
};

describe('RecallForTaskUseCase', () => {
  it('builds a budgeted current-state block with retrieval-backed evidence and why', async () => {
    const summaryId = createSummaryNodeId('sum_recall_direct');
    const diagnosticSummaryId = createSummaryNodeId('sum_recall_diag');
    const artifactId = createArtifactId('art_recall_direct');
    const eventFromRecord = createEventId('evt_recall_goal_source');
    const eventFromProvenance = createEventId('evt_recall_constraint_source');
    const diagnosticEventId = createEventId('evt_recall_diag');
    const state = emptyState({
      goalRecords: [
        record(1, 'goal', 'Ship recall', 'Implement task-start recall for agents.', {
          provenance: { eventIds: [eventFromRecord] },
        }),
      ],
      decisions: [record(2, 'decision', 'Use projection', 'Read active continuity records.')],
      constraints: [
        record(3, 'constraint', 'Keep architecture clean', 'Application depends only inward.', {
          provenance: { eventIds: [eventFromProvenance] },
        }),
      ],
      progress: [record(4, 'progress', 'Tests first', 'RED test captures behavior.')],
      nextSteps: [
        record(5, 'next_step', 'Write use case', 'Implement recall-for-task.'),
        record(6, 'next_step', 'Wire SDK', 'Replace temporary stub.'),
      ],
      handoffs: [
        record(7, 'handoff', 'Latest handoff', 'Continue with SDK wiring.'),
        record(8, 'handoff', 'Older handoff', 'Historical handoff.'),
      ],
      verification: [record(9, 'verification', 'Run focused tests', 'Use pnpm filter command.')],
      failures: [record(10, 'failure', 'Risk: budget trimming', 'Large state may exceed budget.')],
      openQuestions: [record(11, 'open_question', 'Question: exports', 'Confirm SDK re-export.')],
      activeRecordCount: 11,
    });
    const { materializeContextCalls, tokenizer, useCase } = createUseCase(
      state,
      materializedContext({
        summaryReferences: [{ id: summaryId, kind: 'leaf', tokenCount: createTokenCount(4) }],
        artifactReferences: [
          {
            id: artifactId,
            mimeType: createMimeType('text/plain'),
            tokenCount: createTokenCount(3),
          },
        ],
        retrievalDiagnostics: [
          {
            hintQuery: task,
            limit: 3,
            stageQueries: [],
            candidateDecisions: [],
            messageDecisions: [],
            selectedSummaryIds: [diagnosticSummaryId, summaryId],
            selectedMessageIds: [diagnosticEventId, eventFromProvenance],
          },
        ],
      }),
    );

    const output = await useCase.execute({
      conversationId,
      task,
      budgetTokens: 180,
    });

    expect(tokenizer.countTokens(output.contextBlock).value).toBeLessThanOrEqual(180);
    expect(materializeContextCalls).toEqual([
      {
        conversationId,
        budgetTokens: 180,
        overheadTokens: 0,
        retrievalHints: [{ query: task }],
      },
    ]);
    expect(output.contextBlock).toContain(`LedgerMind current state

Goal:
- Ship recall: Implement task-start recall for agents.

Next steps:
- Write use case: Implement recall-for-task.
- Wire SDK: Replace temporary stub.

Decisions:
- Use projection: Read active continuity records.

Constraints:
- Keep architecture clean: Application depends only inward.

Progress:
- Tests first: RED test captures behavior.
- Latest handoff: Continue with SDK wiring.
- Older handoff: Historical handoff.

Verification:
- Run focused tests: Use pnpm filter command.

Failures and risks:
- Risk: budget trimming: Large state may exceed budget.

Open questions:
- Question: exports: Confirm SDK re-export.

Evidence:`);
    expect(output.contextBlock).toContain(`- summary ${summaryId}`);
    expect(output.contextBlock).toContain(`- summary ${diagnosticSummaryId}`);
    expect(output.contextBlock).toContain(`- artifact ${artifactId}`);
    expect(output.contextBlock).toContain(`- event ${eventFromRecord}`);
    expect(output.contextBlock).toContain(`- event ${eventFromProvenance}`);
    expect(output.contextBlock).toContain(`- event ${diagnosticEventId}`);
    expect(output.contextBlock).toContain(`Why recalled:
- Current operational state for task: ${task}
- Matched retrieval hint: ${task}
- Included active decisions, constraints, next steps, and evidence.`);
    expect(output.recalledSummaryIds).toEqual([summaryId, diagnosticSummaryId]);
    expect(output.recalledArtifactIds).toEqual([artifactId]);
    expect(output.recalledEventIds).toEqual([
      eventFromRecord,
      createEventId('evt_recall_1'),
      createEventId('evt_recall_2'),
      eventFromProvenance,
      createEventId('evt_recall_3'),
      createEventId('evt_recall_4'),
      createEventId('evt_recall_5'),
      createEventId('evt_recall_6'),
      createEventId('evt_recall_7'),
      createEventId('evt_recall_8'),
      createEventId('evt_recall_9'),
      createEventId('evt_recall_10'),
      createEventId('evt_recall_11'),
      diagnosticEventId,
    ]);
    expect(output.why).toEqual([
      `Current operational state for task: ${task}`,
      `Matched retrieval hint: ${task}`,
      'Included active decisions, constraints, next steps, and evidence.',
    ]);
    expect(output.budgetUsed).toStrictEqual(tokenizer.countTokens(output.contextBlock));
  });

  it('degrades gracefully when no continuity records exist', async () => {
    const { materializeContextCalls, useCase } = createUseCase(emptyState());

    const output = await useCase.execute({
      conversationId,
      task,
      budgetTokens: 48,
    });

    expect(output.contextBlock).toMatch(/^LedgerMind current state/u);
    expect(output.contextBlock).toContain(`Why recalled:
- Current operational state for task: ${task}
- Matched retrieval hint: ${task}`);
    expect(output.contextBlock).not.toContain('Goal:');
    expect(output.recalledSummaryIds).toEqual([]);
    expect(output.recalledArtifactIds).toEqual([]);
    expect(output.recalledEventIds).toEqual([]);
    expect(materializeContextCalls[0]?.retrievalHints).toEqual([{ query: task }]);
  });

  it('trims droppable details before protected decisions constraints handoff title and first next step', async () => {
    const protectedDecision = record(21, 'decision', 'Protected decision', 'This decision stays.');
    const protectedConstraint = record(
      22,
      'constraint',
      'Protected constraint',
      'This constraint stays.',
    );
    const state = emptyState({
      decisions: [protectedDecision],
      constraints: [protectedConstraint],
      progress: [
        record(23, 'progress', 'Newest progress', 'This current progress stays.'),
        record(28, 'progress', 'Old progress', 'This verbose historical progress should trim.'),
      ],
      nextSteps: [record(24, 'next_step', 'First step', 'This next step stays.')],
      handoffs: [
        record(25, 'handoff', 'Latest handoff title', 'Verbose latest handoff details may trim.'),
      ],
      verification: [
        record(26, 'verification', 'Verbose verification', 'Details should trim before protected.'),
      ],
      openQuestions: [
        record(27, 'open_question', 'Verbose question', 'Details should trim before protected.'),
      ],
      activeRecordCount: 7,
    });
    const { tokenizer, useCase } = createUseCase(
      state,
      materializedContext({
        summaryReferences: [
          {
            id: createSummaryNodeId('sum_recall_trimmed_evidence'),
            kind: 'leaf',
            tokenCount: createTokenCount(5),
          },
        ],
      }),
    );

    const output = await useCase.execute({
      conversationId,
      task,
      budgetTokens: 80,
    });

    expect(tokenizer.countTokens(output.contextBlock).value).toBeLessThanOrEqual(80);
    expect(output.contextBlock).toContain('- Protected decision: This decision stays.');
    expect(output.contextBlock).toContain('- Protected constraint: This constraint stays.');
    expect(output.contextBlock).toContain('- First step: This next step stays.');
    expect(output.contextBlock).toContain('- Latest handoff title');
    expect(output.contextBlock).toContain('- Newest progress: This current progress stays.');
    expect(output.contextBlock).not.toContain('This verbose historical progress should trim.');
  });

  it('falls back to an under-budget minimal block when protected content is too large', async () => {
    const state = emptyState({
      decisions: [
        record(
          31,
          'decision',
          'Extremely verbose protected decision',
          'This decision contains far more words than the tiny budget can carry.',
        ),
      ],
      constraints: [
        record(
          32,
          'constraint',
          'Extremely verbose protected constraint',
          'This constraint also cannot fit inside the tiny recall budget.',
        ),
      ],
      nextSteps: [
        record(
          33,
          'next_step',
          'Extremely verbose protected next step',
          'This first next step is protected but still too large.',
        ),
      ],
      activeRecordCount: 3,
    });
    const { tokenizer, useCase } = createUseCase(state);

    const output = await useCase.execute({
      conversationId,
      task,
      budgetTokens: 12,
    });

    expect(tokenizer.countTokens(output.contextBlock).value).toBeLessThanOrEqual(12);
    expect(output.contextBlock).toContain('LedgerMind current state');
    expect(output.contextBlock).not.toContain('Extremely verbose protected decision');
  });

  it('returns an empty block when even the recall header cannot fit', async () => {
    const { tokenizer, useCase } = createUseCase(
      emptyState({
        decisions: [record(41, 'decision', 'Large protected decision', 'This cannot fit.')],
        activeRecordCount: 1,
      }),
    );

    const output = await useCase.execute({
      conversationId,
      task,
      budgetTokens: 1,
    });

    expect(output.contextBlock).toBe('');
    expect(tokenizer.countTokens(output.contextBlock).value).toBeLessThanOrEqual(1);
  });
});
