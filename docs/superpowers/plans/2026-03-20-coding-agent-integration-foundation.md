# Coding Agent Integration Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP-first, vendor-neutral integration foundation that lets LedgerMind work cleanly with Claude Code today and Amp-like coding agents next, without leaking runtime-specific concepts into the core memory engine.

**Architecture:** Keep `MemoryEngine` as the only real business API, introduce a canonical memory-tool catalog as the single source of truth for external tools, expose that catalog through a new `@ledgermind/mcp-server` package, and add a thin `@ledgermind/claude-code` lifecycle package for session binding and archival hooks. Amp support should initially consume the same MCP surface and example configs rather than a bespoke runtime package.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspace packages, `@modelcontextprotocol/sdk`, existing `@ledgermind/application` and `@ledgermind/adapters` tool abstractions, Claude Code hooks/configuration, Vitest, and repo-wide `typecheck`/`lint`/`test` quality gates.

---

## Scope And Non-Goals

### In Scope

- A canonical tool catalog shared by all runtime adapters.
- A local stdio MCP server package with read-first memory tools.
- Session binding that maps runtime session/thread identities to LedgerMind `ConversationId` values.
- Claude Code hooks for session resume, pre-compaction archival, and stop-time persistence.
- Claude Code and Amp-facing documentation and example configuration.

### Explicit Non-Goals For This Plan

- HTTP or multi-tenant remote MCP transport.
- Hosted auth, billing, or team memory sharing.
- Embedding/vector retrieval as a prerequisite for MCP rollout.
- A bespoke Amp runtime SDK package before MCP dogfooding proves gaps.
- Hidden, large-scale prompt injection as the primary recall path.

---

## Senior Preflight

## Scope And Critical Paths

- Primary user journey 1: a coding agent starts or resumes a session, resolves a stable LedgerMind conversation, and can explicitly call memory tools.
- Primary user journey 2: Claude Code hits compaction or session end, and LedgerMind archives recoverable context before detail is lost.
- Primary user journey 3: a second runtime such as Amp consumes the same MCP server and achieves useful memory recall without Claude-specific logic in the core.
- Latency-sensitive operations: `memory.recall`, `memory.describe`, and `memory.expand` over local stdio MCP.
- Data sensitivity: code snippets, summaries, transcript fragments, artifact paths, and possibly secrets appearing in tool outputs or messages.

## Architecture Decision

### Components (SRP Analysis)

| Component | Responsibility | Non-Responsibilities |
|-----------|----------------|----------------------|
| Canonical tool catalog | Define memory-tool contracts, policy metadata, and engine-backed execution | Runtime-specific transport wiring |
| MCP server package | Expose canonical tools over MCP transport | Core memory semantics, Claude-specific hooks |
| Session binding layer | Resolve runtime/workspace/session identity to LedgerMind conversations | Memory retrieval logic |
| Claude Code package | Implement hook-driven archival and resume behavior | Tool semantics, generic MCP behavior |
| Docs/examples | Show how Claude Code and Amp consume the system | Core business logic |

### Clean Architecture Verification

- Domain remains unchanged and has zero runtime knowledge.
- Application owns generic tool contracts only; it must not import MCP, Claude, or Amp types.
- Adapters own canonical tool assembly and transport mappers.
- New runtime packages depend inward on `sdk`, `adapters`, and `application`, never the reverse.

### SOLID Evaluation

- SRP: Pass if canonical tool definitions are not duplicated across Vercel, MCP, and hook packages.
- OCP: Pass if new runtimes are added by writing new transport mappers against the catalog rather than editing use cases.
- LSP: Pass if every adapter generated from the canonical catalog preserves tool input validation and output semantics.
- ISP: Pass if runtime packages depend only on the tool catalog and session-binding contracts they actually need.
- DIP: Pass if runtime packages consume `MemoryEngine` and `ToolDefinition` abstractions only.

