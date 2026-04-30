import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createConversationId,
  createEventId,
  createLedgerEvent,
  createSequenceNumber,
  createSummaryNodeId,
  createTimestamp,
  createTokenCount,
} from '@ledgermind/domain';
import { describe, expect, it, vi } from 'vitest';

import type {
  AppendLedgerEventsInput,
  DescribeInput,
  ExpandInput,
  GrepInput,
  GrepOutput,
} from '@ledgermind/sdk';
import { runCli } from '../cli';
import type { CockpitConfig } from '../config';
import { runDecisionCommand, type RecordContinuityRuntime } from '../commands/decision';
import { runDoctorCommand } from '../commands/doctor';
import { runExplainCommand, type ExplainRuntime } from '../commands/explain';
import { runHandoffCommand, type HandoffRuntime } from '../commands/handoff';
import { runNextCommand, type NextRuntime } from '../commands/next';
import { runProgressCommand } from '../commands/progress';
import { runRememberCommand, type RememberRuntime } from '../commands/remember';
import { runRecallCommand, type RecallRuntime } from '../commands/recall';
import { runSourceCommand, type SourceRuntime } from '../commands/source';
import { runStaleCommand, type StaleRuntime } from '../commands/stale';
import { runStateCommand, type StateRuntime } from '../commands/state';
import { runStatusCommand } from '../commands/status';
import { runTaskCommand, type TaskRuntime } from '../commands/task';
import { runTimelineCommand } from '../commands/timeline';
import { runVerifyCommand } from '../commands/verify';

class RecordingWritable {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

const withoutLedgermindDbUrl = async <T>(callback: () => Promise<T>): Promise<T> => {
  const previous = process.env.LEDGERMIND_DB_URL;
  delete process.env.LEDGERMIND_DB_URL;

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.LEDGERMIND_DB_URL;
    } else {
      process.env.LEDGERMIND_DB_URL = previous;
    }
  }
};

const baseConfig: CockpitConfig = {
  storage: { type: 'in-memory' },
  bindingStorePath: '/repo/.ledgermind/session-bindings.json',
  runtimeSessionId: 'workspace',
  userScope: 'khoi',
  workspaceScope: '/repo',
  output: 'human',
};

describe('status command', () => {
  it('renders human status without requiring postgres', async () => {
    const output = await runStatusCommand({
      config: baseConfig,
      listBindings: async () => [],
    });

    expect(output).toContain('LedgerMind status');
    expect(output).toContain('Storage: in-memory');
    expect(output).toContain('Binding store: /repo/.ledgermind/session-bindings.json');
    expect(output).toContain('Bindings: 0');
    expect(output).toContain('Runtime session: workspace');
    expect(output).toContain('Workspace: /repo');
  });

  it('renders optional branch in human status', async () => {
    const output = await runStatusCommand({
      config: { ...baseConfig, branchScope: 'main' },
      listBindings: async () => [],
    });

    expect(output).toContain('Branch: main');
  });

  it('renders JSON status for agents', async () => {
    const output = await runStatusCommand({
      config: {
        ...baseConfig,
        storage: { type: 'postgres', connectionString: 'postgres://localhost/ledgermind' },
        output: 'json',
      },
      listBindings: async () => [],
    });

    expect(JSON.parse(output)).toEqual({
      ok: true,
      storage: { type: 'postgres' },
      bindingStorePath: '/repo/.ledgermind/session-bindings.json',
      bindingCount: 0,
      runtimeSessionId: 'workspace',
      workspaceScope: '/repo',
    });
    expect(output.endsWith('\n')).toBe(true);
  });
});

describe('doctor command', () => {
  it('reports missing durable storage as actionable setup guidance', async () => {
    const output = await runDoctorCommand({
      config: baseConfig,
      checkPostgres: async () => ({
        ok: false,
        message: 'not configured',
        fix: 'Set LEDGERMIND_DB_URL or pass --db <postgres-url>.',
      }),
    });

    expect(output).toContain('LedgerMind doctor');
    expect(output).toContain('Node: Node ');
    expect(output).toContain('Postgres: not configured');
    expect(output).toContain('Binding store: ');
    expect(output).toContain('Set LEDGERMIND_DB_URL or pass --db <postgres-url>.');
  });

  it('renders JSON doctor checks with overall status', async () => {
    const output = await runDoctorCommand({
      config: { ...baseConfig, output: 'json' },
      checkPostgres: async () => ({ ok: true, message: 'configured' }),
      checkBindingStore: async () => ({ ok: true, message: baseConfig.bindingStorePath }),
    });

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      checks: {
        node: { ok: true },
        postgres: { ok: true, message: 'configured' },
        bindingStore: { ok: true, message: baseConfig.bindingStorePath },
      },
    });
  });
});

