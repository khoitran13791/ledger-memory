# Large-File Contract Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-touch artifact storage produce persisted exploration summaries automatically and surface artifact `id + path + exploration summary` in `materializeContext()`.

**Architecture:** Treat this as one paper-alignment fix that starts in `@ledgermind/application` and then ripples outward. Add a shared application-layer artifact-exploration helper so `StoreArtifactUseCase` and `ExploreArtifactUseCase` use the same explorer-resolution path, enrich `ArtifactReference` so materialized context can carry lightweight artifact previews, and keep `memory.describe()` as the deeper drill-down path rather than the only way to learn what an artifact is.

**Tech Stack:** TypeScript strict ESM, Node.js 22, Vitest, pnpm workspaces, existing in-memory/PostgreSQL adapters, `@ledgermind/sdk`, golden/regression harnesses, and repo docs in `docs/`.

---

## Scope And Decisions

- The review comment is directionally correct: today `storeArtifact()` persists artifacts without exploration, `exploreArtifact()` is manual-only, and `materializeContext()` only surfaces bare artifact IDs in both `artifactReferences` and the system preamble.
- The current repo docs intentionally document that richer artifact metadata lives under `describe()`. This plan chooses to upgrade the public contract rather than argue that the comment is invalid.
- `ArtifactReference` should grow optional `originalPath` and `explorationSummary` fields. Keep `StoreArtifactOutput` unchanged.
- `systemPreamble` should advertise each surfaced artifact as `id (path) - summary teaser`, still capped to the first four artifacts.
- Keep the preamble teaser short and deterministic. Do not expand this patch into a broader `budgetUsed` accounting rewrite for system-preamble tokens.
- Automatic exploration should happen inside `StoreArtifactUseCase` immediately after persistence when bytes are available. Reuse the same helper from explicit `ExploreArtifactUseCase`.
- If automatic exploration fails in a normal readable-artifact flow, let the store call fail. Silent success would preserve the exact paper-alignment gap we are fixing. The default registry already includes fallbacks for malformed and unreadable inputs.
- Non-goals: changing `describe()` metadata shape, adding background jobs for delayed exploration, or redesigning artifact lineage propagation in compaction.

## File Structure

### New File To Create

- `packages/application/src/use-cases/artifact-exploration.ts` - shared helper for artifact path resolution and explorer dispatch used by both store and explicit explore flows.

### Existing Files To Modify

- `packages/application/src/ports/driving/memory-engine.port.ts` - extend `ArtifactReference` with optional preview metadata.
- `packages/application/src/use-cases/materialize-context.ts` - collect richer artifact references and render them into the system preamble.
- `packages/application/src/use-cases/store-artifact.ts` - auto-explore immediately after storing readable artifacts.
- `packages/application/src/use-cases/explore-artifact.ts` - delegate to the shared helper while preserving typed errors.
- `packages/application/src/use-cases/__tests__/materialize-context.test.ts` - lock the richer `artifactReferences` and preamble contract.
- `packages/application/src/use-cases/__tests__/store-artifact.test.ts` - lock automatic exploration on first store.
- `packages/application/src/use-cases/__tests__/explore-artifact.test.ts` - keep explicit exploration behavior stable after the helper extraction.
- `packages/sdk/src/index.ts` - pass the explorer registry into `StoreArtifactUseCase`.
- `packages/sdk/src/index.test.ts` - verify public SDK behavior now exposes exploration summaries immediately after `storeArtifact()`.
- `tests/probes/shared/run-probe-scenario.ts` - pass the explorer registry into the probe runtime's `StoreArtifactUseCase`.
- `tests/regression/sdk-lifecycle.e2e.test.ts` - add an end-to-end regression that proves stored artifacts auto-explore and materialized context advertises them richly.
- `tests/golden/shared/run-golden-scenario.ts` - serialize optional artifact preview fields so golden outputs can capture the richer contract.
- `docs/high-level-design.md` - update the documented `materializeContext()` and artifact contract.
- `docs/testing-strategy.md` - update the use-case expectations for `storeArtifact()` and `materializeContext()`.