## Performance Budget

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| `memory.recall` p50 local latency | < 100 ms on in-memory engine | Vitest integration timing + local smoke run |
| `memory.describe` p50 local latency | < 50 ms | Vitest integration timing |
| `memory.expand` p95 local latency | < 250 ms for bounded summary expansion | Vitest integration timing |
| Claude `PreCompact` archival time | < 2 s for normal coding transcripts | Hook smoke test with fixture transcript |
| MCP server startup | < 1 s local cold start | CLI smoke test |

## Security Controls

| Threat | Category | Likelihood | Impact | Mitigation |
|--------|----------|------------|--------|------------|
| Cross-workspace memory leakage | Security | Medium | Critical | Session binding keyed by user + workspace + runtime session; no global default scope |
| Unauthorized raw-context expansion | Security | Medium | High | Keep `memory.expand` privileged and preserve sub-agent authorization checks |
| Prompt-injection persistence via write tools | Security | Medium | High | Ship read tools first; gate write tools behind explicit config and approvals |
| Replay or duplicate hook archival | Reliability | Medium | Medium | Idempotency keys for hook writes and resumable archival commands |
| Runtime adapter drift | Maintainability | High | Medium | Generate all transports from one canonical tool catalog |

## Test Strategy By Layer

| Layer | Test Type | Coverage Target | Focus |
|-------|-----------|-----------------|-------|
| Application contracts | Unit | High | Tool metadata types and contract exports |
| Adapter catalog + Vercel mapper | Unit + integration | High | Shared tool semantics, input validation, references, policy metadata |
| MCP server | Integration | High | Tool registration, execution, session binding, security gates |
| Claude hook package | Integration + smoke | Medium | Hook payload parsing, archival idempotency, injected context boundaries |
| Cross-runtime docs/examples | Smoke | Medium | Example configs remain executable and current |

---

## File Structure

### Existing Files To Modify

- `packages/application/src/ports/driving/tool-provider.port.ts` - enrich generic tool contract with policy metadata needed by MCP and runtime approval surfaces.
- `packages/application/src/index.ts` - export any new tool metadata types.
- `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts` - consume the canonical tool catalog instead of defining tool semantics inline.
- `packages/adapters/src/tools/index.ts` - export new canonical tool modules.
- `packages/adapters/package.json` - add any transport-agnostic dependency needed by the canonical tool catalog only if unavoidable.
- `package.json` - add top-level scripts for MCP server and Claude hook smoke commands.
- `README.md` - add a short integration entry point section linking to Claude Code and Amp docs.
- `docs/claude-code-integration.md` - align the existing design document with implemented package names and phased rollout.

### New Files To Create In Existing Packages

- `packages/adapters/src/tools/canonical-memory-tool-catalog.ts` - single source of truth for memory tool definitions backed by `MemoryEngine`.
- `packages/adapters/src/tools/tool-policy.ts` - shared tool policy metadata helpers and types if `tool-provider.port.ts` becomes too crowded.
- `packages/adapters/src/tools/shared/input-parsers.ts` - shared runtime-agnostic parsing and validation helpers extracted from the Vercel adapter.
- `packages/adapters/src/tools/shared/reference-derivation.ts` - shared reference-envelope and provenance logic reused by Vercel and MCP.
- `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts` - locks tool names, metadata, and execution behavior.

### New MCP Server Package

- `packages/mcp-server/package.json` - package metadata, scripts, and CLI bin entry.
- `packages/mcp-server/tsconfig.json` - package TypeScript config.
- `packages/mcp-server/src/index.ts` - public exports and server bootstrap.
- `packages/mcp-server/src/cli.ts` - stdio server entry point.
- `packages/mcp-server/src/config.ts` - env/CLI parsing for DB config, scope defaults, and optional write-tool toggles.
- `packages/mcp-server/src/server.ts` - MCP server composition root.
- `packages/mcp-server/src/tool-registry.ts` - maps canonical tool definitions to MCP tool registrations.
- `packages/mcp-server/src/session-binding.ts` - runtime/workspace/session identity model and `ConversationId` resolution.
- `packages/mcp-server/src/session-binding-store.ts` - persistence contract for session bindings.
- `packages/mcp-server/src/file-session-binding-store.ts` - local durable binding store for stdio users.
- `packages/mcp-server/src/authorization.ts` - MCP-specific access checks for read/write/privileged tools.
- `packages/mcp-server/src/__tests__/config.test.ts` - config parsing tests.
- `packages/mcp-server/src/__tests__/tool-registry.test.ts` - tool exposure and execution tests.
- `packages/mcp-server/src/__tests__/session-binding.test.ts` - scope and persistence tests.
- `packages/mcp-server/src/__tests__/authorization.test.ts` - privileged access and write gating tests.
- `packages/mcp-server/src/__tests__/server.integration.test.ts` - in-process end-to-end MCP execution tests.

