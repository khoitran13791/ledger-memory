import {
  AppendLedgerEventsUseCase,
  CheckIntegrityUseCase,
  DescribeUseCase,
  ExpandUseCase,
  ExploreArtifactUseCase,
  GrepUseCase,
  MaterializeContextUseCase,
  RunCompactionUseCase,
  StoreArtifactUseCase,
  type ArtifactStorePort,
  type ContextProjectionPort,
  type ConversationPort,
  type LedgerReadPort,
  type MemoryEngine,
  type SummarizerPort,
  type SummaryDagPort,
  type UnitOfWorkPort,
} from '@ledgermind/application';
import {
  createDefaultExplorerRegistry,
  createInMemoryPersistenceState,
  InMemoryArtifactStore,
  InMemoryContextProjection,
  InMemoryConversationStore,
  InMemoryLedgerStore,
  InMemorySummaryDag,
  InMemoryUnitOfWork,
  SubAgentAuthorizationAdapter,
  TiktokenTokenizerAdapter,
  ValidatingTokenizerAdapter,
} from '@ledgermind/adapters';
import {
  createCompactionThresholds,
  createConversationConfig,
  createIdService,
  createTimestamp,
  createTokenCount,
  type ConversationId,
  type HashPort,
  type MessageRole,
} from '@ledgermind/domain';

import type {
  FairnessConfig,
  LedgermindSummarizationTraceEntry,
  LocomoConversationSample,
  LocomoRuntimeMode,
  LocomoRuntimeProvenance,
  LocomoSummarizerType,
} from './types.js';
import { buildContextLines, extractTurns, hasArtifactLikeContent, mapSpeakersToRoles } from './conversation.js';

interface RuntimeDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledgerRead: LedgerReadPort;
  readonly contextProjection: ContextProjectionPort;
  readonly summaryDag: SummaryDagPort;
  readonly artifactStore: ArtifactStorePort;
  readonly conversations: ConversationPort;
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

const sharedTokenizer = new ValidatingTokenizerAdapter(new TiktokenTokenizerAdapter({ model: 'gpt-4o-mini' }), {
  tokenizerName: 'TiktokenTokenizerAdapter(gpt-4o-mini)',
});

const DETERMINISTIC_SUMMARIZER_TYPE: LocomoSummarizerType = 'locomo_deterministic_head_tail_v1';
const LLM_STRUCTURED_SUMMARIZER_TYPE: LocomoSummarizerType = 'locomo_llm_structured_v1';

interface LocomoSummarizationTraceCollector {
  record(entry: LedgermindSummarizationTraceEntry): void;
}

interface LlmSummarizerDeps {
  readonly modelName: string;
  readonly llmBaseUrl: string;
  readonly llmApiKey: string | undefined;
  readonly llmTimeoutMs: number;
}

interface RuntimeSummarizerSelectionInput {
  readonly summarizerType: LocomoSummarizerType;
  readonly traceCollector: LocomoSummarizationTraceCollector;
  readonly llm: Omit<LlmSummarizerDeps, 'llmBaseUrl'> & { readonly llmBaseUrl: string | undefined };
}

interface StructuredSummaryFact {
  readonly role: string;
  readonly date: string;
  readonly speaker: string;
  readonly fact: string;
  readonly anchor: string;
}

interface StructuredSummaryPayload {
  readonly entities: readonly string[];
  readonly dates: readonly string[];
  readonly commitments: readonly string[];
  readonly outcomes: readonly string[];
  readonly lexicalAnchors: readonly string[];
  readonly messageFacts: readonly StructuredSummaryFact[];
}