### Generated / Build-Synced Files To Watch

- `packages/sdk/src/index.js`
- `packages/sdk/src/index.d.ts`

Do not hand-edit generated JS/DTS unless the tracked repo state already expects mirrored source edits. Prefer changing TypeScript source first, then run the normal verification flow and stage generated deltas only if the repo tracks them.

---

## Chunk 1: Materialized Context Contract

### Task 1: Enrich `ArtifactReference` and the materialized preamble

**Files:**
- Modify: `packages/application/src/ports/driving/memory-engine.port.ts`
- Modify: `packages/application/src/use-cases/materialize-context.ts`
- Modify: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`
- Modify: `tests/golden/shared/run-golden-scenario.ts`
- Test: `packages/application/src/use-cases/__tests__/materialize-context.test.ts`

- [ ] **Step 1: Write the failing application test for richer artifact previews**

```ts
const createTestArtifact = (input?: {
  readonly id?: ArtifactId;
  readonly tokenCount?: number;
  readonly originalPath?: string | null;
  readonly explorationSummary?: string | null;
}): Artifact => {
  return createArtifact({
    id: input?.id ?? artifactId,
    conversationId,
    storageKind: 'path',
    originalPath: input?.originalPath ?? '/tmp/project/data.json',
    mimeType: createMimeType('application/json'),
    tokenCount: createTokenCount(input?.tokenCount ?? 20),
    explorationSummary: input?.explorationSummary ?? 'JSON auth config with token limit 128000',
    explorerUsed: 'json-explorer',
  });
};

it('includes artifact path and exploration summary in materialized context references and preamble', async () => {
  const message = createTestMessage({
    content: 'Stored rollout config in artifact metadata',
    tokenCount: 12,
    sequence: 1,
  });

  const summary = createTestSummary({
    id: createSummaryNodeId('sum_materialize_artifact_preview'),
    content: '[Summary] rollout config moved to artifact',
    tokenCount: 10,
    artifactIds: [artifactId],
  });

  const artifact = createTestArtifact({
    originalPath: '/tmp/project/data.json',
    explorationSummary: 'JSON auth config with token limit 128000',
  });

  const state = createState({
    contextItems: [
      createContextItem({
        conversationId,
        position: 0,
        ref: createMessageContextItemRef(message.id),
      }),
      createContextItem({
        conversationId,
        position: 1,
        ref: createSummaryContextItemRef(summary.id),
      }),
    ],
    events: [message],
    summaries: [summary],
    artifacts: [artifact],
    contextTokenCount: 22,
  });

  const { useCase } = createUseCase({ state });

  const output = await useCase.execute({
    conversationId,
    budgetTokens: 40,
    overheadTokens: 10,
  });

  expect(output.systemPreamble).toContain(`Available artifacts: ${artifact.id} (/tmp/project/data.json) - JSON auth config with token limit 128000.`);
  expect(output.artifactReferences).toEqual([
    {
      id: artifact.id,
      mimeType: artifact.mimeType,
      tokenCount: artifact.tokenCount,
      originalPath: '/tmp/project/data.json',
      explorationSummary: 'JSON auth config with token limit 128000',
    },
  ]);
});
```

- [ ] **Step 2: Run the materialize-context test to confirm the old contract fails**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts`

Expected: FAIL because `ArtifactReference` still exposes only `id`, `mimeType`, and `tokenCount`, and `buildSystemPreamble()` only prints bare artifact IDs.

- [ ] **Step 3: Extend the driving port and materialization helpers**