### New Claude Code Package

- `packages/claude-code/package.json` - package metadata, scripts, and CLI bins for hook commands.
- `packages/claude-code/tsconfig.json` - package TypeScript config.
- `packages/claude-code/src/index.ts` - public exports.
- `packages/claude-code/src/config.ts` - Claude package config parsing for engine connection, scope defaults, and injected-budget limits.
- `packages/claude-code/src/context.ts` - shared hook payload parsing and session identity extraction.
- `packages/claude-code/src/commands/session-start.ts` - resolve or create session binding and optionally emit a small visible status line.
- `packages/claude-code/src/commands/pre-compact.ts` - archive transcript before Claude compaction and optionally return a compact provenance-backed summary.
- `packages/claude-code/src/commands/stop.ts` - persist end-of-session state and optional summary.
- `packages/claude-code/src/commands/post-tool-use.ts` - optional artifact indexing for file edits and tool results.
- `packages/claude-code/src/templates/settings.json.example` - hook config example.
- `packages/claude-code/src/templates/CLAUDE.md.example` - concise memory-aware operating instructions.
- `packages/claude-code/src/__tests__/context.test.ts` - hook payload parsing tests.
- `packages/claude-code/src/__tests__/pre-compact.test.ts` - archival/idempotency tests.
- `packages/claude-code/src/__tests__/stop.test.ts` - session persistence tests.
- `packages/claude-code/src/__tests__/post-tool-use.test.ts` - artifact indexing tests.

### Documentation And Examples

- `docs/agent-integration-architecture.md` - concise architecture decision record for MCP-first integration.
- `docs/ampcode-integration.md` - Amp-facing usage and limitations, intentionally MCP-first.
- `examples/claude-code/.mcp.json` - local MCP registration example.
- `examples/claude-code/settings.json` - Claude hook example.
- `examples/ampcode/README.md` - Amp setup instructions using the same MCP server.
- `examples/ampcode/mcp-config.json` - MCP config example for Amp-style runtimes.

---

## Chunk 1: Canonical Tool Catalog

### Task 1: Enrich the generic tool contract with policy metadata

**Files:**
- Modify: `packages/application/src/ports/driving/tool-provider.port.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts`

- [ ] **Step 1: Write a failing catalog test before touching the contract.**

Create `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts` that asserts the catalog exposes `memory.recall`, `memory.describe`, and `memory.expand`, and that each tool includes policy metadata like access level and approval hints.

- [ ] **Step 2: Run the new test to lock the failure mode.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/canonical-memory-tool-catalog.test.ts`

Expected: FAIL because the catalog and metadata fields do not exist yet.

- [ ] **Step 3: Extend `ToolDefinition` with transport-safe policy metadata.**

Modify `packages/application/src/ports/driving/tool-provider.port.ts` to add fields such as `access`, `requiresApproval`, `subAgentOnly`, and `idempotent` while preserving the existing `execute(input)` contract.

- [ ] **Step 4: Re-export the new metadata types.**

Update `packages/application/src/index.ts` so downstream runtime packages can consume the metadata without importing deep internal paths.

- [ ] **Step 5: Re-run the failing adapters test.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/canonical-memory-tool-catalog.test.ts`

Expected: FAIL now for missing catalog implementation rather than missing metadata types.

- [ ] **Step 6: Typecheck application and adapters together before moving on.**

