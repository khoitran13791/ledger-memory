import {
  createArtifact,
  createMimeType,
  createTokenCount,
  serializeCanonicalJson,
  type HashPort,
  type IdService,
} from '@ledgermind/domain';

import {
  ConversationNotFoundError,
  OperatorInputValidationError,
} from '../errors/application-errors';
import type { ClockPort } from '../ports/driven/clock/clock.port';
import type { JobQueuePort } from '../ports/driven/jobs/job-queue.port';
import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
import type { UnitOfWorkPort } from '../ports/driven/persistence/unit-of-work.port';
import type { LLMMapInput, LLMMapOutput } from '../ports/driving/operator-execution.port';
import { createOperatorConfig, type OperatorConfig } from './operators/shared/operator-config';
import { loadOperatorDataset } from './operators/shared/input-dataset';

const textEncoder = new TextEncoder();

const createRunId = (input: { readonly conversationId: string; readonly digest: string }): string => {
  return `run_${input.conversationId}_${input.digest.slice(0, 16)}`;
};

const normalizeRetryPolicy = (
  retryPolicy: LLMMapInput['retryPolicy'],
): LLMMapInput['retryPolicy'] => ({
  maxRetries: retryPolicy.maxRetries,
  retryBackoffSeconds: retryPolicy.retryBackoffSeconds,
});

const validateInput = (input: LLMMapInput, config: OperatorConfig): void => {
  if (input.prompt.trim().length === 0) {
    throw new OperatorInputValidationError('prompt is required.');
  }

  if (input.concurrencyLimit < 1 || input.concurrencyLimit > config.maxConcurrencyLimit) {
    throw new OperatorInputValidationError('concurrencyLimit is out of range.');
  }

  if (!Number.isSafeInteger(input.retryPolicy.maxRetries) || input.retryPolicy.maxRetries < 0) {
    throw new OperatorInputValidationError('retryPolicy.maxRetries must be a non-negative safe integer.');
  }

  if (
    !Number.isSafeInteger(input.retryPolicy.retryBackoffSeconds) ||
    input.retryPolicy.retryBackoffSeconds < 1
  ) {
    throw new OperatorInputValidationError('retryPolicy.retryBackoffSeconds must be a positive safe integer.');
  }
};

const buildNormalizedSubmitPayload = (
  input: LLMMapInput,
  canonicalDatasetJson: string,
  retryPolicy: LLMMapInput['retryPolicy'],
): string => {
  return serializeCanonicalJson({
    operatorKind: 'llmMap',
    conversationId: input.conversationId,
    prompt: input.prompt,
    outputSchema: input.outputSchema,
    concurrencyLimit: input.concurrencyLimit,
    retryPolicy,
    dataset: JSON.parse(canonicalDatasetJson),
  });
};

export interface LLMMapUseCaseDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly idService: IdService;
  readonly hashPort: HashPort;
  readonly tokenizer: TokenizerPort;
  readonly clock: ClockPort;
  readonly jobQueue?: JobQueuePort;
  readonly config?: Partial<OperatorConfig>;
}

export class LLMMapUseCase {
  private readonly config: OperatorConfig;

  constructor(private readonly deps: LLMMapUseCaseDeps) {
    this.config = createOperatorConfig(deps.config);
  }

  async execute(input: LLMMapInput): Promise<LLMMapOutput> {
    validateInput(input, this.config);
    const normalizedRetryPolicy = normalizeRetryPolicy(input.retryPolicy);

    let wakeHint:
      | {
          readonly type: 'operator-run-created';
          readonly payload: {
            readonly runId: string;
            readonly conversationId: string;
          };
          readonly priority: 'normal';
        }
      | undefined;

    return this.deps.unitOfWork.execute(async (uow) => {
      const conversation = await uow.conversations.get(input.conversationId);
      if (conversation === null) {
        throw new ConversationNotFoundError(input.conversationId);
      }

      const datasetSource = {
        conversationId: input.conversationId,
        ...(input.items === undefined ? {} : { items: input.items }),
        ...(input.inputArtifactId === undefined
          ? {}
          : { inputArtifactId: input.inputArtifactId }),
      };
      const dataset = await loadOperatorDataset(
        datasetSource,
        {
          artifactStore: uow.artifacts,
          conversations: uow.conversations,
        },
        input.items === undefined
          ? undefined
          : {
              maxInlineOperatorInputBytes: this.config.maxInlineOperatorInputBytes,
            },
      );

      const normalizedInputPayload = buildNormalizedSubmitPayload(
        input,
        dataset.canonicalDatasetJson,
        normalizedRetryPolicy,
      );
      const normalizedInputDigest = this.deps.hashPort.sha256(
        textEncoder.encode(normalizedInputPayload),
      );
      const runId = createRunId({
        conversationId: input.conversationId,
        digest: normalizedInputDigest,
      });

      let inputArtifactId = input.inputArtifactId;
      if (inputArtifactId === undefined) {
        const contentHashHex = this.deps.hashPort.sha256(
          textEncoder.encode(dataset.canonicalDatasetJson),
        );
        inputArtifactId = this.deps.idService.generateArtifactId({ contentHashHex });
        const artifact = createArtifact({
          id: inputArtifactId,
          conversationId: input.conversationId,
          storageKind: 'inline_text',
          mimeType: createMimeType('application/json'),
          tokenCount: createTokenCount(this.deps.tokenizer.countTokens(dataset.canonicalDatasetJson).value),
        });
        await uow.artifacts.store(artifact, dataset.canonicalDatasetJson);
      }

      const run = await uow.operators.createRunWithTasks({
        runId,
        operatorKind: 'llmMap',
        conversationId: input.conversationId,
        taskCount: dataset.items.length,
        prompt: input.prompt,
        outputSchema: input.outputSchema,
        concurrencyLimit: input.concurrencyLimit,
        retryPolicy: normalizedRetryPolicy,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        normalizedInputDigest,
        inputArtifactId,
        items: dataset.items,
      });

      if (dataset.items.length === 0) {
        const emptyContent = '';
        const emptyOutputArtifactId = this.deps.idService.generateArtifactId({
          contentHashHex: this.deps.hashPort.sha256(textEncoder.encode(emptyContent)),
        });
        const outputArtifact = createArtifact({
          id: emptyOutputArtifactId,
          conversationId: input.conversationId,
          storageKind: 'inline_text',
          mimeType: createMimeType('application/x-ndjson'),
          tokenCount: createTokenCount(0),
        });
        await uow.artifacts.store(outputArtifact, emptyContent);
        const finalizedRun = await uow.operators.finalizeRun({
          runId: run.runId,
          status: 'completed',
          completedAt: this.deps.clock.now(),
          outputArtifactId: emptyOutputArtifactId,
        });

        return {
          runId: finalizedRun.runId,
          status: finalizedRun.status,
          inputArtifactId,
        };
      }

      if (this.deps.jobQueue !== undefined) {
        wakeHint = {
          type: 'operator-run-created',
          payload: {
            runId: run.runId,
            conversationId: input.conversationId,
          },
          priority: 'normal',
        };
      }

      return {
        runId: run.runId,
        status: run.status,
        inputArtifactId,
      };
    }).then(async (result) => {
      if (wakeHint !== undefined && this.deps.jobQueue !== undefined) {
        void this.deps.jobQueue.enqueue(wakeHint).catch(() => undefined);
      }
      return result;
    });
  }
}
