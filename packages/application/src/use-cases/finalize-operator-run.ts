import {
  createArtifact,
  createMimeType,
  createTokenCount,
  createLedgerEvent,
  serializeCanonicalJson,
  type HashPort,
  type IdService,
} from '@ledgermind/domain';

import {
  ConversationNotFoundError,
  OperatorFinalizationError,
  OperatorRunNotFoundError,
} from '../errors/application-errors';
import type { ClockPort } from '../ports/driven/clock/clock.port';
import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
import type { UnitOfWorkPort } from '../ports/driven/persistence/unit-of-work.port';
import type { StoredOperatorTask } from '../ports/driven/persistence/operator-execution.port';
import type { OperatorFailureMetadata, OperatorResultEntry, OperatorRunStatus } from '../ports/driving/operator-execution.port';
import { createFailedResultEntry, createSucceededResultEntry } from './operators/shared/result-entry';

const textEncoder = new TextEncoder();
const HANDLE_IDEMPOTENCY_METADATA_FIELD = '__ledgermind_idempotencyKey';
const HANDLE_IDEMPOTENCY_DIGEST_METADATA_FIELD = '__ledgermind_idempotencyDigest';

export interface FinalizeOperatorRunInput {
  readonly runId?: string;
}

export interface FinalizeOperatorRunUseCaseDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly idService: IdService;
  readonly hashPort: HashPort;
  readonly tokenizer: TokenizerPort;
  readonly clock: ClockPort;
}

const isTerminalTask = (task: StoredOperatorTask): boolean => {
  return task.status === 'succeeded' || task.status === 'failed';
};

const toTerminalFailure = (failure: OperatorFailureMetadata | undefined, task: StoredOperatorTask): OperatorFailureMetadata => {
  if (failure === undefined) {
    return {
      code: 'UNKNOWN',
      message: 'Unknown operator failure.',
      retryable: false,
      attemptCount: task.attemptCount,
    };
  }

  return {
    ...failure,
    retryable: false,
    attemptCount: failure.attemptCount ?? task.attemptCount,
  };
};

const createResultEntry = (task: StoredOperatorTask & { readonly output?: unknown }): OperatorResultEntry => {
  if (task.status === 'succeeded') {
    return createSucceededResultEntry(task.itemIndex, task.output);
  }

  return createFailedResultEntry(task.itemIndex, toTerminalFailure(task.terminalFailure, task));
};

const createJsonlContent = (entries: readonly OperatorResultEntry[]): string => {
  return entries
    .map((entry) => {
      if (entry.status === 'succeeded') {
        return JSON.stringify(entry);
      }

      return JSON.stringify({
        itemIndex: entry.itemIndex,
        status: entry.status,
        error: {
          code: entry.error.code,
          message: entry.error.message,
          retryable: false,
          attemptCount: entry.error.attemptCount,
        },
      });
    })
    .join('\n') + (entries.length === 0 ? '' : '\n');
};

const deriveRunStatus = (entries: readonly OperatorResultEntry[]): OperatorRunStatus => {
  const failedCount = entries.filter((entry) => entry.status === 'failed').length;
  if (failedCount === 0) {
    return 'completed';
  }

  if (failedCount === entries.length) {
    return 'failed';
  }

  return 'completed_with_failures';
};

const selectTerminalFailureSummary = (entries: readonly OperatorResultEntry[]): OperatorFailureMetadata | undefined => {
  const failedEntry = entries.find((entry) => entry.status === 'failed');
  if (failedEntry === undefined || failedEntry.status !== 'failed') {
    return undefined;
  }

  return failedEntry.error;
};

const createHandleContent = (input: {
  readonly runId: string;
  readonly outputArtifactId: string;
  readonly status: OperatorRunStatus;
  readonly taskCount: number;
  readonly failedTaskCount: number;
}): string => {
  return JSON.stringify({
    type: 'operator_run_handle',
    operator: 'llmMap',
    runId: input.runId,
    status: input.status,
    outputArtifactId: input.outputArtifactId,
    taskCount: input.taskCount,
    failedTaskCount: input.failedTaskCount,
  });
};

export class FinalizeOperatorRunUseCase {
  constructor(private readonly deps: FinalizeOperatorRunUseCaseDeps) {}