Run: `pnpm --filter @ledgermind/application typecheck && pnpm --filter @ledgermind/adapters typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the contract change separately.**

Run:

```bash
git add packages/application/src/ports/driving/tool-provider.port.ts packages/application/src/index.ts packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts
git commit -m "feat: add policy metadata to tool definitions"
```

### Task 2: Build the canonical memory-tool catalog in adapters

**Files:**
- Create: `packages/adapters/src/tools/canonical-memory-tool-catalog.ts`
- Create: `packages/adapters/src/tools/shared/input-parsers.ts`
- Create: `packages/adapters/src/tools/shared/reference-derivation.ts`
- Modify: `packages/adapters/src/tools/index.ts`
- Modify: `packages/adapters/src/tools/__tests__/canonical-memory-tool-catalog.test.ts`

- [ ] **Step 1: Expand the failing test to cover execution semantics.**

Add assertions that `memory.describe` and `memory.expand` preserve current input validation and return provenance references in the same shape the Vercel adapter expects today.

- [ ] **Step 2: Run the expanded test.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/canonical-memory-tool-catalog.test.ts`

Expected: FAIL with missing catalog module and helpers.

- [ ] **Step 3: Extract runtime-agnostic parsing helpers from the Vercel adapter.**

Create `shared/input-parsers.ts` for object validation, required-string reads, and caller-context parsing so the same logic can back both Vercel and MCP transports.

- [ ] **Step 4: Extract shared provenance/reference helpers.**

Create `shared/reference-derivation.ts` for success/error envelopes and reference derivation so tool outputs stay semantically identical across transports.

- [ ] **Step 5: Implement `canonical-memory-tool-catalog.ts`.**

Expose a single `createCanonicalMemoryToolCatalog(engine)` function that returns the public read-first tools with policy metadata and transport-agnostic execution behavior.

- [ ] **Step 6: Export the catalog cleanly from the adapters package.**

Update `packages/adapters/src/tools/index.ts` to export the catalog and any stable helper types needed by runtime packages.

- [ ] **Step 7: Re-run catalog tests and existing Vercel tests as a regression baseline.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/canonical-memory-tool-catalog.test.ts src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts`

Expected: catalog test PASS, Vercel adapter test still FAIL or partially fail until the next task rewires it.

- [ ] **Step 8: Commit the catalog implementation.**

Run:

```bash
git add packages/adapters/src/tools
git commit -m "feat: add canonical memory tool catalog"
```

### Task 3: Refactor the Vercel adapter to consume the catalog

**Files:**
- Modify: `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts`
- Modify: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts`
- Modify: `packages/adapters/src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts`

- [ ] **Step 1: Write one regression test that proves the adapter delegates to the shared catalog.**

Add an assertion that the Vercel adapter exposes exactly the same tool names and metadata as the canonical catalog, not an independently defined list.

- [ ] **Step 2: Run just the Vercel adapter tests.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts`

Expected: FAIL before the refactor.

- [ ] **Step 3: Replace inline tool construction with catalog-to-Vercel mapping.**

Refactor `vercel-ai-memory-tools.adapter.ts` so transport-specific code only maps canonical definitions into `ai.tool(...)` registrations.

- [ ] **Step 4: Preserve current envelope behavior exactly.**

Ensure error mapping, success envelopes, and returned references remain byte-for-byte compatible with the existing tests.

- [ ] **Step 5: Re-run all tool adapter tests.**

Run: `pnpm --filter @ledgermind/adapters test -- --run src/tools/__tests__/canonical-memory-tool-catalog.test.ts src/tools/__tests__/vercel-ai-memory-tools.adapter.test.ts src/tools/__tests__/vercel-ai-memory-tools-exports.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full adapters quality gates before committing.**

Run: `pnpm --filter @ledgermind/adapters typecheck && pnpm --filter @ledgermind/adapters lint && pnpm --filter @ledgermind/adapters test`

Expected: PASS.

- [ ] **Step 7: Commit the refactor as a dedicated change.**

