---
name: golden-tests
description: Golden test fixture format, deterministic stubs (SimpleTokenizer + DeterministicSummarizer), cross-adapter execution pattern, stable matchers, and snapshot stability requirements.
---

# Golden Test Suite

## Purpose

Deterministic, snapshot-stable tests that verify exact DAG evolution for fixed inputs. Same input → same IDs → same DAG → same materialized output. Every time.

## Deterministic Test Doubles

### SimpleTokenizer
```typescript
class SimpleTokenizer implements TokenizerPort {
  countTokens(text: string): TokenCount {
    return { value: Math.ceil(text.length / 4) } as TokenCount;
  }
  estimateFromBytes(byteLength: number): TokenCount {
    return { value: Math.ceil(byteLength / 4) } as TokenCount;
  }
}
```

### DeterministicSummarizer
```typescript
class DeterministicSummarizer implements SummarizerPort {
  constructor(private tokenizer: TokenizerPort) {}
  async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
    const joined = input.messages.map(m => m.content).join("\n");
    const fraction = input.mode === "normal" ? 0.6 : 0.3;
    const prefix = input.mode === "normal" ? "[Summary]" : "[Aggressive Summary]";
    const target = Math.floor(joined.length * fraction);
    const cutoff = joined.lastIndexOf(" ", target);
    const content = `${prefix} ${joined.substring(0, cutoff > 0 ? cutoff : target)}`;
    return {
      content,
      tokenCount: this.tokenizer.countTokens(content),
      preservedArtifactIds: input.artifactIdsToPreserve,
    };
  }
}
```

## Fixture Format

```typescript
// tests/golden/fixtures/<name>.fixture.ts
export const fixture = {
  name: "basic-compaction",
  conversation: {
    modelName: "test-model",
    contextWindow: 4000,
    thresholds: { soft: 0.6, hard: 1.0 },
  },
  events: [
    { role: "user", content: "..." },
    { role: "assistant", content: "..." },
  ],
  actions: [
    { type: "materialize", budgetTokens: 1000, overheadTokens: 200 },
  ],
  expected: {
    dagNodeCount: 1,
    dagNodeKinds: ["leaf"],
    contextItemCount: 4,
    budgetUsedLessThan: 800,
    integrityPassed: true,
    summaryIdPrefix: "sum_",
    expandRecoveryCount: 4,
  },
};
```

## Cross-Adapter Execution

```typescript
describe.each([
  ["in-memory", () => createInMemoryAdapter()],
  ["postgres",  () => createPostgresAdapter(testDbUrl)],
])("golden tests (%s)", (name, createAdapter) => {
  it.each(goldenFixtures)("$name", async (fixture) => {
    const adapter = await createAdapter();
    const engine = createEngine(adapter);
    // Run fixture actions, assert expected outcomes
  });
});
```

## Stable Matchers

```typescript
class AnyId {
  constructor(private prefix: string) {}
  equals(other: unknown) {
    return typeof other === "string" && other.startsWith(this.prefix);
  }
}

class AnyTimestamp {
  equals(other: unknown) { return other instanceof Date; }
}
```

## Rules

1. ALL golden tests use DeterministicSummarizer + SimpleTokenizer
2. NEVER use real LLM calls in golden tests
3. Fixtures are checked into `tests/golden/fixtures/`
4. Same vectors run against ALL adapter implementations
5. Table-driven with `it.each` — one test function, many fixtures
6. Run on EVERY PR (must be fast and deterministic)

## Test Helper

```typescript
function createTestEngine(overrides?: Partial<TestConfig>): MemoryEngine {
  // Default wiring: InMemory adapters + deterministic stubs + fixed clock
}
```