const toHeadTailMessages = (input: {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly limit: number;
}): readonly { readonly role: string; readonly content: string }[] => {
  const headCount = Math.min(input.limit, Math.ceil(input.limit / 2));
  const tailCount = Math.max(0, input.limit - headCount);
  const head = input.messages.slice(0, headCount);
  const tail = tailCount === 0 ? [] : input.messages.slice(-tailCount);
  const deduped: { role: string; content: string }[] = [];
  const seen = new Set<string>();

  for (const message of [...head, ...tail]) {
    const key = `${message.role}::${message.content}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({ role: message.role, content: message.content });
  }

  return deduped;
};

const toDeterministicSummaryLine = (message: { readonly role: string; readonly content: string }): string => {
  const dateMatch = message.content.match(/DATE:\s*([^|]+)/);
  const speakerMatch = message.content.match(/\|\s*ID:[^|]*\|\s*([^:]+):/);
  const sharedMatch = message.content.match(/\[shared\s+([^\]]+)\]/);
  const sharedCaptionMatch = message.content.match(/\[shared_caption\s+([^\]]+)\]/);

  const firstClause = message.content
    .split(/[.!?\n]/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  const parts = [
    `[${message.role}]`,
    dateMatch?.[1]?.trim(),
    speakerMatch?.[1]?.trim(),
    firstClause,
    sharedMatch?.[1] === undefined ? undefined : `shared:${sharedMatch[1].trim()}`,
    sharedCaptionMatch?.[1] === undefined ? undefined : `shared_caption:${sharedCaptionMatch[1].trim()}`,
  ].filter((part): part is string => part !== undefined && part.length > 0);

  return parts.join(' | ');
};

const createDeterministicHeadTailSummarizer = (input: {
  readonly traceCollector: LocomoSummarizationTraceCollector;
}): SummarizerPort => {
  let summarizeCallCount = 0;

  return {
    summarize: async (summarizationInput) => {
      summarizeCallCount += 1;

      const limit = summarizationInput.mode === 'normal' ? 8 : 4;
      const deduped = toHeadTailMessages({
        messages: summarizationInput.messages,
        limit,
      });

      const lines = deduped.map((message) => toDeterministicSummaryLine(message));
      const prefix = summarizationInput.mode === 'normal' ? '[Summary]' : '[Aggressive Summary]';
      const content = `${prefix}\nsummary_call:${summarizeCallCount}\n${lines.join('\n')}`;
      const tokenCount = sharedTokenizer.countTokens(content);
      const preservedArtifactIds = summarizationInput.artifactIdsToPreserve;

      input.traceCollector.record({
        summarizerType: DETERMINISTIC_SUMMARIZER_TYPE,
        mode: summarizationInput.mode,
        ...(summarizationInput.targetTokens === undefined ? {} : { targetTokens: summarizationInput.targetTokens }),
        messageCount: summarizationInput.messages.length,
        outputContent: content,
        outputTokenCount: tokenCount.value,
        preservedArtifactIds: preservedArtifactIds.map((artifactId) => String(artifactId)),
      });

      return {
        content,
        tokenCount,
        preservedArtifactIds,
      };
    },
  };
};

const toOpenAiMessage = (input: {
  readonly systemInstruction: string;
  readonly userPrompt: string;
}): readonly { readonly role: 'system' | 'user'; readonly content: string }[] => {
  return [
    {
      role: 'system',
      content: input.systemInstruction,
    },
    {
      role: 'user',
      content: input.userPrompt,
    },
  ];
};

const postJson = async (input: {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly body: Record<string, unknown>;
}): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (input.apiKey !== undefined && input.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${input.apiKey}`;
    }

    const response = await fetch(input.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} at ${input.url}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const parseChatCompletionsText = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const root = payload as {
    readonly choices?: readonly {
      readonly message?: {
        readonly content?: unknown;
      };
    }[];
  };

  const content = root.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim();
  }

  return undefined;
};

const parseResponsesText = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const root = payload as {
    readonly output_text?: unknown;
    readonly output?: readonly {
      readonly content?: readonly { readonly text?: unknown }[];
    }[];
  };

  if (typeof root.output_text === 'string' && root.output_text.trim().length > 0) {
    return root.output_text.trim();
  }

  const contentBlocks = root.output ?? [];
  for (const block of contentBlocks) {
    const entries = block.content ?? [];
    for (const entry of entries) {
      if (typeof entry.text === 'string' && entry.text.trim().length > 0) {
        return entry.text.trim();
      }
    }
  }

  return undefined;
};