Run:

```bash
git add packages/adapters/src/tools
git commit -m "refactor: map vercel tools from canonical memory catalog"
```

---

## Chunk 2: MCP Server Foundation

### Task 4: Scaffold `@ledgermind/mcp-server`

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/src/cli.ts`
- Create: `packages/mcp-server/src/config.ts`
- Create: `packages/mcp-server/src/__tests__/config.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Copy an existing package shape before any server logic.**

Create `packages/mcp-server` using the same workspace conventions as `packages/sdk` and `packages/adapters`, but name the package `@ledgermind/mcp-server` and expose a CLI bin for local stdio usage.

- [ ] **Step 2: Add root scripts for local MCP smoke use.**

Modify `package.json` to add `mcp:dev` and `mcp:smoke` scripts that delegate into the new package.

- [ ] **Step 3: Write `config.test.ts` first.**

Assert that config parsing handles storage choice, optional binding-store path, default read-only mode, and an opt-in write-tools flag.

- [ ] **Step 4: Run the package test to confirm it fails.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/config.test.ts`

Expected: FAIL because the package and config module do not exist yet.

- [ ] **Step 5: Implement minimal config and CLI bootstrap.**

Add `src/config.ts`, `src/index.ts`, and `src/cli.ts` with real option names and no placeholder TODOs.

- [ ] **Step 6: Re-run config tests and package typecheck.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/config.test.ts && pnpm --filter @ledgermind/mcp-server typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the scaffold separately.**

Run:

```bash
git add packages/mcp-server package.json
git commit -m "feat: scaffold mcp server package"
```

### Task 5: Register canonical tools over MCP

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/src/tool-registry.ts`
- Create: `packages/mcp-server/src/__tests__/tool-registry.test.ts`
- Create: `packages/mcp-server/src/__tests__/server.integration.test.ts`

- [ ] **Step 1: Write a failing registry test for the public tool surface.**

Assert that the MCP server registers `memory.recall`, `memory.describe`, and `memory.expand` from the canonical catalog, and that the MCP tool schemas mirror the catalog parameters.

- [ ] **Step 2: Run the failing registry test.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/tool-registry.test.ts`

Expected: FAIL due to missing server and registry modules.

- [ ] **Step 3: Implement `tool-registry.ts` as a pure mapper.**

Map canonical tool definitions into MCP registrations without redefining tool semantics or transport policy rules in multiple places.

- [ ] **Step 4: Implement `server.ts` as the package composition root.**

Wire config, engine creation, and MCP registration together while keeping transport startup out of business logic.

- [ ] **Step 5: Add an in-process integration test.**

Create `server.integration.test.ts` that boots the server against an in-memory engine and verifies a sample `memory.describe` call returns structured content and provenance.

- [ ] **Step 6: Re-run registry and integration tests.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/tool-registry.test.ts src/__tests__/server.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit tool registration once green.**

Run:

```bash
git add packages/mcp-server/src/server.ts packages/mcp-server/src/tool-registry.ts packages/mcp-server/src/__tests__
git commit -m "feat: expose canonical memory tools over mcp"
```

---

## Chunk 3: Session Binding, Security, And Write Controls

### Task 6: Implement local session binding for runtime/workspace/session identity

**Files:**
- Create: `packages/mcp-server/src/session-binding.ts`
- Create: `packages/mcp-server/src/session-binding-store.ts`
- Create: `packages/mcp-server/src/file-session-binding-store.ts`
- Create: `packages/mcp-server/src/__tests__/session-binding.test.ts`
- Modify: `packages/mcp-server/src/config.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Write a failing session-binding test that encodes the scope model.**

Assert that the same user + workspace + runtime session resolves to the same LedgerMind `ConversationId`, a different workspace does not, and a child session can optionally carry a parent conversation reference.