```ts
// packages/application/src/ports/driving/memory-engine.port.ts
export interface ArtifactReference {
  readonly id: ArtifactId;
  readonly mimeType: MimeType;
  readonly tokenCount: TokenCount;
  readonly originalPath?: string;
  readonly explorationSummary?: string;
}

// packages/application/src/use-cases/materialize-context.ts
const MAX_ARTIFACT_SUMMARY_CHARS_IN_PREAMBLE = 140;

const truncateArtifactSummary = (summary: string): string => {
  const trimmed = summary.trim();
  if (trimmed.length <= MAX_ARTIFACT_SUMMARY_CHARS_IN_PREAMBLE) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_ARTIFACT_SUMMARY_CHARS_IN_PREAMBLE - 3).trimEnd()}...`;
};

const formatArtifactPreview = (reference: ArtifactReference): string => {
  const withPath =
    reference.originalPath === undefined ? reference.id : `${reference.id} (${reference.originalPath})`;

  if (reference.explorationSummary === undefined) {
    return withPath;
  }

  return `${withPath} - ${truncateArtifactSummary(reference.explorationSummary)}`;
};

const collectArtifactReferences = async (
  conversationId: MaterializeContextInput['conversationId'],
  artifactIds: ReadonlySet<ArtifactId>,
  artifactStore: ArtifactStorePort,
): Promise<readonly ArtifactReference[]> => {
  const artifactReferences: ArtifactReference[] = [];

  for (const artifactId of artifactIds) {
    const artifact = await artifactStore.getMetadata(artifactId);
    if (artifact === null || artifact.conversationId !== conversationId) {
      throw new InvalidReferenceError('artifact', artifactId);
    }

    artifactReferences.push({
      id: artifact.id,
      mimeType: artifact.mimeType,
      tokenCount: artifact.tokenCount,
      ...(artifact.originalPath === null ? {} : { originalPath: artifact.originalPath }),
      ...(artifact.explorationSummary === null ? {} : { explorationSummary: artifact.explorationSummary }),
    });
  }

  return artifactReferences;
};

const buildSystemPreamble = (
  summaryReferences: readonly SummaryReference[],
  artifactReferences: readonly ArtifactReference[],
): string => {
  // keep the existing summary branch unchanged

  if (artifactReferences.length > 0) {
    const visibleArtifacts = artifactReferences
      .slice(0, MAX_ARTIFACT_IDS_IN_PREAMBLE)
      .map((reference) => formatArtifactPreview(reference))
      .join(', ');

    const omittedCount = Math.max(0, artifactReferences.length - MAX_ARTIFACT_IDS_IN_PREAMBLE);
    parts.push(
      omittedCount === 0
        ? `Available artifacts: ${visibleArtifacts}.`
        : `Available artifacts: ${visibleArtifacts}, and ${omittedCount} more.`,
    );
  }

  return parts.join(' ');
};
```

- [ ] **Step 4: Update golden serialization so richer references remain visible in recorded scenarios**

```ts
// tests/golden/shared/run-golden-scenario.ts
artifactReferences: Object.freeze(
  output.artifactReferences.map((reference) => ({
    id: reference.id,
    mimeType: reference.mimeType,
    tokenCount: reference.tokenCount.value,
    ...(reference.originalPath === undefined ? {} : { originalPath: reference.originalPath }),
    ...(reference.explorationSummary === undefined
      ? {}
      : { explorationSummary: reference.explorationSummary }),
  })),
),
```

- [ ] **Step 5: Run the updated materialize-context tests**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the materialized-context contract change**

```bash
git add \
  packages/application/src/ports/driving/memory-engine.port.ts \
  packages/application/src/use-cases/materialize-context.ts \
  packages/application/src/use-cases/__tests__/materialize-context.test.ts \
  tests/golden/shared/run-golden-scenario.ts
git commit -m "feat(application): surface artifact previews in materialized context"
```

---

## Chunk 2: First-Touch Exploration

### Task 2: Auto-explore readable artifacts when `storeArtifact()` is called

**Files:**
- Create: `packages/application/src/use-cases/artifact-exploration.ts`
- Modify: `packages/application/src/use-cases/store-artifact.ts`
- Modify: `packages/application/src/use-cases/explore-artifact.ts`
- Modify: `packages/application/src/use-cases/__tests__/store-artifact.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `tests/probes/shared/run-probe-scenario.ts`
- Test: `packages/application/src/use-cases/__tests__/store-artifact.test.ts`
- Test: `packages/application/src/use-cases/__tests__/explore-artifact.test.ts`

