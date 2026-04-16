# Agent Integration Architecture

## Status

Accepted on 2026-03-21.

## Context

LedgerMind needs one durable integration surface that works for Claude Code today and can also support Amp-style coding agents without pushing runtime-specific concepts into the memory engine. The core engine should stay focused on immutable events, summaries, artifact storage, and retrieval. Runtime packages should stay thin and adapt host-specific lifecycle behavior around that core.

## Decision

LedgerMind adopts an MCP-first integration model.

1. `MemoryEngine` remains the only business-facing API.
2. `packages/adapters` owns the canonical memory tool catalog and remains the single source of truth for external tool definitions.
3. `packages/mcp-server` exposes that catalog over local stdio MCP and owns runtime session binding plus access control.
4. `packages/claude-code` provides lifecycle hooks only: session start, pre-compaction archival, stop-time persistence, and optional post-tool-use artifact indexing.
5. Amp support starts on the same MCP surface and example configs, not with a dedicated Amp runtime package.

## Consequences

1. New runtimes can add transport or lifecycle adapters without editing the core engine or redefining tool semantics.
2. Claude-specific transcript parsing and hook payload handling stay isolated in `@ledgermind/claude-code`.
3. Privileged tool policy stays centralized in the canonical catalog and MCP authorization layer.
4. Session continuity is shared across MCP and Claude hooks through the same binding-store format.
5. Amp integration remains honest about current limits: useful MCP recall is available now, while lifecycle automation waits for verified host hooks.

## Current Surface

| Package | Responsibility | Notes |
| --- | --- | --- |
| `@ledgermind/adapters` | Canonical `memory.recall`, `memory.describe`, `memory.expand` definitions | Read-first rollout with policy metadata |
| `@ledgermind/mcp-server` | Stdio MCP server, tool registry, authorization, session binding | Reused by Claude and Amp-style runtimes |
| `@ledgermind/claude-code` | Hook payload parsing and lifecycle archival commands | No memory semantics duplicated here |

## Non-Goals

1. No HTTP or hosted multi-tenant MCP service in this foundation phase.
2. No bespoke Amp runtime SDK package until MCP usage reveals a gap.
3. No hidden prompt injection as the primary recall mechanism.