- [ ] **Step 2: Run the failing session-binding test.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/session-binding.test.ts`

Expected: FAIL because the binding modules do not exist.

- [ ] **Step 3: Define the session-binding data model.**

Implement a small record that captures `runtime`, `runtimeSessionId`, `userScope`, `workspaceScope`, optional `branchScope`, `conversationId`, and optional `parentConversationId`.

- [ ] **Step 4: Add a durable local store implementation.**

Implement `file-session-binding-store.ts` so local stdio MCP users keep stable session continuity across process restarts.

- [ ] **Step 5: Wire session binding into server startup and tool execution context.**

Ensure tool calls can resolve `conversationId` consistently without changing `MemoryEngine` itself.

- [ ] **Step 6: Re-run session-binding tests and the server integration test.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/session-binding.test.ts src/__tests__/server.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the binding layer separately.**

Run:

```bash
git add packages/mcp-server/src/session-binding.ts packages/mcp-server/src/session-binding-store.ts packages/mcp-server/src/file-session-binding-store.ts packages/mcp-server/src/__tests__/session-binding.test.ts packages/mcp-server/src/config.ts packages/mcp-server/src/server.ts
git commit -m "feat: add mcp session binding for runtime conversations"
```

### Task 7: Enforce privileged access and read-first rollout rules

**Files:**
- Create: `packages/mcp-server/src/authorization.ts`
- Create: `packages/mcp-server/src/__tests__/authorization.test.ts`
- Modify: `packages/mcp-server/src/tool-registry.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Write failing authorization tests first.**

Assert that `memory.expand` is blocked when the caller is not an authorized sub-agent and that write tools are hidden or rejected unless the config explicitly enables them.

- [ ] **Step 2: Run the authorization tests to confirm the intended failure.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/authorization.test.ts`

Expected: FAIL because access control is not yet enforced by the MCP layer.

- [ ] **Step 3: Implement transport-level policy enforcement.**

Use canonical tool metadata to decide whether a tool is visible, approval-worthy, or privileged for the current runtime context.

- [ ] **Step 4: Keep authorization logic separate from tool mapping.**

`authorization.ts` should answer policy questions; `tool-registry.ts` should only translate catalog entries into MCP registrations.

- [ ] **Step 5: Re-run authorization and integration tests.**

Run: `pnpm --filter @ledgermind/mcp-server test -- --run src/__tests__/authorization.test.ts src/__tests__/server.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full package quality gates before committing.**

Run: `pnpm --filter @ledgermind/mcp-server typecheck && pnpm --filter @ledgermind/mcp-server lint && pnpm --filter @ledgermind/mcp-server test`

Expected: PASS.

- [ ] **Step 7: Commit security rollout controls.**

Run:

```bash
git add packages/mcp-server/src/authorization.ts packages/mcp-server/src/tool-registry.ts packages/mcp-server/src/server.ts packages/mcp-server/src/__tests__/authorization.test.ts
git commit -m "feat: enforce mcp tool access controls"
```

---

## Chunk 4: Claude Code Lifecycle Integration

### Task 8: Scaffold `@ledgermind/claude-code` and parse hook payloads

**Files:**
- Create: `packages/claude-code/package.json`
- Create: `packages/claude-code/tsconfig.json`
- Create: `packages/claude-code/src/index.ts`
- Create: `packages/claude-code/src/config.ts`
- Create: `packages/claude-code/src/context.ts`
- Create: `packages/claude-code/src/__tests__/context.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the package scaffold before implementing any hook commands.**

Use the same workspace conventions as the other packages and expose CLI bins for each hook command.

- [ ] **Step 2: Add root helper scripts for local hook smoke runs.**

Modify the repo `package.json` to add scripts like `claude:hook:precompact:smoke` and `claude:hook:stop:smoke`.

- [ ] **Step 3: Write the failing context-parsing test first.**

Assert that Claude hook payloads are parsed into a normalized runtime context containing session id, cwd/workspace root, hook name, and optional transcript/tool payload.

- [ ] **Step 4: Run the new test to confirm failure.**

Run: `pnpm --filter @ledgermind/claude-code test -- --run src/__tests__/context.test.ts`

Expected: FAIL because the package modules do not exist yet.

- [ ] **Step 5: Implement `config.ts` and `context.ts`.**

Keep this package focused on Claude payload parsing and config only; do not duplicate memory retrieval logic here.

- [ ] **Step 6: Re-run the context test and typecheck.**

Run: `pnpm --filter @ledgermind/claude-code test -- --run src/__tests__/context.test.ts && pnpm --filter @ledgermind/claude-code typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the package scaffold.**