- [ ] **Step 1: Write the failing store-artifact test for automatic exploration**

```ts
class StaticExplorer implements ExplorerPort {
  constructor(
    public readonly name: string,
    private readonly output: ExplorerOutput,
  ) {}

  canHandle(): number {
    return 1;
  }

  async explore(): Promise<ExplorerOutput> {
    return this.output;
  }
}

class StaticExplorerRegistry implements ExplorerRegistryPort {
  constructor(private readonly explorer: ExplorerPort) {}

  register(): void {
    return;
  }

  resolve(): ExplorerPort {
    return this.explorer;
  }
}

it('auto-explores readable artifacts on first store', async () => {
  const explorerRegistry = new StaticExplorerRegistry(
    new StaticExplorer('json-explorer', {
      summary: 'JSON auth config with token limit 128000',
      metadata: { topLevelKeys: ['auth', 'tokenLimit'] },
      tokenCount: createTokenCount(12),
    }),
  );

  const { useCase, artifactStore } = createUseCase(createConversationForTest(), new SimpleTokenizer(), {
    explorerRegistry,
  });

  const stored = await useCase.execute({
    conversationId,
    source: {
      kind: 'text',
      content: '{"auth":{"provider":"jwt"},"tokenLimit":128000}',
    },
    mimeType: createMimeType('application/json'),
  });

  const metadata = await artifactStore.getMetadata(stored.artifactId);
  expect(metadata?.explorationSummary).toBe('JSON auth config with token limit 128000');
  expect(metadata?.explorerUsed).toBe('json-explorer');
});
```

- [ ] **Step 2: Run the store-artifact test to confirm the new behavior is missing**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/store-artifact.test.ts`

Expected: FAIL because `StoreArtifactUseCase` does not currently know about the explorer registry and never calls `updateExploration()`.

- [ ] **Step 3: Extract shared artifact-exploration logic and reuse it from both use cases**

```ts
// packages/application/src/use-cases/artifact-exploration.ts
import type { Artifact } from '@ledgermind/domain';

import type { ExplorerHints } from '../ports/driving/memory-engine.port';
import type { ExplorerRegistryPort } from '../ports/driven/explorer/explorer-registry.port';

export const getArtifactExplorePath = (artifact: Artifact): string => {
  return artifact.originalPath ?? `artifact://${artifact.id}`;
};

export const runArtifactExploration = async (input: {
  readonly artifact: Artifact;
  readonly content: string | Uint8Array;
  readonly explorerRegistry: ExplorerRegistryPort;
  readonly explorerHints?: ExplorerHints;
}) => {
  const path = getArtifactExplorePath(input.artifact);
  const explorer = input.explorerRegistry.resolve(
    input.artifact.mimeType,
    path,
    input.explorerHints,
  );

  const output = await explorer.explore({
    content: input.content,
    path,
    mimeType: input.artifact.mimeType,
  });

  return {
    explorerUsed: explorer.name,
    summary: output.summary,
    metadata: output.metadata,
    tokenCount: output.tokenCount,
  };
};

// packages/application/src/use-cases/store-artifact.ts
export interface StoreArtifactUseCaseDeps {
  readonly unitOfWork: UnitOfWorkPort;
  readonly idService: IdService;
  readonly hashPort: HashPort;
  readonly tokenizer: TokenizerPort;
  readonly explorerRegistry: ExplorerRegistryPort;
  readonly fileReader?: FileReaderPort;
  readonly eventPublisher?: EventPublisherPort;
}

await uow.artifacts.store(artifact, preparedSource.content);

if (preparedSource.content !== undefined) {
  const exploration = await runArtifactExploration({
    artifact,
    content: preparedSource.content,
    explorerRegistry: this.deps.explorerRegistry,
  });
  await uow.artifacts.updateExploration(artifact.id, exploration.summary, exploration.explorerUsed);
}