const truncateSummaryField = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const toNormalizedSummaryList = (value: unknown, maxItems: number, maxLength: number): readonly string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()))
    .filter((entry) => entry.length > 0)
    .map((entry) => truncateSummaryField(entry, maxLength));

  return Object.freeze([...new Set(normalized)].slice(0, maxItems));
};

const toNormalizedSummaryFact = (value: unknown): StructuredSummaryFact | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const fact = typeof record['fact'] === 'string' ? record['fact'].trim() : '';
  if (fact.length === 0) {
    return undefined;
  }

  const role = typeof record['role'] === 'string' ? record['role'].trim() : 'assistant';
  const date = typeof record['date'] === 'string' ? record['date'].trim() : '-';
  const speaker = typeof record['speaker'] === 'string' ? record['speaker'].trim() : '-';
  const anchor = typeof record['anchor'] === 'string' ? record['anchor'].trim() : '-';

  return {
    role: truncateSummaryField(role.length === 0 ? 'assistant' : role, 24),
    date: truncateSummaryField(date.length === 0 ? '-' : date, 80),
    speaker: truncateSummaryField(speaker.length === 0 ? '-' : speaker, 80),
    fact: truncateSummaryField(fact, 220),
    anchor: truncateSummaryField(anchor.length === 0 ? '-' : anchor, 120),
  };
};

const toNormalizedSummaryFacts = (value: unknown, maxItems: number): readonly StructuredSummaryFact[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: StructuredSummaryFact[] = [];
  for (const entry of value) {
    const fact = toNormalizedSummaryFact(entry);
    if (fact !== undefined) {
      normalized.push(fact);
    }

    if (normalized.length >= maxItems) {
      break;
    }
  }

  return Object.freeze(normalized);
};

const extractJsonCandidate = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1] !== undefined) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith('{') && fenced.endsWith('}')) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
};