describe('remember command', () => {
  it('appends a manual note to the active workspace conversation', async () => {
    const conversationId = createConversationId('conv_remember');
    let appendInput: AppendLedgerEventsInput | undefined;
    let closed = false;
    const runtime: RememberRuntime = {
      engine: {
        append: async (input) => {
          appendInput = input;
          return { appendedEvents: [], contextTokenCount: createTokenCount(0) };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        branchScope: 'main',
        conversationId,
      }),
      close: async () => {
        closed = true;
      },
    };

    const output = await runRememberCommand({
      config: { ...baseConfig, branchScope: 'main' },
      text: 'Ship CLI remember',
      runtime,
    });

    expect(output).toBe('Remembered note in conv_remember.\n');
    expect(closed).toBe(true);
    expect(appendInput).toEqual({
      conversationId,
      idempotencyKey: JSON.stringify({
        scope: 'cli:remember',
        workspaceScope: '/repo',
        text: 'Ship CLI remember',
      }),
      events: [
        {
          role: 'system',
          content: 'Ship CLI remember',
          tokenCount: createTokenCount(5),
          metadata: {
            source: 'ledgermind-cli',
            kind: 'manual_note',
            workspaceScope: '/repo',
            branchScope: 'main',
          },
        },
      ],
    });
  });

  it('renders JSON output for agents', async () => {
    const conversationId = createConversationId('conv_json_remember');
    const runtime: RememberRuntime = {
      engine: {
        append: async () => ({ appendedEvents: [], contextTokenCount: createTokenCount(0) }),
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    const output = await runRememberCommand({
      config: { ...baseConfig, output: 'json' },
      text: 'Remember JSON',
      runtime,
    });

    expect(JSON.parse(output)).toEqual({ ok: true, conversationId: 'conv_json_remember' });
    expect(output.endsWith('\n')).toBe(true);
  });

  it('rejects blank notes and closes an injected runtime', async () => {
    let appendCalled = false;
    let closed = false;
    const runtime: RememberRuntime = {
      engine: {
        append: async () => {
          appendCalled = true;
          return { appendedEvents: [], contextTokenCount: createTokenCount(0) };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId: createConversationId('conv_blank_remember'),
      }),
      close: async () => {
        closed = true;
      },
    };

    await expect(
      runRememberCommand({
        config: baseConfig,
        text: '   ',
        runtime,
      }),
    ).rejects.toThrow('remember requires non-empty text.');
    expect(appendCalled).toBe(false);
    expect(closed).toBe(true);
  });
});

describe('recall command', () => {
  it('renders human grep matches and pagination guidance', async () => {
    const conversationId = createConversationId('conv_recall');
    let grepInput: GrepInput | undefined;
    let closed = false;
    const runtime: RecallRuntime = {
      engine: {
        grep: async (input) => {
          grepInput = input;
          return {
            groups: [
              {
                coveringSummaryId: createSummaryNodeId('sum_recall_1'),
                matches: [
                  {
                    eventId: createEventId('evt_recall_1'),
                    sequence: createSequenceNumber(1),
                    excerpt: 'Ship recall command',
                  },
                  {
                    eventId: createEventId('evt_recall_2'),
                    sequence: createSequenceNumber(2),
                    excerpt: 'Add timeline command',
                  },
                ],
              },
            ],
            page: {
              offset: 0,
              limit: 2,
              returnedMatchCount: 2,
              totalMatchCount: 5,
              hasMore: true,
              nextOffset: 2,
            },
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {
        closed = true;
      },
    };

    const output = await runRecallCommand({
      config: baseConfig,
      query: 'command',
      runtime,
      limit: 2,
    });

    expect(output).toBe(
      '5 matches\n' +
        'Summary: sum_recall_1\n' +
        '[1] evt_recall_1: Ship recall command\n' +
        '[2] evt_recall_2: Add timeline command\n' +
        'More results available at offset 2.\n',
    );
    expect(grepInput).toEqual({
      conversationId,
      pattern: 'command',
      limit: 2,
    });
    expect(closed).toBe(true);
  });

  it('renders JSON grep output for agents', async () => {
    const grepOutput: GrepOutput = {
      groups: [],
      page: {
        offset: 0,
        limit: 25,
        returnedMatchCount: 0,
        totalMatchCount: 0,
        hasMore: false,
      },
    };
    const runtime: RecallRuntime = {
      engine: {
        grep: async () => grepOutput,
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId: createConversationId('conv_json_recall'),
      }),
      close: async () => {},
    };

    const output = await runRecallCommand({
      config: { ...baseConfig, output: 'json' },
      query: 'nothing',
      runtime,
    });

    expect(JSON.parse(output)).toEqual({ ok: true, data: grepOutput });
    expect(output.endsWith('\n')).toBe(true);
  });

  it('rejects blank queries and closes an injected runtime', async () => {
    let grepCalled = false;
    let closed = false;
    const runtime: RecallRuntime = {
      engine: {
        grep: async () => {
          grepCalled = true;
          return {
            groups: [],
            page: {
              offset: 0,
              limit: 25,
              returnedMatchCount: 0,
              totalMatchCount: 0,
              hasMore: false,
            },
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId: createConversationId('conv_blank_recall'),
      }),
      close: async () => {
        closed = true;
      },
    };

    await expect(
      runRecallCommand({
        config: baseConfig,
        query: '   ',
        runtime,
      }),
    ).rejects.toThrow('recall requires a non-empty query.');
    expect(grepCalled).toBe(false);
    expect(closed).toBe(true);
  });
});

describe('timeline command', () => {
  it('fetches the most recent broad-match page', async () => {
    const conversationId = createConversationId('conv_timeline');
    const grep = vi.fn(async (input: GrepInput): Promise<GrepOutput> => {
      if (input.offset === undefined) {
        return {
          groups: [],
          page: {
            offset: 0,
            limit: 1,
            returnedMatchCount: 1,
            totalMatchCount: 40,
            hasMore: true,
            nextOffset: 1,
          },
        };
      }

      return {
        groups: [
          {
            matches: [
              {
                eventId: createEventId('evt_recent'),
                sequence: createSequenceNumber(39),
                excerpt: 'Recent cockpit work',
              },
            ],
          },
        ],
        page: {
          offset: 15,
          limit: 25,
          returnedMatchCount: 25,
          totalMatchCount: 40,
          hasMore: false,
        },
      };
    });
    const runtime: RecallRuntime = {
      engine: { grep },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    const output = await runTimelineCommand({ config: baseConfig, runtime });

    expect(grep).toHaveBeenNthCalledWith(1, {
      conversationId,
      pattern: '.+',
      limit: 1,
    });
    expect(grep).toHaveBeenNthCalledWith(2, {
      conversationId,
      pattern: '.+',
      offset: 15,
      limit: 25,
    });
    expect(output).toContain('[39] evt_recent: Recent cockpit work');
  });
});

describe('explain command', () => {
  it('renders human reference metadata', async () => {
    let describeInput: DescribeInput | undefined;
    let closed = false;
    const runtime: ExplainRuntime = {
      engine: {
        describe: async (input) => {
          describeInput = input;
          return {
            kind: 'artifact',
            metadata: {},
            tokenCount: createTokenCount(34),
            explorationSummary: 'artifact exploration notes',
          };
        },
      },
      close: async () => {
        closed = true;
      },
    };

    const output = await runExplainCommand({
      config: baseConfig,
      id: ' file_explain_1 ',
      runtime,
    });

    expect(output).toBe(
      'Reference file_explain_1\n' +
        'Kind: artifact\n' +
        'Tokens: 34\n' +
        'Summary: artifact exploration notes\n',
    );
    expect(describeInput).toEqual({ id: 'file_explain_1' });
    expect(closed).toBe(true);
  });

  it('renders JSON describe output for agents', async () => {
    const describeOutput = {
      kind: 'summary' as const,
      metadata: { content: 'summary content' },
      tokenCount: createTokenCount(21),
    };
    const runtime: ExplainRuntime = {
      engine: {
        describe: async () => describeOutput,
      },
      close: async () => {},
    };

    const output = await runExplainCommand({
      config: { ...baseConfig, output: 'json' },
      id: 'sum_explain_json',
      runtime,
    });

    expect(JSON.parse(output)).toEqual({ ok: true, data: describeOutput });
    expect(output.endsWith('\n')).toBe(true);
  });

  it('rejects blank ids before creating a default runtime', async () => {
    await expect(
      runExplainCommand({
        config: baseConfig,
        id: '   ',
      }),
    ).rejects.toThrow('explain requires a summary or artifact id.');
  });
});

describe('source command', () => {
  it('refuses to reveal raw messages without confirmation before creating a default runtime', async () => {
    await expect(
      runSourceCommand({
        config: baseConfig,
        summaryId: 'sum_source_refusal',
        confirmed: false,
      }),
    ).rejects.toThrow('source reveals raw remembered messages; rerun with --yes to confirm.');
  });

  it('calls expand with caller context and formats source messages', async () => {
    const conversationId = createConversationId('conv_source');
    const parentConversationId = createConversationId('conv_source_parent');
    let expandInput: ExpandInput | undefined;
    let closed = false;
    const runtime: SourceRuntime = {
      engine: {
        expand: async (input) => {
          expandInput = input;
          return {
            messages: [
              createLedgerEvent({
                id: createEventId('evt_source_1'),
                conversationId,
                sequence: createSequenceNumber(1),
                role: 'user',
                content: 'first raw source',
                tokenCount: createTokenCount(4),
                occurredAt: createTimestamp(new Date('2026-04-27T00:00:00.000Z')),
              }),
              createLedgerEvent({
                id: createEventId('evt_source_2'),
                conversationId,
                sequence: createSequenceNumber(2),
                role: 'assistant',
                content: 'second raw source',
                tokenCount: createTokenCount(4),
                occurredAt: createTimestamp(new Date('2026-04-27T00:00:01.000Z')),
              }),
            ],
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
        parentConversationId,
      }),
      close: async () => {
        closed = true;
      },
    };

    const output = await runSourceCommand({
      config: baseConfig,
      summaryId: ' sum_source_1 ',
      confirmed: true,
      runtime,
    });

    expect(output).toBe('[1] user: first raw source\n[2] assistant: second raw source\n');
    expect(expandInput).toEqual({
      summaryId: createSummaryNodeId('sum_source_1'),
      callerContext: {
        conversationId,
        isSubAgent: true,
        parentConversationId,
      },
    });
    expect(closed).toBe(true);
  });

  it('requires parent conversation lineage before expanding source', async () => {
    let expandCalled = false;
    let closed = false;
    const runtime: SourceRuntime = {
      engine: {
        expand: async () => {
          expandCalled = true;
          return { messages: [] };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId: createConversationId('conv_source_without_parent'),
      }),
      close: async () => {
        closed = true;
      },
    };

    await expect(
      runSourceCommand({
        config: baseConfig,
        summaryId: 'sum_source_without_parent',
        confirmed: true,
        runtime,
      }),
    ).rejects.toThrow(
      'source requires a child runtime binding. Rerun with a fresh --runtime-session and --parent-runtime-session <parent>.',
    );
    expect(expandCalled).toBe(false);
    expect(closed).toBe(true);
  });
});

describe('continuity commands', () => {
  it('renders compact human current state', async () => {
    const conversationId = createConversationId('conv_state_cli');
    const runtime: StateRuntime = {
      engine: {
        getCurrentState: async () => ({
          goalRecords: [
            {
              recordId: 'goal:ship',
              conversationId,
              kind: 'goal',
              status: 'active',
              title: 'Ship continuity CLI',
              content: 'Make state visible.',
              importance: 'high',
              provenance: {},
              relatedRecordIds: [],
              supersedesRecordIds: [],
              createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
              eventId: createEventId('evt_goal_cli'),
            },
          ],
          decisions: [],
          constraints: [],
          progress: [],
          nextSteps: [],
          handoffs: [],
          verification: [
            {
              recordId: 'verification:tests',
              conversationId,
              kind: 'verification',
              status: 'active',
              title: 'Tests passed',
              content: 'pnpm typecheck',
              importance: 'normal',
              provenance: {},
              relatedRecordIds: [],
              supersedesRecordIds: [],
              createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
              eventId: createEventId('evt_verify_cli'),
            },
          ],
          failures: [],
          openQuestions: [],
          artifactChanges: [],
          sessionSummaries: [],
          activeRecordCount: 2,
          staleRecordCount: 0,
        }),
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    const output = await runStateCommand({ config: baseConfig, runtime });

    expect(output).toBe(
      'Current state\n' +
        'Goal\n' +
        '- Ship continuity CLI\n' +
        'Evidence\n' +
        '- evt_goal_cli\n' +
        '- evt_verify_cli\n',
    );
  });

  it('renders JSON current state for agents', async () => {
    const runtime: StateRuntime = {
      engine: {
        getCurrentState: async () => ({
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
        }),
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId: createConversationId('conv_state_json'),
      }),
      close: async () => {},
    };

    const output = await runStateCommand({ config: { ...baseConfig, output: 'json' }, runtime });

    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { activeRecordCount: 0 } });
  });

  it('shows active next steps', async () => {
    const conversationId = createConversationId('conv_next_cli');
    const runtime: NextRuntime = {
      engine: {
        getNextSteps: async () => ({
          nextSteps: [
            {
              recordId: 'next:bind',
              conversationId,
              kind: 'next_step',
              status: 'active',
              title: 'Bind tools',
              content: 'Update MCP session binding.',
              importance: 'normal',
              provenance: {},
              relatedRecordIds: [],
              supersedesRecordIds: [],
              createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
              eventId: createEventId('evt_next_cli'),
            },
          ],
        }),
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    const output = await runNextCommand({ config: baseConfig, runtime });

    expect(output).toBe('Next steps\n- Bind tools: Update MCP session binding.\n');
  });

  it('recalls continuity for a task prompt', async () => {
    const conversationId = createConversationId('conv_task_cli');
    const runtime: TaskRuntime = {
      engine: {
        recallForTask: async (input) => {
          expect(input).toEqual({
            conversationId,
            task: 'Fix failing auth tests',
            budgetTokens: 1200,
            includeHandoff: true,
            includeEvidence: true,
          });
          return {
            contextBlock: 'LedgerMind current state\n\nGoal:\n- Fix tests',
            currentState: {
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
            },
            recalledSummaryIds: [],
            recalledArtifactIds: [],
            recalledEventIds: [],
            why: [],
            budgetUsed: createTokenCount(8),
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    const output = await runTaskCommand({
      config: baseConfig,
      prompt: 'Fix failing auth tests',
      runtime,
    });

    expect(output).toBe('LedgerMind current state\n\nGoal:\n- Fix tests\n');
  });

  it('records decision, progress, and verification continuity', async () => {
    const conversationId = createConversationId('conv_record_continuity_cli');
    const calls: string[] = [];
    const runtime: RecordContinuityRuntime = {
      engine: {
        recordContinuity: async (input) => {
          calls.push(`${input.kind}:${input.title}`);
          return {
            record: {
              recordId: `${input.kind}:cli`,
              conversationId: input.conversationId,
              kind: input.kind,
              status: 'active',
              title: input.title,
              content: input.content,
              importance: input.importance ?? 'normal',
              provenance: {},
              relatedRecordIds: [],
              supersedesRecordIds: [],
              createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
              eventId: createEventId(`evt_${input.kind}_cli`),
            },
            contextTokenCount: createTokenCount(5),
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    expect(await runDecisionCommand({ config: baseConfig, text: 'Use MCP binding', runtime })).toBe(
      'Recorded decision decision:cli in conv_record_continuity_cli.\n',
    );
    expect(await runProgressCommand({ config: baseConfig, text: 'Task 9 complete', runtime })).toBe(
      'Recorded progress progress:cli in conv_record_continuity_cli.\n',
    );
    expect(
      await runVerifyCommand({ config: baseConfig, text: 'pnpm typecheck passed', runtime }),
    ).toBe('Recorded verification verification:cli in conv_record_continuity_cli.\n');
    expect(calls).toEqual([
      'decision:Use MCP binding',
      'progress:Task 9 complete',
      'verification:pnpm typecheck passed',
    ]);
  });

  it('creates handoff and marks stale records', async () => {
    const conversationId = createConversationId('conv_handoff_stale_cli');
    const handoffRuntime: HandoffRuntime = {
      engine: {
        createHandoff: async (input) => {
          expect(input.conversationId).toBe(conversationId);
          expect(input.completed).toEqual([input.goal]);
          expect(input.nextSteps).toEqual([]);
          return {
            handoff: {
              recordId: 'handoff:cli',
              conversationId,
              kind: 'handoff',
              status: 'active',
              title: 'Continue: Resume CLI wiring',
              content: 'Resume CLI wiring',
              importance: 'normal',
              provenance: {},
              relatedRecordIds: [],
              supersedesRecordIds: [],
              createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
              eventId: createEventId('evt_handoff_cli'),
            },
            nextStepRecords: [],
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };
    const staleRuntime: StaleRuntime = {
      engine: {
        markContinuityRecord: async (input) => {
          expect(input).toEqual({
            conversationId,
            recordId: 'decision:old',
            status: 'stale',
            reason: 'Marked stale from CLI.',
          });
          return {
            marker: {
              recordId: 'marker:stale',
              conversationId,
              kind: 'session_summary',
              status: 'stale',
              title: 'Mark decision:old stale',
              content: 'Marked stale from CLI.',
              importance: 'normal',
              provenance: {},
              relatedRecordIds: ['decision:old'],
              supersedesRecordIds: ['decision:old'],
              createdAt: createTimestamp(new Date('2026-04-29T00:00:00.000Z')),
              eventId: createEventId('evt_stale_cli'),
            },
          };
        },
      },
      resolveBinding: async () => ({
        runtime: 'ledgermind-cli',
        runtimeSessionId: 'workspace',
        userScope: 'khoi',
        workspaceScope: '/repo',
        conversationId,
      }),
      close: async () => {},
    };

    expect(
      await runHandoffCommand({
        config: baseConfig,
        text: 'Resume CLI wiring',
        runtime: handoffRuntime,
      }),
    ).toBe('Created handoff handoff:cli in conv_handoff_stale_cli.\n');
    expect(
      await runHandoffCommand({
        config: baseConfig,
        text: '',
        readStdin: async () => 'Resume from stdin',
        runtime: handoffRuntime,
      }),
    ).toBe('Created handoff handoff:cli in conv_handoff_stale_cli.\n');
    expect(
      await runStaleCommand({
        config: baseConfig,
        recordId: 'decision:old',
        runtime: staleRuntime,
      }),
    ).toBe('Marked decision:old stale in conv_handoff_stale_cli.\n');
  });
});

describe('runCli command dispatch', () => {
  it('runs status with parsed shared options', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ledgermind-cli-'));
    const stdout = new RecordingWritable();

    try {
      const exitCode = await runCli({
        argv: [
          'status',
          '--json',
          '--binding-store',
          join(tempDir, 'bindings.json'),
          '--workspace',
          '/repo',
          '--runtime-session',
          'runtime-1',
          '--branch',
          'main',
        ],
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.toString())).toMatchObject({
        ok: true,
        bindingCount: 0,
        runtimeSessionId: 'runtime-1',
        workspaceScope: '/repo',
        branchScope: 'main',
      });
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('runs commands after a forwarded option terminator', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ledgermind-cli-'));
    const stdout = new RecordingWritable();

    try {
      const exitCode = await runCli({
        argv: ['--', 'status', '--binding-store', join(tempDir, 'bindings.json')],
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toContain('LedgerMind status');
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('runs doctor without requiring postgres', async () => {
    await withoutLedgermindDbUrl(async () => {
      const stdout = new RecordingWritable();

      const exitCode = await runCli({
        argv: ['doctor', '--binding-store', '/repo/.ledgermind/session-bindings.json'],
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toContain('LedgerMind doctor');
      expect(stdout.toString()).toContain('Postgres: not configured');
    });
  });

  it('accepts source confirmation as a shared no-op option before dispatch', async () => {
    await withoutLedgermindDbUrl(async () => {
      const stdout = new RecordingWritable();
      const stderr = new RecordingWritable();

      const exitCode = await runCli({
        argv: ['source', 'sum_source_cli', '--yes'],
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stdout.toString()).toBe('');
      expect(stderr.toString()).toBe(
        'Memory commands need --db or LEDGERMIND_DB_URL for durable storage. Run ledgermind doctor for setup help.\n',
      );
    });
  }, 15_000);
});
