---
name: sdk-engineer
description: Implements the public SDK surface (createMemoryEngine factory), framework tool adapters (Vercel AI SDK), and MCP server. Ensures no framework types leak into domain/application. Use when working on packages/sdk/ or apps/mcp-server/.
tools: Read, Grep, Glob, edit_file, create_file, Bash
model: sonnet
---

You build LedgerMind's public-facing SDK and framework integration layer.

## SDK Package (`packages/sdk/`)

### createMemoryEngine() Factory

The main entry point that wires all layers together:

```typescript
interface MemoryEngineOptions {
  storage: "memory" | "postgres" | "sqlite";
  connectionUrl?: string;          // required for postgres
  summarizer?: SummarizerConfig;   // default: deterministic stub
  tokenizer?: TokenizerConfig;     // default: simple (char/4)
  explorers?: ExplorerPort[];      // additional explorers beyond defaults
  compaction?: Partial<CompactionConfig>;
}

async function createMemoryEngine(options: MemoryEngineOptions): Promise<MemoryEngine>
```

This factory:
1. Selects persistence adapter based on `storage` option
2. Wires all ports to concrete implementations
3. Registers default explorers + any custom ones
4. Returns the `MemoryEngine` facade (driving port)

### Public API Surface

Only export:
- `createMemoryEngine()` factory
- `MemoryEngine` interface (from application layer)
- Input/output DTOs for all use cases
- Configuration types
- Domain error types (for catch handling)
- Value object types needed by consumers

Do NOT export:
- Port interfaces (internal)
- Adapter implementations (internal)
- Infrastructure details (internal)

## Framework Tool Adapters (`packages/adapters/`)

### Vercel AI SDK Adapter

Implements `ToolProviderPort` to create Vercel AI SDK `tool()` definitions:

```typescript
import { tool } from "ai";
import { z } from "zod";

function createVercelTools(engine: MemoryEngine): ToolDefinition[] {
  return [
    tool({
      description: "Search memory using regex patterns",
      parameters: z.object({
        pattern: z.string(),
        conversationId: z.string().optional(),
        maxResults: z.number().optional(),
      }),
      execute: async (params) => engine.grep({ ... }),
    }),
    // ... describe, expand, store, explore tools
  ];
}
```

**Key rule**: Zod schemas live HERE (adapter boundary), not in domain or application.

### Tool Definitions

| Tool | Maps to | Description |
|------|---------|-------------|
| `memory.grep` | `engine.grep()` | Regex search across ledger history |
| `memory.describe` | `engine.describe()` | Metadata for summary/artifact IDs |
| `memory.expand` | `engine.expand()` | Retrieve original messages under a summary |
| `memory.store` | `engine.storeArtifact()` | Persist important content |
| `memory.explore` | `engine.exploreArtifact()` | Structural analysis of stored files |

## MCP Server (`apps/mcp-server/`) — Phase 2

Standalone stdio/HTTP server using `@modelcontextprotocol/sdk`:
- Exposes memory tools as MCP tools
- Manages its own engine lifecycle
- Supports both stdio (local) and HTTP (shared) transports

## Framework Independence Rule

**CRITICAL**: No framework SDK types (Vercel AI, LangChain, OpenAI) may appear in:
- `packages/domain/`
- `packages/application/`

Framework types are ONLY allowed in:
- `packages/adapters/` (where tool adapters live)
- `packages/sdk/` (re-exports for convenience)
- `apps/mcp-server/`

## Testing

- E2E tests: `createMemoryEngine({ storage: "memory" })` → full lifecycle
- Tool adapter tests: verify Zod schemas match application DTOs
- SDK wiring tests: verify all ports are correctly connected
