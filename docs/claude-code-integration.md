# LedgerMind × Claude Code Integration Guide

> **Research & Design Document**
> Date: February 26, 2026 | Status: Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Claude Code Extension Points](#2-claude-code-extension-points)
3. [Integration Architecture](#3-integration-architecture)
4. [Option A: MCP Server (Recommended)](#4-option-a-mcp-server-recommended)
5. [Option B: Claude Agent SDK (Programmatic)](#5-option-b-claude-agent-sdk-programmatic)
6. [Option C: Hooks-Only (Transparent)](#6-option-c-hooks-only-transparent)
7. [Option D: Plugin (Distributable)](#7-option-d-plugin-distributable)
8. [PreCompact Hook — The Key Integration Point](#8-precompact-hook--the-key-integration-point)
9. [Tool Definitions](#9-tool-definitions)
10. [System Prompt Integration](#10-system-prompt-integration)
11. [Session Lifecycle & Memory Flow](#11-session-lifecycle--memory-flow)
12. [Configuration Reference](#12-configuration-reference)
13. [Comparison Matrix](#13-comparison-matrix)
14. [Recommended Strategy](#14-recommended-strategy)

---

## 1. Executive Summary

Claude Code provides **four extension points** for integrating external memory systems like LedgerMind:

| Extension Point | Best For | Complexity |
|----------------|----------|------------|
| **MCP Server** | Exposing memory tools the agent calls explicitly | Low–Medium |
| **Agent SDK** | Building custom agents with embedded memory | Medium |
| **Hooks** | Transparent memory injection/extraction without agent awareness | Low |
| **Plugin** | Distributing a packaged memory integration to teams | Medium |

**Key insight:** Claude Code already has its own context compaction system (triggered via `PreCompact` hook). LedgerMind can either **replace** it (via the Agent SDK) or **augment** it (via hooks that persist summaries externally before Claude's built-in compaction runs).

---

## 2. Claude Code Extension Points

### 2.1 MCP (Model Context Protocol)

MCP is the primary extension mechanism. Three transport types:

| Transport | How It Works | Best For |
|-----------|-------------|----------|
| **stdio** | Local subprocess, communicates via stdin/stdout | Single-user, local memory DB |
| **HTTP** | Remote server, request/response | Multi-session shared memory |
| **SSE** | Remote server, server-sent events (deprecated → use HTTP) | Legacy |
| **SDK (in-process)** | Python/TS functions running in same process | Agent SDK integrations |

Tool naming convention: `mcp__<server_name>__<tool_name>`

Example: `mcp__ledgermind__memory_grep`

### 2.2 Hooks

Lifecycle callbacks that intercept Claude Code's execution at fixed points:

| Hook Event | Can Block? | LedgerMind Use |
|-----------|-----------|---------------|
| `SessionStart` | No | Initialize memory engine, load session context |
| `UserPromptSubmit` | Yes | Inject relevant memories before Claude processes prompt |
| `PreToolUse` | Yes | Intercept tool calls, inject memory context |
| `PostToolUse` | No | Index file changes, tool outputs into ledger |
| `PreCompact` | No | Archive full transcript to ledger BEFORE Claude's compaction |
| `Stop` | Yes | Persist session summary to ledger |
| `SubagentStop` | Yes | Capture sub-agent results |

**Critical fields for memory injection:**
- `additionalContext` — string injected into Claude's context (in `hookSpecificOutput`)
- `systemMessage` — top-level field, injected as system-level context

### 2.3 Agent SDK

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` / `claude_agent_sdk`) lets you build custom agents programmatically. It spawns the Claude Code CLI as a subprocess and communicates via bidirectional JSON stream.

Key capabilities:
- In-process MCP servers (no subprocess overhead)
- Programmatic hooks (Python/TS callbacks, not shell scripts)
- System prompt customization (preset + append mode)
- Session management (continue, resume, fork)
- File checkpointing (rewind to any prior state)

### 2.4 Plugin System

Plugins bundle commands, agents, skills, hooks, and MCP servers into a distributable package:

```
ledgermind-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── recall.md          # /recall slash command
├── agents/
│   └── memory-agent.md    # Specialized memory sub-agent
├── .mcp.json              # LedgerMind MCP server config
└── skills/
    └── memory-aware/
        └── SKILL.md        # Auto-loaded skill for memory-aware coding
```

---

## 3. Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code Runtime                      │
│                                                              │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────────┐  │
│  │ System Prompt │  │   Hooks     │  │   MCP Servers      │  │
│  │ (+ append)   │  │ (lifecycle) │  │ (tools for agent)  │  │
│  └──────┬───────┘  └──────┬──────┘  └────────┬───────────┘  │
│         │                 │                   │              │
│         └─────────────────┼───────────────────┘              │
│                           │                                  │
│                    ┌──────▼──────┐                            │
│                    │ Claude Model│                            │
│                    └─────────────┘                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌───────────┐ ┌──────────┐ ┌──────────┐
       │ LedgerMind│ │ LedgerMind│ │LedgerMind│
       │ MCP Server│ │   Hooks  │ │  Plugin  │
       │ (tools)   │ │(inject/  │ │(bundled) │
       │           │ │ extract) │ │          │
       └─────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │            │
             └─────────────┼────────────┘
                           ▼
                   ┌──────────────┐
                   │  LedgerMind  │
                   │ Memory Engine│
                   │  (Postgres)  │
                   └──────────────┘
```

---

## 4. Option A: MCP Server (Recommended)

### 4.1 Standalone stdio Server

Build LedgerMind as a standard MCP server that any Claude Code user can add:

```bash
# User adds LedgerMind to their Claude Code
claude mcp add --transport stdio ledgermind -- \
  npx @ledgermind/mcp-server --db postgres://localhost/ledgermind
```

Or via `.mcp.json` (team-shared, checked into repo):

```json
{
  "mcpServers": {
    "ledgermind": {
      "command": "npx",
      "args": ["-y", "@ledgermind/mcp-server"],
      "env": {
        "LEDGERMIND_DB_URL": "${LEDGERMIND_DB_URL}"
      }
    }
  }
}
```

### 4.2 HTTP Server (Multi-Session Shared Memory)

For teams sharing memory across sessions/agents:

```json
{
  "mcpServers": {
    "ledgermind": {
      "type": "http",
      "url": "https://ledgermind.internal:8765/mcp",
      "headers": {
        "Authorization": "Bearer ${LEDGERMIND_API_KEY}"
      }
    }
  }
}
```

### 4.3 MCP Server Implementation (TypeScript)

```typescript
// packages/mcp-server/src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryEngine } from "@ledgermind/sdk";

const engine = await createMemoryEngine({
  storage: "postgres",
  connectionUrl: process.env.LEDGERMIND_DB_URL,
});

const server = new Server({
  name: "ledgermind",
  version: "1.0.0",
}, {
  capabilities: { tools: {} },
});

// Register tools
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "memory_grep",
      description: "Search long-term memory across all past conversations using regex patterns. Returns matches grouped by summary context.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          conversation_id: { type: "string", description: "Optional: scope to specific conversation" },
          max_results: { type: "number", description: "Max results to return (default: 20)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "memory_describe",
      description: "Get metadata about a summary or artifact ID — token count, creation time, parent summaries, and exploration summary.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Summary ID (sum_xxx) or artifact ID (file_xxx)" },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_expand",
      description: "Retrieve the original raw messages covered by a summary. Use when you need exact details that were compressed during compaction.",
      inputSchema: {
        type: "object",
        properties: {
          summary_id: { type: "string", description: "Summary node ID to expand (sum_xxx)" },
        },
        required: ["summary_id"],
      },
    },
    {
      name: "memory_store",
      description: "Store important context, decisions, or findings into long-term memory for future sessions.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to persist" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for retrieval" },
          source: { type: "string", description: "Source context (e.g., file path, task description)" },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_recall",
      description: "Recall relevant memories for a given query. Uses full-text search across the summary DAG.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language query to search memories" },
          max_results: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "memory_grep": {
      const result = await engine.grep({
        conversationId: args.conversation_id,
        pattern: args.pattern,
      });
      return { content: [{ type: "text", text: formatGrepResults(result) }] };
    }
    case "memory_describe": {
      const result = await engine.describe({ id: args.id });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "memory_expand": {
      const result = await engine.expand({
        summaryId: args.summary_id,
        callerContext: { isSubAgent: true, conversationId: args.conversation_id },
      });
      return { content: [{ type: "text", text: formatExpandResults(result) }] };
    }
    case "memory_store": {
      await engine.append({
        conversationId: getOrCreateConversation(),
        events: [{ role: "user", content: args.content, metadata: { tags: args.tags } }],
      });
      return { content: [{ type: "text", text: "Stored in long-term memory." }] };
    }
    case "memory_recall": {
      const results = await engine.grep({
        pattern: args.query,  // FTS fallback
      });
      return { content: [{ type: "text", text: formatRecallResults(results) }] };
    }
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 5. Option B: Claude Agent SDK (Programmatic)

### 5.1 In-Process MCP Server (TypeScript)

Best for custom agents that need tight memory integration:

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createMemoryEngine } from "@ledgermind/sdk";

const engine = await createMemoryEngine({
  storage: "postgres",
  connectionUrl: process.env.LEDGERMIND_DB_URL,
});

const memoryServer = createSdkMcpServer({
  name: "ledgermind",
  version: "1.0.0",
  tools: [
    tool(
      "memory_recall",
      "Search long-term memory for relevant context from past sessions",
      {
        query: z.string().describe("What to search for"),
        max_results: z.number().optional().default(5),
      },
      async (args) => {
        const results = await engine.grep({
          pattern: args.query,
        });
        return {
          content: [{ type: "text", text: formatResults(results) }],
        };
      }
    ),
    tool(
      "memory_store",
      "Persist important decisions, findings, or context to long-term memory",
      {
        content: z.string().describe("What to remember"),
        tags: z.array(z.string()).optional().describe("Tags for retrieval"),
      },
      async (args) => {
        await engine.append({
          conversationId: currentConversationId,
          events: [{
            role: "assistant",
            content: args.content,
            metadata: { tags: args.tags },
          }],
        });
        return {
          content: [{ type: "text", text: "Stored." }],
        };
      }
    ),
  ],
});
```

### 5.2 Hooks + MCP Combined (Full Integration)

```typescript
import {
  query,
  createSdkMcpServer,
  tool,
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createMemoryEngine } from "@ledgermind/sdk";

const engine = await createMemoryEngine({ storage: "postgres", connectionUrl: "..." });

// --- MCP Tools ---
const memoryServer = createSdkMcpServer({
  name: "ledgermind",
  version: "1.0.0",
  tools: [
    tool("memory_recall", "Search long-term memory", { query: z.string() },
      async (args) => {
        const results = await engine.grep({ pattern: args.query });
        return { content: [{ type: "text", text: formatResults(results) }] };
      }),
    tool("memory_grep", "Regex search across all memory", { pattern: z.string() },
      async (args) => {
        const results = await engine.grep({ pattern: args.pattern });
        return { content: [{ type: "text", text: formatResults(results) }] };
      }),
    tool("memory_describe", "Get metadata for a summary or artifact", { id: z.string() },
      async (args) => {
        const result = await engine.describe({ id: args.id });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }),
  ],
});

// --- Hooks ---

// Inject relevant memories on every user prompt
const injectMemories: HookCallback = async (input, toolUseId, { signal }) => {
  if (input.hook_event_name !== "UserPromptSubmit") return {};

  const prompt = (input as any).prompt || "";
  const memories = await engine.grep({ pattern: extractKeyTerms(prompt) });

  if (memories.matches.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Relevant memories from past sessions:\n${formatResults(memories)}`,
      },
    };
  }
  return {};
};

// Archive transcript before Claude's built-in compaction
const archiveBeforeCompact: HookCallback = async (input, toolUseId, { signal }) => {
  if (input.hook_event_name !== "PreCompact") return {};

  const transcriptPath = (input as any).transcript_path;
  if (transcriptPath) {
    await engine.append({
      conversationId: currentConversationId,
      events: await parseTranscript(transcriptPath),
    });
  }
  return {};
};

// Persist session summary on stop
const persistOnStop: HookCallback = async (input, toolUseId, { signal }) => {
  if (input.hook_event_name !== "Stop") return {};

  await engine.append({
    conversationId: currentConversationId,
    events: [{
      role: "system",
      content: "Session ended. Compacting to long-term memory.",
    }],
  });

  // Run compaction to create summary nodes
  await engine.runCompaction({
    conversationId: currentConversationId,
    trigger: "soft",
  });

  return {};
};

// Index file changes into the ledger
const indexFileChanges: HookCallback = async (input, toolUseId, { signal }) => {
  if (input.hook_event_name !== "PostToolUse") return {};

  const toolInput = (input as any).tool_input || {};
  const filePath = toolInput.file_path || toolInput.path;

  if (filePath) {
    await engine.storeArtifact({
      conversationId: currentConversationId,
      source: { kind: "path", path: filePath },
    });
  }
  return {};
};

// --- Run the Agent ---
for await (const message of query({
  prompt: "Refactor the authentication module",
  options: {
    mcpServers: { ledgermind: memoryServer },
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Grep", "Glob",
      "mcp__ledgermind__*",
    ],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        "You have access to LedgerMind long-term memory tools.",
        "At the start of each task: use memory_recall to check for relevant context from past sessions.",
        "When making important decisions: use memory_store to persist them for future reference.",
        "Available memory tools: memory_recall, memory_grep, memory_describe.",
      ].join("\n"),
    },
    hooks: {
      UserPromptSubmit: [{ hooks: [injectMemories] }],
      PreCompact: [{ hooks: [archiveBeforeCompact] }],
      Stop: [{ hooks: [persistOnStop] }],
      PostToolUse: [
        { matcher: "Write|Edit|MultiEdit", hooks: [indexFileChanges] },
      ],
    },
    permissionMode: "acceptEdits",
  },
})) {
  process.stdout.write(formatMessage(message));
}
```

### 5.3 Python Agent SDK

```python
import asyncio
from claude_agent_sdk import (
    query, tool, create_sdk_mcp_server,
    ClaudeAgentOptions, HookMatcher, ResultMessage,
)
from ledgermind import create_memory_engine

engine = await create_memory_engine(storage="postgres", connection_url="...")

# --- MCP Tools ---
@tool("memory_recall", "Search long-term memory", {"query": str, "max_results": int})
async def memory_recall(args):
    results = await engine.grep(pattern=args["query"])
    return {"content": [{"type": "text", "text": format_results(results)}]}

@tool("memory_store", "Persist to long-term memory", {"content": str, "tags": list})
async def memory_store(args):
    await engine.append(conversation_id=current_id, events=[{
        "role": "assistant",
        "content": args["content"],
        "metadata": {"tags": args.get("tags", [])},
    }])
    return {"content": [{"type": "text", "text": "Stored."}]}

@tool("memory_grep", "Regex search across memory", {"pattern": str})
async def memory_grep(args):
    results = await engine.grep(pattern=args["pattern"])
    return {"content": [{"type": "text", "text": format_results(results)}]}

memory_server = create_sdk_mcp_server(
    name="ledgermind", version="1.0.0",
    tools=[memory_recall, memory_store, memory_grep],
)

# --- Hooks ---
async def inject_memories(input_data, tool_use_id, context):
    prompt = input_data.get("prompt", "")
    memories = await engine.grep(pattern=extract_key_terms(prompt))
    if memories.matches:
        return {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": f"Past session context:\n{format_results(memories)}",
            }
        }
    return {}

async def archive_before_compact(input_data, tool_use_id, context):
    transcript_path = input_data.get("transcript_path")
    if transcript_path:
        events = await parse_transcript(transcript_path)
        await engine.append(conversation_id=current_id, events=events)
    return {}

async def persist_on_stop(input_data, tool_use_id, context):
    await engine.run_compaction(conversation_id=current_id, trigger="soft")
    return {}

# --- Run ---
async def main():
    options = ClaudeAgentOptions(
        mcp_servers={"ledgermind": memory_server},
        allowed_tools=["Read", "Write", "Edit", "Bash", "mcp__ledgermind__*"],
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": (
                "You have LedgerMind long-term memory.\n"
                "Use memory_recall at task start to check past context.\n"
                "Use memory_store for important decisions."
            ),
        },
        hooks={
            "UserPromptSubmit": [HookMatcher(hooks=[inject_memories])],
            "PreCompact": [HookMatcher(hooks=[archive_before_compact])],
            "Stop": [HookMatcher(hooks=[persist_on_stop])],
        },
        permission_mode="acceptEdits",
    )

    async for msg in query(prompt="Fix the authentication bug", options=options):
        if isinstance(msg, ResultMessage) and msg.subtype == "success":
            print(msg.result)

asyncio.run(main())
```

---

## 6. Option C: Hooks-Only (Transparent)

No MCP tools — memory is silently injected/extracted via hooks. Claude doesn't need to "know" about the memory system.

### 6.1 Shell-Based Hooks (settings.json)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ledgermind inject-context"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "ledgermind index-change",
            "async": true
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ledgermind archive-transcript"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ledgermind persist-session"
          }
        ]
      }
    ]
  }
}
```

### 6.2 CLI Commands

```bash
# ledgermind inject-context
# Reads JSON from stdin (UserPromptSubmit input), outputs additionalContext
#!/bin/bash
PROMPT=$(jq -r '.prompt' < /dev/stdin)
MEMORIES=$(ledgermind recall --query "$PROMPT" --format text --max 3)

if [ -n "$MEMORIES" ]; then
  jq -n --arg ctx "$MEMORIES" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: ("Relevant context from past sessions:\n" + $ctx)
    }
  }'
fi
```

---

## 7. Option D: Plugin (Distributable)

### 7.1 Plugin Structure

```
ledgermind-plugin/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── commands/
│   ├── recall.md           # /recall <query> — search memory
│   ├── forget.md           # /forget <id> — mark memory as deprecated
│   └── memory-status.md    # /memory-status — show memory stats
├── agents/
│   └── memory-reviewer.md  # Sub-agent for reviewing memory relevance
├── skills/
│   └── memory-aware-coding/
│       └── SKILL.md         # Skill: auto-loaded when coding tasks detected
└── hooks/
    ├── inject-context.sh
    ├── index-changes.sh
    └── persist-session.sh
```

### 7.2 plugin.json

```json
{
  "name": "ledgermind",
  "version": "1.0.0",
  "description": "Long-term memory for Claude Code powered by LedgerMind",
  "mcpServers": {
    "ledgermind": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/ledgermind-mcp",
      "args": ["--db", "${LEDGERMIND_DB_URL:-postgres://localhost/ledgermind}"],
      "env": {}
    }
  }
}
```

### 7.3 Skill Definition (SKILL.md)

```markdown
---
name: memory-aware-coding
description: Automatically recall relevant memory at task start and persist decisions
triggers:
  - "implement"
  - "fix"
  - "refactor"
  - "debug"
  - "add feature"
---

# Memory-Aware Coding

When starting any coding task:

1. **Recall**: Use `memory_recall` with a summary of the current task
2. **Check context**: Review returned memories for relevant decisions, patterns, or warnings
3. **Work**: Complete the task using recalled context
4. **Persist**: Use `memory_store` to save:
   - Key decisions made and why
   - Patterns discovered
   - Warnings for future sessions
   - Architecture changes
```

---

## 8. PreCompact Hook — The Key Integration Point

Claude Code has its own built-in context compaction. The `PreCompact` hook fires **before** this happens, giving LedgerMind the chance to archive the full transcript.

### 8.1 Why This Matters

```
Session starts → messages accumulate → context fills up
                                          │
                                    ┌─────▼──────┐
                                    │ PreCompact  │ ← LedgerMind archives FULL transcript
                                    │   Hook      │   to its immutable ledger + DAG
                                    └─────┬──────┘
                                          │
                                    ┌─────▼──────┐
                                    │ Claude Code │ ← Built-in compaction runs
                                    │ Compaction  │   (loses detail)
                                    └─────┬──────┘
                                          │
                                    Session continues with compressed context
                                    BUT LedgerMind has full history available
                                    via memory_grep / memory_expand tools
```

### 8.2 Implementation

```typescript
// PreCompact hook — archive before Claude's compaction destroys detail
const archiveBeforeCompact: HookCallback = async (input, toolUseId, { signal }) => {
  const transcriptPath = input.transcript_path;
  const trigger = (input as any).trigger; // "manual" | "auto"

  // Read the full JSONL transcript
  const transcript = await readTranscript(transcriptPath);

  // Append all messages to LedgerMind's immutable ledger
  await engine.append({
    conversationId: getSessionConversationId(input.session_id),
    events: transcript.map(msg => ({
      role: msg.role,
      content: msg.content,
      metadata: { source: "claude-code", trigger },
    })),
  });

  // Run LedgerMind's own compaction (hierarchical DAG summaries)
  await engine.runCompaction({
    conversationId: getSessionConversationId(input.session_id),
    trigger: "soft",
  });

  // Optionally inject summary back into Claude's context
  const summary = await engine.materializeContext({
    conversationId: getSessionConversationId(input.session_id),
    budgetTokens: 4000, // Compact summary for Claude's compacted context
    overheadTokens: 0,
  });

  return {
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: [
        "LedgerMind has archived the full conversation to long-term memory.",
        "Use memory_grep or memory_recall to access detailed history.",
        `Key context summary:\n${summary.systemPreamble}`,
      ].join("\n"),
    },
  };
};
```

---

## 9. Tool Definitions

### 9.1 Core Memory Tools

| Tool | Description | When to Use |
|------|------------|-------------|
| `memory_recall` | Semantic search across all past sessions | Start of every task |
| `memory_grep` | Regex search across immutable history | When looking for specific patterns |
| `memory_describe` | Metadata for summary/artifact IDs | When needing details about a memory reference |
| `memory_expand` | Retrieve original messages under a summary | When summary is too compressed |
| `memory_store` | Persist important context to ledger | After making key decisions |

### 9.2 Tool Search Integration

When LedgerMind exposes many tools, use Claude Code's MCP tool search to avoid context bloat:

```typescript
options: {
  env: {
    ENABLE_TOOL_SEARCH: "auto:5"  // Dynamic tool loading at 5% threshold
  }
}
```

---

## 10. System Prompt Integration

### 10.1 Preset + Append (Recommended)

Keep Claude Code's full coding intelligence, add memory awareness:

```typescript
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: `
You have access to LedgerMind long-term memory that persists across sessions.

## Memory Tools
- memory_recall(query): Search past sessions for relevant context
- memory_grep(pattern): Regex search across all archived conversations
- memory_describe(id): Get metadata for a summary or file reference
- memory_expand(summary_id): Retrieve original messages (when summary is insufficient)
- memory_store(content, tags): Save important decisions for future sessions

## Memory Protocol
1. At task start: call memory_recall with a brief task summary
2. When making architectural decisions: check memory for prior decisions
3. After completing work: call memory_store with key decisions and rationale
4. When you see [Summary ID: sum_xxx]: you can use memory_expand to get full details
`
}
```

### 10.2 CLAUDE.md Integration

For teams using Claude Code directly (without the Agent SDK), add memory instructions to `CLAUDE.md`:

```markdown
## Long-Term Memory (LedgerMind)

This project uses LedgerMind for cross-session memory.
MCP server "ledgermind" provides memory tools.

When starting a task, check memory:
- Use `mcp__ledgermind__memory_recall` with a task summary
- Review returned context for relevant prior decisions

After completing significant work:
- Use `mcp__ledgermind__memory_store` with key decisions and rationale
```

---

## 11. Session Lifecycle & Memory Flow

```
┌─ SessionStart ──────────────────────────────────────────┐
│  Hook: Initialize LedgerMind engine                      │
│  Hook: Create or resume conversation in ledger           │
└──────────────────────────┬──────────────────────────────┘
                           │
┌─ UserPromptSubmit ───────▼──────────────────────────────┐
│  Hook: Search memory for relevant context                │
│  Hook: Inject additionalContext with past memories       │
│  Tool: Claude may also call memory_recall explicitly     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌─ Agent Working ──────────▼──────────────────────────────┐
│  PreToolUse: (optional) inject file-specific memories    │
│  PostToolUse: Index file changes to ledger (async)       │
│  Tool calls: Claude uses memory_grep/describe as needed  │
└──────────────────────────┬──────────────────────────────┘
                           │
┌─ PreCompact ─────────────▼──────────────────────────────┐
│  Hook: Archive FULL transcript to LedgerMind ledger      │
│  Hook: Run LedgerMind compaction (DAG summaries)         │
│  Hook: Inject compact summary back into Claude's context │
│  Then: Claude's built-in compaction runs                 │
└──────────────────────────┬──────────────────────────────┘
                           │
┌─ Stop ───────────────────▼──────────────────────────────┐
│  Hook: Persist final session state to ledger             │
│  Hook: Run soft compaction to create session summary     │
│  Result: Full session archived with hierarchical DAG     │
└─────────────────────────────────────────────────────────┘
```

---

## 12. Configuration Reference

### 12.1 Agent SDK Options for LedgerMind

| Option | Value | Purpose |
|--------|-------|---------|
| `mcpServers` | `{ ledgermind: server }` | Register LedgerMind MCP server |
| `allowedTools` | `["mcp__ledgermind__*", ...]` | Whitelist memory tools |
| `systemPrompt` | `{ type: "preset", preset: "claude_code", append: "..." }` | Memory-aware instructions |
| `hooks.UserPromptSubmit` | `[{ hooks: [injectMemories] }]` | Auto-inject relevant memories |
| `hooks.PreCompact` | `[{ hooks: [archiveTranscript] }]` | Archive before compaction |
| `hooks.PostToolUse` | `[{ matcher: "Write\|Edit", hooks: [indexChanges] }]` | Track file changes |
| `hooks.Stop` | `[{ hooks: [persistSession] }]` | Save session summary |
| `permissionMode` | `"acceptEdits"` | Auto-approve for autonomous agents |
| `settingSources` | `["project"]` | Load project CLAUDE.md and settings |
| `continueConversation` | `true` | Resume previous session |
| `env.MAX_MCP_OUTPUT_TOKENS` | `"50000"` | Increase limit for large memory results |

### 12.2 Environment Variables

| Variable | Description |
|----------|------------|
| `LEDGERMIND_DB_URL` | PostgreSQL connection string |
| `LEDGERMIND_CONVERSATION_ID` | Override conversation ID for session continuity |
| `LEDGERMIND_SOFT_THRESHOLD` | Soft compaction threshold (default: 0.6) |
| `MAX_MCP_OUTPUT_TOKENS` | Claude Code's max MCP output (default: 10000, increase for memory) |
| `ENABLE_TOOL_SEARCH` | Dynamic tool loading for many MCP tools |

---

## 13. Comparison Matrix

| Aspect | MCP Server (A) | Agent SDK (B) | Hooks-Only (C) | Plugin (D) |
|--------|---------------|---------------|-----------------|------------|
| **Setup complexity** | Low | Medium | Low | Medium |
| **Works with CLI** | ✅ | ❌ (SDK only) | ✅ | ✅ |
| **Works with VS Code** | ✅ | ❌ | ✅ | ✅ |
| **Works with Agent SDK** | ✅ | ✅ | ✅ | ✅ |
| **Agent calls tools explicitly** | ✅ | ✅ | ❌ (transparent) | ✅ |
| **Transparent injection** | ❌ | ✅ (via hooks) | ✅ | ✅ |
| **Multi-session memory** | ✅ | ✅ | ✅ | ✅ |
| **Team distribution** | `.mcp.json` | Custom code | `settings.json` | Plugin install |
| **PreCompact archival** | Needs hooks too | ✅ | ✅ | ✅ |
| **Performance** | Good (subprocess) | Best (in-process) | Good (shell) | Good |

---

## 14. Recommended Strategy

### For Claude Code CLI / VS Code Users → **MCP Server + Hooks (A + C)**

1. Ship `@ledgermind/mcp-server` as an npm package
2. Users add via `claude mcp add` or `.mcp.json`
3. Ship hook scripts for `PreCompact` and `Stop` archival
4. Add instructions to `CLAUDE.md`

```bash
# One-line setup
claude mcp add --transport stdio ledgermind -- npx @ledgermind/mcp-server
```

### For Custom Agent Builders → **Agent SDK (B)**

1. Ship `@ledgermind/sdk` + `@ledgermind/claude-agent-adapter`
2. Provides `createLedgerMindAgent()` factory with pre-wired hooks + MCP + system prompt
3. Full programmatic control

```typescript
import { createLedgerMindAgent } from "@ledgermind/claude-agent-adapter";

const agent = await createLedgerMindAgent({
  db: "postgres://localhost/ledgermind",
  summarizer: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
});

for await (const msg of agent.query("Fix the auth bug")) {
  console.log(msg);
}
```

### For Teams → **Plugin (D)**

1. Ship `ledgermind-plugin` with bundled MCP server, hooks, skills, and slash commands
2. Teams install once, everyone gets memory-aware Claude Code
3. Includes `/recall`, `/memory-status` slash commands

### Package Roadmap

| Phase | Package | Description |
|-------|---------|-------------|
| 1 | `@ledgermind/mcp-server` | Standalone MCP server (stdio + HTTP) |
| 1 | `@ledgermind/sdk` | Core engine (from HLD) |
| 2 | `@ledgermind/claude-agent-adapter` | Agent SDK integration (hooks + MCP + prompt) |
| 2 | `@ledgermind/hooks` | Shell hook scripts for CLI users |
| 3 | `ledgermind-plugin` | Full Claude Code plugin |
| 3 | `@ledgermind/mcp-server-http` | HTTP server for multi-tenant |
