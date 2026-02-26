---
name: explorer-template
description: Template and conventions for implementing new ExplorerPort plugins — canHandle scoring, deterministic output, token budget compliance, and registry registration.
---

# Explorer Plugin Template

## ExplorerPort Interface

```typescript
interface ExplorerPort {
  readonly name: string;
  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number;
  explore(input: ExplorerInput): Promise<ExplorerOutput>;
}
```

## Implementation Template

```typescript
export class MyFileExplorer implements ExplorerPort {
  readonly name = "my-file-explorer";

  constructor(private tokenizer: TokenizerPort) {}

  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number {
    // Return 0 if can't handle, higher = better match
    if (path.endsWith(".myext")) return 10;
    if (mimeType === "application/my-type" as MimeType) return 8;
    return 0;
  }

  async explore(input: ExplorerInput): Promise<ExplorerOutput> {
    const content = typeof input.content === "string"
      ? input.content
      : input.content.toString("utf-8");

    // 1. Parse/analyze the file
    const analysis = this.analyze(content);

    // 2. Build structured summary
    const summary = this.formatSummary(analysis, input.path);

    // 3. Enforce token budget
    const tokenCount = this.tokenizer.countTokens(summary);
    if (input.maxTokens && tokenCount.value > input.maxTokens) {
      return this.truncateToFit(summary, input.maxTokens);
    }

    return { summary, metadata: analysis.metadata, tokenCount };
  }
}
```

## Registration (Open/Closed Principle)

```typescript
// At startup / in SDK factory:
registry.register(new TypeScriptExplorer(tokenizer));
registry.register(new PythonExplorer(tokenizer));
registry.register(new JSONExplorer(tokenizer));
registry.register(new MarkdownExplorer(tokenizer));
registry.register(new FallbackExplorer(tokenizer));  // score=1, always matches
```

Adding a new explorer: implement ExplorerPort → register() → done. No existing code modified.

## Phase 1 Explorers

| Explorer | Extensions | Score | Strategy |
|----------|-----------|-------|----------|
| TypeScript | `.ts`, `.tsx` | 10 | Regex: exports, interfaces, classes, functions |
| Python | `.py` | 10 | Regex: classes, defs, imports, docstrings |
| JSON | `.json`, `.jsonl` | 10/8 | Parse + schema shape (keys, types, array lengths) |
| Markdown | `.md`, `.mdx` | 10 | Headings hierarchy, code blocks, links |
| Fallback | `*` | 1 | Line count, size, first N lines preview |

## Rules

1. **Deterministic**: Same input → same output (no timestamps, stable ordering)
2. **Token-bounded**: Always respect `maxTokens`; truncate with marker if needed
3. **No side effects**: Explorers are pure transforms (content in → summary out)
4. **No external deps in domain**: Explorers live in adapters, use TokenizerPort