const parseStructuredSummaryPayload = (rawText: string): StructuredSummaryPayload => {
  const jsonCandidate = extractJsonCandidate(rawText);
  if (jsonCandidate === undefined) {
    throw new Error('LOCOMO LLM summarizer did not return a JSON object.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error('LOCOMO LLM summarizer returned invalid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('LOCOMO LLM summarizer JSON root must be an object.');
  }

  const record = parsed as Record<string, unknown>;

  return {
    entities: toNormalizedSummaryList(record['entities'], 24, 96),
    dates: toNormalizedSummaryList(record['dates'], 20, 96),
    commitments: toNormalizedSummaryList(record['commitments'], 20, 140),
    outcomes: toNormalizedSummaryList(record['outcomes'], 20, 140),
    lexicalAnchors: toNormalizedSummaryList(record['lexicalAnchors'], 24, 80),
    messageFacts: toNormalizedSummaryFacts(record['messageFacts'], 24),
  };
};

const renderStructuredSummaryContent = (input: {
  readonly mode: 'normal' | 'aggressive';
  readonly payload: StructuredSummaryPayload;
}): string => {
  const prefix = input.mode === 'normal' ? '[Summary]' : '[Aggressive Summary]';
  const renderList = (label: string, values: readonly string[]): string => {
    return `${label}: ${values.length === 0 ? '-' : values.join(' ; ')}`;
  };

  const factLines =
    input.payload.messageFacts.length === 0
      ? ['message_facts: -']
      : [
          'message_facts:',
          ...input.payload.messageFacts.map((fact, index) =>
            `- #${index + 1} | role:${fact.role} | date:${fact.date} | speaker:${fact.speaker} | fact:${fact.fact} | anchor:${fact.anchor}`,
          ),
        ];

  return [
    prefix,
    '[Structured Summary]',
    renderList('entities', input.payload.entities),
    renderList('dates', input.payload.dates),
    renderList('commitments', input.payload.commitments),
    renderList('outcomes', input.payload.outcomes),
    renderList('lexical_anchors', input.payload.lexicalAnchors),
    ...factLines,
  ].join('\n');
};

const trimStructuredSummaryToTarget = (input: {
  readonly content: string;
  readonly targetTokens: number | undefined;
}): string => {
  if (input.targetTokens === undefined) {
    return input.content;
  }

  const maxTokens = Math.max(1, input.targetTokens);
  if (sharedTokenizer.countTokens(input.content).value <= maxTokens) {
    return input.content;
  }

  const lines = input.content.split('\n');
  if (lines.length <= 2) {
    return input.content;
  }

  const selected: string[] = lines.slice(0, 2);
  for (const line of lines.slice(2)) {
    const candidate = [...selected, line].join('\n');
    if (sharedTokenizer.countTokens(candidate).value <= maxTokens) {
      selected.push(line);
    }
  }

  const fallback = selected.join('\n').trim();
  return fallback.length === 0 ? lines.slice(0, 2).join('\n') : fallback;
};

const generateStructuredSummaryText = async (input: {
  readonly deps: LlmSummarizerDeps;
  readonly mode: 'normal' | 'aggressive';
  readonly targetTokens?: number;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}): Promise<string> => {
  const baseUrl = input.deps.llmBaseUrl.replace(/\/+$/, '');
  const selectedMessages = toHeadTailMessages({
    messages: input.messages,
    limit: input.mode === 'normal' ? 12 : 6,
  });
  const promptMessages = selectedMessages
    .map((message, index) => `M${index + 1} | role=${message.role} | content=${message.content}`)
    .join('\n');

  const systemInstruction =
    'You are a retrieval-first conversation summarizer. Return JSON only. Preserve exact entities, dates, commitments, outcomes, and rare lexical anchors.';
  const userPrompt = [
    'Produce a structured summary for memory retrieval with this exact JSON schema and no additional keys:',
    '{',
    '  "entities": string[],',
    '  "dates": string[],',
    '  "commitments": string[],',
    '  "outcomes": string[],',
    '  "lexicalAnchors": string[],',
    '  "messageFacts": [{',
    '    "role": string,',
    '    "date": string,',
    '    "speaker": string,',
    '    "fact": string,',
    '    "anchor": string',
    '  }]',
    '}',
    'Rules:',
    '- Keep wording grounded in the source text whenever possible.',
    '- Prefer retrieval anchors over narrative prose.',
    '- Include rare names, IDs, and unusual lexical forms in lexicalAnchors.',
    '- messageFacts should capture high-value facts for later describe/search/expand.',
    `mode: ${input.mode}`,
    ...(input.targetTokens === undefined ? [] : [`target_tokens: ${input.targetTokens}`]),
    'conversation_messages:',
    promptMessages.length === 0 ? '-' : promptMessages,
  ].join('\n');

  const maxOutputTokens =
    input.targetTokens === undefined
      ? input.mode === 'normal'
        ? 520
        : 300
      : Math.max(96, Math.min(900, input.targetTokens + 160));

  const responsesPayload = await postJson({
    url: `${baseUrl}/responses`,
    apiKey: input.deps.llmApiKey,
    timeoutMs: input.deps.llmTimeoutMs,
    body: {
      model: input.deps.modelName,
      seed: 0,
      temperature: 0,
      top_p: 1,
      max_output_tokens: maxOutputTokens,
      input: toOpenAiMessage({
        systemInstruction,
        userPrompt,
      }),
    },
  }).catch(() => undefined);

  const textFromResponses = parseResponsesText(responsesPayload);
  if (textFromResponses !== undefined) {
    return textFromResponses;
  }

  const chatPayload = await postJson({
    url: `${baseUrl}/chat/completions`,
    apiKey: input.deps.llmApiKey,
    timeoutMs: input.deps.llmTimeoutMs,
    body: {
      model: input.deps.modelName,
      seed: 0,
      temperature: 0,
      top_p: 1,
      max_tokens: maxOutputTokens,
      messages: toOpenAiMessage({
        systemInstruction,
        userPrompt,
      }),
    },
  });

  const textFromChat = parseChatCompletionsText(chatPayload);
  if (textFromChat === undefined) {
    throw new Error('LOCOMO LLM summarizer response did not contain text output.');
  }

  return textFromChat;
};

const createLlmStructuredSummarizer = (input: {
  readonly deps: LlmSummarizerDeps;
  readonly traceCollector: LocomoSummarizationTraceCollector;
}): SummarizerPort => {
  return {
    summarize: async (summarizationInput) => {
      const rawText = await generateStructuredSummaryText({
        deps: input.deps,
        mode: summarizationInput.mode,
        ...(summarizationInput.targetTokens === undefined
          ? {}
          : { targetTokens: summarizationInput.targetTokens }),
        messages: summarizationInput.messages,
      });
      const parsed = parseStructuredSummaryPayload(rawText);
      const rendered = renderStructuredSummaryContent({
        mode: summarizationInput.mode,
        payload: parsed,
      });
      const content = trimStructuredSummaryToTarget({
        content: rendered,
        targetTokens: summarizationInput.targetTokens,
      });
      const tokenCount = sharedTokenizer.countTokens(content);
      const preservedArtifactIds = summarizationInput.artifactIdsToPreserve;

      input.traceCollector.record({
        summarizerType: LLM_STRUCTURED_SUMMARIZER_TYPE,
        mode: summarizationInput.mode,
        ...(summarizationInput.targetTokens === undefined ? {} : { targetTokens: summarizationInput.targetTokens }),
        messageCount: summarizationInput.messages.length,
        outputContent: content,
        outputTokenCount: tokenCount.value,
        preservedArtifactIds: preservedArtifactIds.map((artifactId) => String(artifactId)),
      });

      return {
        content,
        tokenCount,
        preservedArtifactIds,
      };
    },
  };
};

const createLocomoSummarizer = (input: RuntimeSummarizerSelectionInput): SummarizerPort => {
  if (input.summarizerType === DETERMINISTIC_SUMMARIZER_TYPE) {
    return createDeterministicHeadTailSummarizer({
      traceCollector: input.traceCollector,
    });
  }

  if (input.summarizerType === LLM_STRUCTURED_SUMMARIZER_TYPE) {
    if (input.llm.llmBaseUrl === undefined) {
      throw new Error('locomo_llm_structured_v1 requires --llm-base-url or LOCOMO_LLM_BASE_URL.');
    }

    return createLlmStructuredSummarizer({
      deps: {
        modelName: input.llm.modelName,
        llmBaseUrl: input.llm.llmBaseUrl,
        llmApiKey: input.llm.llmApiKey,
        llmTimeoutMs: input.llm.llmTimeoutMs,
      },
      traceCollector: input.traceCollector,
    });
  }

  throw new Error(`Unsupported LOCOMO summarizer type: ${input.summarizerType}`);
};

const toLocomoRuntimeProvenance = (input: {
  readonly runtimeMode: LocomoRuntimeMode;
  readonly summarizerType: LocomoSummarizerType;
  readonly artifactBearingExampleCount: number;
  readonly artifactsEnabled: boolean;
}): LocomoRuntimeProvenance => {
  return {
    runtimeMode: input.runtimeMode,
    summarizerType: input.summarizerType,
    artifactsEnabled: input.artifactsEnabled,
    artifactBearingExampleCount: input.artifactBearingExampleCount,
  };
};

const createEngine = (input: {
  readonly deps: RuntimeDeps;
  readonly summarizer: SummarizerPort;
}): MemoryEngine => {

  const { deps, summarizer } = input;
  const idService = createIdService(deterministicHashPort);
  const fixedOccurredAt = createTimestamp(new Date('2026-03-01T00:00:00.000Z'));

  const clock = {
    now: () => fixedOccurredAt,
  };

  const runCompactionUseCase = new RunCompactionUseCase({
    unitOfWork: deps.unitOfWork,
    ledgerRead: deps.ledgerRead,
    summarizer,
    tokenizer: sharedTokenizer,
    idService,
    clock,
    config: {
      maxRounds: 20,
      tailWindowSize: 2,
      minBlockSize: 1,
      blockTokenTargetFraction: 0.2,
      targetFreePercentage: 0.15,
      deterministicFallbackMaxTokens: 512,
    },
  });

  const storeArtifactUseCase = new StoreArtifactUseCase({
    unitOfWork: deps.unitOfWork,
    idService,
    hashPort: deterministicHashPort,
    tokenizer: sharedTokenizer,
  });

  const exploreArtifactUseCase = new ExploreArtifactUseCase({
    artifactStore: deps.artifactStore,
    explorerRegistry: createDefaultExplorerRegistry(sharedTokenizer),
  });

  const appendUseCase = new AppendLedgerEventsUseCase({
    unitOfWork: deps.unitOfWork,
    ledgerRead: deps.ledgerRead,
    idService,
    hashPort: deterministicHashPort,
    clock,
  });

  const materializeUseCase = new MaterializeContextUseCase({
    conversations: deps.conversations,
    contextProjection: deps.contextProjection,
    summaryDag: deps.summaryDag,
    ledgerRead: deps.ledgerRead,
    artifactStore: deps.artifactStore,
    runCompaction: (input) => runCompactionUseCase.execute(input),
  });

  const checkIntegrityUseCase = new CheckIntegrityUseCase({
    conversations: deps.conversations,
    summaryDag: deps.summaryDag,
  });

  const grepUseCase = new GrepUseCase({
    ledgerRead: deps.ledgerRead,
    summaryDag: deps.summaryDag,
  });

  const describeUseCase = new DescribeUseCase({
    summaryDag: deps.summaryDag,
    artifactStore: deps.artifactStore,
  });

  const expandUseCase = new ExpandUseCase({
    authorization: new SubAgentAuthorizationAdapter(),
    summaryDag: deps.summaryDag,
  });

  return {
    append: (input) => appendUseCase.execute(input),
    materializeContext: (input) => materializeUseCase.execute(input),
    runCompaction: (input) => runCompactionUseCase.execute(input),
    checkIntegrity: (input) => checkIntegrityUseCase.execute(input),
    grep: (input) => grepUseCase.execute(input),
    describe: (input) => describeUseCase.execute(input),
    expand: (input) => expandUseCase.execute(input),
    storeArtifact: (input) => storeArtifactUseCase.execute(input),
    exploreArtifact: (input) => exploreArtifactUseCase.execute(input),
  };
};

export interface LedgermindRuntime {
  readonly conversationId: ConversationId;
  readonly engine: MemoryEngine;
  readonly contextLines: readonly { readonly id: string; readonly text: string; readonly tokenEstimate: number }[];
  readonly provenance: LocomoRuntimeProvenance;
  flushSummarizationTrace(): readonly LedgermindSummarizationTraceEntry[];
  destroy(): Promise<void>;
}

const createInMemoryRuntime = async (input: {
  readonly sample: LocomoConversationSample;
  readonly fairness: FairnessConfig;
  readonly runtimeMode: LocomoRuntimeMode;
  readonly summarizerType: LocomoSummarizerType;
  readonly llmBaseUrl: string | undefined;
  readonly llmApiKey: string | undefined;
  readonly llmTimeoutMs: number;
  readonly summarizerOverride?: SummarizerPort;
  readonly precompact?: boolean;
  readonly artifactsEnabled: boolean;
}): Promise<LedgermindRuntime> => {
  const state = createInMemoryPersistenceState();
  const unitOfWork = new InMemoryUnitOfWork(state);
  const ledgerRead = new InMemoryLedgerStore(state);
  const contextProjection = new InMemoryContextProjection(state);
  const summaryDag = new InMemorySummaryDag(state);
  const artifactStore = new InMemoryArtifactStore(state);
  const conversations = new InMemoryConversationStore(state);

  const conversation = await conversations.create(
    createConversationConfig({
      modelName: input.fairness.modelName,
      contextWindow: createTokenCount(input.fairness.tokenBudget),
      thresholds: createCompactionThresholds(0.6, 0.9),
    }),
  );

  const summarizationTraceEntries: LedgermindSummarizationTraceEntry[] = [];
  const summarizationTraceCollector: LocomoSummarizationTraceCollector = {
    record(entry) {
      summarizationTraceEntries.push({
        ...entry,
        preservedArtifactIds: Object.freeze([...entry.preservedArtifactIds]),
      });
    },
  };

  const summarizer =
    input.summarizerOverride ??
    createLocomoSummarizer({
      summarizerType: input.summarizerType,
      traceCollector: summarizationTraceCollector,
      llm: {
        modelName: input.fairness.modelName,
        llmBaseUrl: input.llmBaseUrl,
        llmApiKey: input.llmApiKey,
        llmTimeoutMs: input.llmTimeoutMs,
      },
    });

  const engine = createEngine({
    deps: {
      unitOfWork,
      ledgerRead,
      contextProjection,
      summaryDag,
      artifactStore,
      conversations,
    },
    summarizer,
  });

  const turns = extractTurns(input.sample);
  const artifactBearingExampleCount = turns.reduce(
    (count, turn) => count + (hasArtifactLikeContent(turn) ? 1 : 0),
    0,
  );
  const speakerRoleMap = mapSpeakersToRoles(turns);
  const fixedOccurredAt = createTimestamp(new Date('2026-03-01T00:00:00.000Z'));

  const artifactIdByTurnId = new Map<string, string>();
  if (input.artifactsEnabled) {
    for (const turn of turns) {
      if (turn.blipCaption === undefined) {
        continue;
      }

      const stored = await engine.storeArtifact({
        conversationId: conversation.id,
        source: {
          kind: 'text',
          content: turn.blipCaption,
        },
      });

      artifactIdByTurnId.set(turn.diaId, String(stored.artifactId));
    }
  }

  await engine.append({
    conversationId: conversation.id,
    events: turns.map((turn) => {
      const artifactId = artifactIdByTurnId.get(turn.diaId);
      const sharedSuffix =
        turn.blipCaption === undefined
          ? ''
          : input.artifactsEnabled && artifactId !== undefined
            ? ` [shared ${artifactId}] [shared_caption ${turn.blipCaption}]`
            : input.artifactsEnabled
              ? ` [shared ${turn.blipCaption}]`
              : '';
      const content = `DATE: ${turn.dateTime} | ID: ${turn.diaId} | ${turn.speaker}: ${turn.text}${sharedSuffix}`;
      const role = speakerRoleMap.get(turn.speaker) ?? ('assistant' as MessageRole);
      return {
        role,
        content,
        tokenCount: sharedTokenizer.countTokens(content),
        occurredAt: fixedOccurredAt,
        ...(input.artifactsEnabled && artifactId !== undefined ? { metadata: { artifactIds: [artifactId] } } : {}),
      };
    }),
  });

  if (input.precompact !== false) {
    await engine.runCompaction({
      conversationId: conversation.id,
      trigger: 'soft',
      targetTokens: createTokenCount(Math.floor(input.fairness.tokenBudget * 0.7)),
    });
  }

  return {
    conversationId: conversation.id,
    engine,
    contextLines: buildContextLines(input.sample).map((line) => ({
      id: line.id,
      text: line.text,
      tokenEstimate: line.tokenEstimate,
    })),
    provenance: toLocomoRuntimeProvenance({
      runtimeMode: input.runtimeMode,
      summarizerType: input.summarizerType,
      artifactBearingExampleCount,
      artifactsEnabled: input.artifactsEnabled,
    }),
    flushSummarizationTrace: () => {
      const snapshot = Object.freeze(summarizationTraceEntries.map((entry) => ({ ...entry })));
      summarizationTraceEntries.length = 0;
      return snapshot;
    },
    destroy: async () => undefined,
  };
};

export const createLedgermindRuntime = async (input: {
  readonly sample: LocomoConversationSample;
  readonly fairness: FairnessConfig;
  readonly runtimeMode: LocomoRuntimeMode;
  readonly summarizerType: LocomoSummarizerType;
  readonly llmBaseUrl: string | undefined;
  readonly llmApiKey: string | undefined;
  readonly llmTimeoutMs: number;
  readonly summarizerOverride?: SummarizerPort;
  readonly precompact?: boolean;
  readonly artifactsEnabled?: boolean;
}): Promise<LedgermindRuntime> => {
  return createInMemoryRuntime({
    ...input,
    artifactsEnabled: input.artifactsEnabled ?? true,
  });
};