  async execute(input: FinalizeOperatorRunInput = {}): Promise<{
    readonly runId: string;
    readonly status: OperatorRunStatus;
    readonly outputArtifactId?: string;
  }> {
    return this.deps.unitOfWork.execute(async (uow) => {
      const run = input.runId === undefined
        ? await uow.operators.claimRunForFinalizationRetry({
            workerId: 'finalize-operator-run',
            now: this.deps.clock.now(),
          })
        : await uow.operators.getRun(input.runId);

      if (run === null) {
        throw new OperatorRunNotFoundError(input.runId ?? 'pending-finalization');
      }

      const conversation = await uow.conversations.get(run.conversationId);
      if (conversation === null) {
        throw new ConversationNotFoundError(run.conversationId);
      }

      const tasks = (await uow.operators.listTasksForRun(run.runId)) as readonly (StoredOperatorTask & {
        readonly output?: unknown;
      })[];
      if (!tasks.every((task) => isTerminalTask(task))) {
        throw new OperatorFinalizationError(run.runId, run.finalizationStage, 'All operator tasks must be terminal before finalization.');
      }

      const orderedEntries = [...tasks]
        .sort((left, right) => left.itemIndex - right.itemIndex)
        .map((task) => createResultEntry(task));

      let outputArtifactId = run.outputArtifactId;
      if (run.finalizationStage === 'not_started') {
        const jsonlContent = createJsonlContent(orderedEntries);
        const contentHashHex = this.deps.hashPort.sha256(textEncoder.encode(jsonlContent));
        outputArtifactId = this.deps.idService.generateArtifactId({ contentHashHex });
        const artifact = createArtifact({
          id: outputArtifactId,
          conversationId: run.conversationId,
          storageKind: 'inline_text',
          mimeType: createMimeType('application/x-ndjson'),
          tokenCount: createTokenCount(this.deps.tokenizer.countTokens(jsonlContent).value),
        });
        await uow.artifacts.store(artifact, jsonlContent);
        await uow.operators.advanceFinalizationStage({
          runId: run.runId,
          from: 'not_started',
          to: 'artifact_written',
        });
      }

      if (outputArtifactId === undefined) {
        throw new OperatorFinalizationError(run.runId, run.finalizationStage, 'Output artifact id is required before terminal finalization.');
      }

      const currentRun = await uow.operators.getRun(run.runId);
      const stage = currentRun?.finalizationStage ?? run.finalizationStage;
      if (stage === 'artifact_written') {
        const handleContent = createHandleContent({
          runId: run.runId,
          outputArtifactId,
          status: deriveRunStatus(orderedEntries),
          taskCount: orderedEntries.length,
          failedTaskCount: orderedEntries.filter((entry) => entry.status === 'failed').length,
        });
        const idempotencyKey = `operator-run-handle:${run.runId}`;
        const idempotencyDigest = this.deps.hashPort.sha256(
          textEncoder.encode(
            serializeCanonicalJson({
              runId: run.runId,
              outputArtifactId,
              content: handleContent,
            }),
          ),
        );
        const sequence = await uow.ledger.getNextSequence(run.conversationId);
        const event = createLedgerEvent({
          id: this.deps.idService.generateEventId({
            content: handleContent,
            conversationId: run.conversationId,
            role: 'assistant',
            sequence,
          }),
          conversationId: run.conversationId,
          sequence,
          role: 'assistant',
          content: handleContent,
          tokenCount: this.deps.tokenizer.countTokens(handleContent),
          occurredAt: this.deps.clock.now(),
          metadata: {
            [HANDLE_IDEMPOTENCY_METADATA_FIELD]: idempotencyKey,
            [HANDLE_IDEMPOTENCY_DIGEST_METADATA_FIELD]: idempotencyDigest,
          },
        });
        await uow.ledger.appendEvents(run.conversationId, [event]);
        await uow.operators.advanceFinalizationStage({
          runId: run.runId,
          from: 'artifact_written',
          to: 'handle_appended',
        });
      }

      const terminalFailureSummary = selectTerminalFailureSummary(orderedEntries);
      const finalized = await uow.operators.finalizeRun({
        runId: run.runId,
        status: deriveRunStatus(orderedEntries),
        completedAt: this.deps.clock.now(),
        outputArtifactId,
        ...(terminalFailureSummary === undefined ? {} : { terminalFailureSummary }),
      });

      return {
        runId: finalized.runId,
        status: finalized.status,
        ...(finalized.outputArtifactId === undefined ? {} : { outputArtifactId: finalized.outputArtifactId }),
      };
    });
  }
}