Run:

```bash
git add packages/claude-code package.json
git commit -m "feat: scaffold claude code integration package"
```

### Task 9: Implement `pre-compact` and `stop` hook commands

**Files:**
- Create: `packages/claude-code/src/commands/pre-compact.ts`
- Create: `packages/claude-code/src/commands/stop.ts`
- Create: `packages/claude-code/src/__tests__/pre-compact.test.ts`
- Create: `packages/claude-code/src/__tests__/stop.test.ts`
- Modify: `packages/claude-code/src/index.ts`

- [ ] **Step 1: Write failing tests for archival and idempotency.**

`pre-compact.test.ts` should assert that the hook archives transcript content exactly once for a repeated event payload. `stop.test.ts` should assert that final session persistence stores a bounded summary or reference block rather than replaying the whole transcript.

- [ ] **Step 2: Run the hook tests to confirm missing implementation.**

Run: `pnpm --filter @ledgermind/claude-code test -- --run src/__tests__/pre-compact.test.ts src/__tests__/stop.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `pre-compact.ts` against the session-binding and engine APIs.**

Use idempotency keys, archive before compaction, and return only a small provenance-backed summary when configured.

- [ ] **Step 4: Implement `stop.ts` as end-of-session persistence only.**

Keep it focused on archival and summary persistence; do not turn it into a hidden retrieval engine.

- [ ] **Step 5: Re-run the hook tests.**

Run: `pnpm --filter @ledgermind/claude-code test -- --run src/__tests__/pre-compact.test.ts src/__tests__/stop.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the lifecycle commands.**

Run:

```bash
git add packages/claude-code/src/commands packages/claude-code/src/__tests__ packages/claude-code/src/index.ts
git commit -m "feat: add claude pre-compact and stop hooks"
```

### Task 10: Add optional post-tool-use indexing and hook templates

**Files:**
- Create: `packages/claude-code/src/commands/post-tool-use.ts`
- Create: `packages/claude-code/src/templates/settings.json.example`
- Create: `packages/claude-code/src/templates/CLAUDE.md.example`
- Create: `packages/claude-code/src/__tests__/post-tool-use.test.ts`
- Modify: `README.md`
- Modify: `docs/claude-code-integration.md`

- [ ] **Step 1: Write the post-tool-use test first.**

Assert that file-edit tool payloads can be transformed into artifact captures without indexing unrelated tool calls or leaking outside the current workspace.

- [ ] **Step 2: Run the post-tool-use test to verify the missing implementation.**

Run: `pnpm --filter @ledgermind/claude-code test -- --run src/__tests__/post-tool-use.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `post-tool-use.ts` conservatively.**

Only index edited files and selected tool outputs, and keep the feature config-disabled by default.

- [ ] **Step 4: Add concrete Claude configuration templates.**

Populate `settings.json.example` and `CLAUDE.md.example` with working package names, hook commands, and concise agent instructions.

- [ ] **Step 5: Update top-level and Claude-specific docs.**

`README.md` should point users to the new packages. `docs/claude-code-integration.md` should become implementation-aligned rather than purely aspirational.

- [ ] **Step 6: Re-run package tests and root docs checks if applicable.**

Run: `pnpm --filter @ledgermind/claude-code test && pnpm --filter @ledgermind/claude-code typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the templates and optional indexing command.**

Run:

```bash
git add packages/claude-code README.md docs/claude-code-integration.md
git commit -m "feat: add claude hook templates and optional artifact indexing"
```

---

## Chunk 5: Cross-Runtime Docs, Amp Examples, And Final Verification

### Task 11: Write the architecture ADR and Amp-facing setup docs