// packages/application/src/use-cases/explore-artifact.ts
const path = getArtifactExplorePath(artifact);

let result: Awaited<ReturnType<typeof runArtifactExploration>>;
try {
  result = await runArtifactExploration({
    artifact,
    content: artifactContent,
    explorerRegistry: this.deps.explorerRegistry,
    explorerHints: input.explorerHints,
  });
} catch (error) {
  // keep the existing ExplorerResolutionError / ArtifactExplorationFailedError wrapping here
}

await this.deps.artifactStore.updateExploration(input.artifactId, result.summary, result.explorerUsed);
```

- [ ] **Step 4: Wire the new dependency through the SDK and probe harness**

```ts
// packages/sdk/src/index.ts
const storeArtifactUseCase = new StoreArtifactUseCase({
  unitOfWork: persistenceDeps.unitOfWork,
  idService,
  hashPort,
  tokenizer,
  explorerRegistry,
  fileReader: persistenceDeps.fileReader,
});

// tests/probes/shared/run-probe-scenario.ts
const storeArtifactUseCase = new StoreArtifactUseCase({
  unitOfWork: input.unitOfWork,
  idService: deterministicDeps.idService,
  hashPort: deterministicDeps.hashPort,
  tokenizer,
  explorerRegistry: createDefaultExplorerRegistry(tokenizer),
  fileReader: new NodeFileReader(),
});
```

- [ ] **Step 5: Run the focused use-case tests after the helper extraction**

Run: `pnpm vitest run packages/application/src/use-cases/__tests__/store-artifact.test.ts packages/application/src/use-cases/__tests__/explore-artifact.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the automatic exploration change**

```bash
git add \
  packages/application/src/use-cases/artifact-exploration.ts \
  packages/application/src/use-cases/store-artifact.ts \
  packages/application/src/use-cases/explore-artifact.ts \
  packages/application/src/use-cases/__tests__/store-artifact.test.ts \
  packages/sdk/src/index.ts \
  tests/probes/shared/run-probe-scenario.ts
git commit -m "feat(application): auto-explore artifacts on store"
```

---

## Chunk 3: End-To-End Proof And Docs

### Task 3: Prove the richer artifact contract through the public SDK and document it

**Files:**
- Modify: `packages/sdk/src/index.test.ts`
- Modify: `tests/regression/sdk-lifecycle.e2e.test.ts`
- Modify: `docs/high-level-design.md`
- Modify: `docs/testing-strategy.md`
- Test: `packages/sdk/src/index.test.ts`
- Test: `tests/regression/sdk-lifecycle.e2e.test.ts`

- [ ] **Step 1: Write the failing SDK/integration regressions**

```ts
// packages/sdk/src/index.test.ts
it('makes exploration summaries available immediately after storeArtifact', async () => {
  const conversation = createExistingConversation();
  vi.spyOn(InMemoryConversationStore.prototype, 'get').mockResolvedValue(conversation);

  const engine = createInMemoryMemoryEngine();

  const stored = await engine.storeArtifact({
    conversationId,
    source: {
      kind: 'text',
      content: '{"auth":{"provider":"jwt"},"tokenLimit":128000}',
    },
    mimeType: createMimeType('application/json'),
  });

  const described = await engine.describe({ id: stored.artifactId });

  expect(described.kind).toBe('artifact');
  expect(described.planningSignals).toMatchObject({ hasExplorationSummary: true });
  expect(described.explorationSummary).toContain('token limit');
});

// tests/regression/sdk-lifecycle.e2e.test.ts
it('auto-explores stored artifacts and advertises path plus summary in materialized context', async () => {
  const { engine, conversationId } = createHarness({
    suffix: 'artifact_materialize_preview',
    contextWindow: 256,
    softThreshold: 0.6,
    hardThreshold: 0.9,
  });

  const stored = await engine.storeArtifact({
    conversationId,
    source: {
      kind: 'text',
      content: '{"auth":{"provider":"jwt"},"tokenLimit":128000}',
    },
    mimeType: createMimeType('application/json'),
  });

  await engine.append({
    conversationId,
    events: [
      createEvent('user', 'Config moved into artifact for later recall', 24, {
        artifactId: stored.artifactId,
      }),
      createEvent('assistant', 'I will reference the stored artifact during compaction', 24),
      createEvent('user', 'Please keep the artifact lineage intact', 24),
      createEvent('assistant', 'Lineage preserved', 24),
    ],
  });

  await engine.runCompaction({
    conversationId,
    trigger: 'soft',
    targetTokens: createTokenCount(70),
  });

  const context = await engine.materializeContext({
    conversationId,
    budgetTokens: 180,
    overheadTokens: 20,
  });

  expect(context.artifactReferences[0]).toMatchObject({
    id: stored.artifactId,
    explorationSummary: expect.stringContaining('token'),
  });
  expect(context.systemPreamble).toContain(stored.artifactId);
  expect(context.systemPreamble).toContain('token');
});
```

