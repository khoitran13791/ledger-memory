import {
  createArtifact,
  createMimeType,
  type HashPort,
  type IdService,
  type MimeType,
  type TokenCount,
} from '@ledgermind/domain';

import {
  ConversationNotFoundError,
  InvalidTokenizerOutputError,
  type TokenizerOperation,
} from '../errors/application-errors';
import type { EventPublisherPort } from '../ports/driven/events/event-publisher.port';
import type { FileReaderPort } from '../ports/driven/filesystem/file-reader.port';
import type { TokenizerPort } from '../ports/driven/llm/tokenizer.port';
import type { UnitOfWorkPort } from '../ports/driven/persistence/unit-of-work.port';
import type {
  ArtifactSource,
  StoreArtifactInput,
  StoreArtifactOutput,
} from '../ports/driving/memory-engine.port';

const textEncoder = new TextEncoder();

interface PreparedArtifactSource {
  readonly storageKind: 'path' | 'inline_text' | 'inline_binary';
  readonly originalPath: string | null;
  readonly content: string | Uint8Array | undefined;
  readonly contentHashHex: string;
  readonly tokenCount: TokenCount;
}

const getDefaultMimeType = (source: ArtifactSource): MimeType => {
  if (source.kind === 'text') {
    return createMimeType('text/plain');
  }

  return createMimeType('application/octet-stream');
};

const describeTokenizerOutput = (output: unknown): string => {
  if (output === null) {
    return 'null';
  }

  if (output === undefined) {
    return 'undefined';
  }

  if (typeof output === 'number') {
    return Number.isNaN(output) ? 'number(NaN)' : `number(${output})`;
  }

  if (typeof output === 'object') {
    if ('value' in output) {
      const rawValue = (output as { readonly value?: unknown }).value;
      if (typeof rawValue === 'number') {
        return Number.isNaN(rawValue)
          ? 'TokenCount.value(number(NaN))'
          : `TokenCount.value(number(${rawValue}))`;
      }
      return `TokenCount.value(${String(rawValue)})`;
    }

    return 'object(without value field)';
  }

  return typeof output;
};

const validateTokenizerTokenCount = (
  output: unknown,
  tokenizer: string,
  operation: TokenizerOperation,
): TokenCount => {
  if (typeof output !== 'object' || output === null || !('value' in output)) {
    throw new InvalidTokenizerOutputError(tokenizer, operation, describeTokenizerOutput(output));
  }

  const tokenValue = (output as { readonly value: unknown }).value;

  if (
    typeof tokenValue !== 'number' ||
    !Number.isFinite(tokenValue) ||
    !Number.isSafeInteger(tokenValue) ||
    tokenValue < 0
  ) {
    throw new InvalidTokenizerOutputError(tokenizer, operation, describeTokenizerOutput(output));
  }

  return output as TokenCount;
};

const getTokenizerName = (tokenizer: TokenizerPort): string => {
  return tokenizer.constructor.name || 'TokenizerPort';
};

const countTokensSafely = (
  tokenizer: TokenizerPort,
  operation: TokenizerOperation,
  input: string | number,
): TokenCount => {
  if (operation === 'countTokens') {
    return validateTokenizerTokenCount(
      tokenizer.countTokens(input as string),
      getTokenizerName(tokenizer),
      operation,
    );
  }

  return validateTokenizerTokenCount(
    tokenizer.estimateFromBytes(input as number),
    getTokenizerName(tokenizer),
    operation,
  );
};

const prepareArtifactSource = async (
  source: ArtifactSource,
  hashPort: HashPort,
  tokenizer: TokenizerPort,
  fileReader?: FileReaderPort,
): Promise<PreparedArtifactSource> => {
  if (source.kind === 'text') {
    const contentBytes = textEncoder.encode(source.content);

    return {
      storageKind: 'inline_text',
      originalPath: null,
      content: source.content,
      contentHashHex: hashPort.sha256(contentBytes),
      tokenCount: countTokensSafely(tokenizer, 'countTokens', source.content),
    };
  }

  if (source.kind === 'binary') {
    return {
      storageKind: 'inline_binary',
      originalPath: null,
      content: source.data,
      contentHashHex: hashPort.sha256(source.data),
      tokenCount: countTokensSafely(tokenizer, 'estimateFromBytes', source.data.byteLength),
    };
  }

  if (fileReader) {
    const fileBytes = await fileReader.readBytes(source.path);
    return {
      storageKind: 'path',
      originalPath: source.path,
      content: fileBytes,
      contentHashHex: hashPort.sha256(fileBytes),
      tokenCount: countTokensSafely(tokenizer, 'estimateFromBytes', fileBytes.byteLength),
    };
  }

  // Fallback: hash the path itself (not truly content-addressed)
  const pathBytes = textEncoder.encode(source.path);

  return {
    storageKind: 'path',
    originalPath: source.path,
    content: undefined,
    contentHashHex: hashPort.sha256(textEncoder.encode(`path:${source.path}`)),
    tokenCount: countTokensSafely(tokenizer, 'estimateFromBytes', pathBytes.byteLength),
  };
};

export interface StoreArtifactUseCaseDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly idService: IdService;
  readonly hashPort: HashPort;
  readonly tokenizer: TokenizerPort;
  readonly fileReader?: FileReaderPort;
  readonly eventPublisher?: EventPublisherPort;
}

export class StoreArtifactUseCase {
  constructor(private readonly deps: StoreArtifactUseCaseDeps) {}

  async execute(input: StoreArtifactInput): Promise<StoreArtifactOutput> {
    const preparedSource = await prepareArtifactSource(
      input.source,
      this.deps.hashPort,
      this.deps.tokenizer,
      this.deps.fileReader,
    );

    const output = await this.deps.unitOfWork.execute(async (uow) => {
      const conversation = await uow.conversations.get(input.conversationId);
      if (conversation === null) {
        throw new ConversationNotFoundError(input.conversationId);
      }

      const artifactId = this.deps.idService.generateArtifactId({
        contentHashHex: preparedSource.contentHashHex,
      });

      const artifact = createArtifact({
        id: artifactId,
        conversationId: input.conversationId,
        storageKind: preparedSource.storageKind,
        ...(preparedSource.originalPath === null
          ? {}
          : {
              originalPath: preparedSource.originalPath,
            }),
        mimeType: input.mimeType ?? getDefaultMimeType(input.source),
        tokenCount: preparedSource.tokenCount,
      });

      await uow.artifacts.store(artifact, preparedSource.content);

      return {
        artifactId: artifact.id,
        tokenCount: artifact.tokenCount,
      };
    });

    this.deps.eventPublisher?.publish({
      type: 'ArtifactStored',
      conversationId: input.conversationId,
      artifactId: output.artifactId,
      storageKind: preparedSource.storageKind,
      tokenCount: output.tokenCount,
    });

    return output;
  }
}