**Files:**
- Create: `docs/agent-integration-architecture.md`
- Create: `docs/ampcode-integration.md`
- Create: `examples/claude-code/.mcp.json`
- Create: `examples/claude-code/settings.json`
- Create: `examples/ampcode/README.md`
- Create: `examples/ampcode/mcp-config.json`

- [ ] **Step 1: Write the ADR first, before runtime-specific examples drift.**

Capture the decisions that MCP is the canonical external interface, hooks are secondary lifecycle automation, and Amp support starts with the same MCP server rather than a bespoke package.

- [ ] **Step 2: Write Amp docs as MCP-first, not Claude-cloned.**

Document only verified integration surfaces. If Amp lacks lifecycle hooks equivalent to Claude’s, say so explicitly and keep the integration limited to MCP and session-scoped usage guidance.

- [ ] **Step 3: Add executable example configs.**

Create examples that reference the actual package names and CLI entry points produced by this implementation.

- [ ] **Step 4: Manually smoke the examples locally.**

Run: `pnpm mcp:smoke`

Expected: the MCP server starts and the example configuration points at a resolvable CLI entry.

- [ ] **Step 5: Commit docs and examples together.**

Run:

```bash
git add docs/agent-integration-architecture.md docs/ampcode-integration.md examples/claude-code examples/ampcode
git commit -m "docs: add coding agent integration architecture and examples"
```

### Task 12: Run final quality gates and repository handoff checks

**Files:**
- Modify: none

- [ ] **Step 1: Run focused package quality gates.**

Run:

```bash
pnpm --filter @ledgermind/application typecheck
pnpm --filter @ledgermind/adapters typecheck
pnpm --filter @ledgermind/adapters test
pnpm --filter @ledgermind/mcp-server typecheck
pnpm --filter @ledgermind/mcp-server lint
pnpm --filter @ledgermind/mcp-server test
pnpm --filter @ledgermind/claude-code typecheck
pnpm --filter @ledgermind/claude-code lint
pnpm --filter @ledgermind/claude-code test
```

Expected: PASS.

- [ ] **Step 2: Run repo-level safety nets.**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: PASS, or any existing unrelated failures are documented explicitly in the handoff.

- [ ] **Step 3: Smoke Claude hook commands against fixtures.**

Run the root helper scripts added earlier for `pre-compact` and `stop` hook payload fixtures.

Expected: PASS with stable, bounded output.

- [ ] **Step 4: Verify worktree contents and prepare handoff notes.**

Run: `git status --short`

Expected: only planned files are modified, with unrelated pre-existing changes left untouched and documented as not part of this work.

- [ ] **Step 5: Commit any final verification-only adjustments.**

Run:

```bash
git add -A
git commit -m "chore: finalize coding agent integration foundation"
```

- [ ] **Step 6: Complete the repo landing workflow required by AGENTS.md.**

Run:

```bash
git pull --rebase
bd sync
git push
git status
```

Expected: push succeeds and `git status` shows the branch is up to date with origin.

---

## Sequencing Notes

- Do not start the MCP server package until the canonical tool catalog is real and the Vercel adapter is consuming it; otherwise you will duplicate semantics immediately.
- Do not ship write tools in the first MCP release unless the read surface and authorization tests are already green.
- Do not let the Claude package invent new tool semantics; it only binds lifecycle events to the existing engine and session-binding model.
- Do not build an Amp-specific runtime package until the MCP-first examples reveal a real integration gap.

## Exit Criteria

- One canonical tool catalog powers at least Vercel and MCP transports.
- `@ledgermind/mcp-server` can run locally over stdio and expose read-first memory tools.
- Session binding preserves conversation continuity by runtime + workspace + session scope.
- Claude Code hooks archive context before compaction and persist session state at stop.
- Docs and examples show Claude Code and Amp-style runtimes using the same MCP surface.
- All targeted and repo-level quality gates pass.

Plan complete and saved to `docs/superpowers/plans/2026-03-20-coding-agent-integration-foundation.md`. Ready to execute?