- [ ] **Step 2: Run the public-surface tests to confirm the regression before implementation**

Run: `pnpm vitest run packages/sdk/src/index.test.ts tests/regression/sdk-lifecycle.e2e.test.ts`

Expected: FAIL because `describe()` still has no exploration summary immediately after `storeArtifact()`, and materialized context still exposes only bare artifact IDs.

- [ ] **Step 3: Update docs to match the upgraded contract**

```md
<!-- docs/high-level-design.md -->
interface ArtifactReference {
  id: ArtifactId;
  mimeType: MimeType;
  tokenCount: TokenCount;
  originalPath?: string;
  explorationSummary?: string;
}

interface MaterializeContextOutput {
  systemPreamble: string;
  modelMessages: ModelMessage[];
  summaryReferences: SummaryReference[];
  artifactReferences: ArtifactReference[]; // IDs plus lightweight artifact previews
  budgetUsed: TokenCount;
}

**Current implementation contract:** `materializeContext()` exposes artifact IDs together with
`originalPath` and `explorationSummary` when available so the caller can decide whether it needs
to spend an extra `memory.describe()` call.

<!-- docs/testing-strategy.md -->
| **materializeContext()** | Output <= budget; pinned items always included; hard threshold triggers blocking compaction; `ContextMaterialized` emitted with correct counts; artifact references include path + exploration summary when lineage points at stored artifacts |
| **storeArtifact()** | Content-addressed ID; stores inline/path variants; auto-explores readable artifacts on first store |
```

- [ ] **Step 4: Run the focused regression suite and typecheck**

Run: `pnpm vitest run packages/sdk/src/index.test.ts tests/regression/sdk-lifecycle.e2e.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the end-to-end proof and docs**

```bash
git add \
  packages/sdk/src/index.test.ts \
  tests/regression/sdk-lifecycle.e2e.test.ts \
  docs/high-level-design.md \
  docs/testing-strategy.md
git commit -m "docs: align artifact materialization contract with large-file flow"
```

---

## Final Verification Checklist

- Run: `pnpm vitest run packages/application/src/use-cases/__tests__/materialize-context.test.ts packages/application/src/use-cases/__tests__/store-artifact.test.ts packages/application/src/use-cases/__tests__/explore-artifact.test.ts packages/sdk/src/index.test.ts tests/regression/sdk-lifecycle.e2e.test.ts`
- Run: `pnpm typecheck`
- Optional if generated files changed: `pnpm build`

Expected final state:

- `storeArtifact()` persists an exploration summary for readable first-touch artifacts.
- `exploreArtifact()` still behaves the same externally, but now shares implementation with store-time exploration.
- `materializeContext()` returns artifact references that carry `id + path + exploration summary`.
- `systemPreamble` no longer tells the model only that an opaque artifact ID exists.
- SDK and regression tests prove the end-to-end behavior instead of only the manual `store -> explore -> describe` path.
