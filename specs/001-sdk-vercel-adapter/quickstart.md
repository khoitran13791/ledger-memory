# Quickstart: SDK Entrypoint and Vercel Memory Adapter

This quickstart describes how to implement and validate the Phase 1 SDK entrypoint + Vercel adapter feature.

## Prerequisites

- Node.js >= 22
- pnpm 9.x
- workspace dependencies installed (`pnpm install`)

## 1) Validate baseline workspace state

From repository root:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: baseline passes before making SDK/adapter changes.

## 2) Confirm current baseline contracts

Verify existing baseline surfaces:

- SDK entrypoint exists: `packages/sdk/src/index.ts` (`createMemoryEngine`)
- Engine runtime contract exists: `packages/application/src/ports/driving/memory-engine.port.ts`
- Tool provider boundary exists: `packages/application/src/ports/driving/tool-provider.port.ts`
- Expand authorization policy exists:
  - `packages/application/src/use-cases/expand.ts`
  - `packages/adapters/src/auth/sub-agent-authorization.adapter.ts`

Expected: generic engine creation and core memory methods are already operational.

## 3) Add SDK named presets for common setups

Implement named presets that delegate to `createMemoryEngine` for:

- in-memory setup
- PostgreSQL setup

Recommended location:

- `packages/sdk/src/presets/` (new)
- update `packages/sdk/src/index.ts` exports

Required behavior:

- Presets must return the same `MemoryEngine` contract as generic create.
- Presets must not duplicate composition logic.
- Invalid preset input must fail with actionable validation feedback.

## 4) Add Vercel memory tool adapter

Create adapter implementation under adapters boundary.

Recommended location:

- `packages/adapters/src/tools/vercel-ai-memory-tools.adapter.ts` (new)
- `packages/adapters/src/tools/index.ts` (new)
- export from `packages/adapters/src/index.ts`

Required behavior:

- Adapter produces runtime-callable memory tool definitions via `ToolProviderPort` semantics.
- Tool bundle must include search, metadata lookup, and controlled expansion operations.
- Expand must require caller context and respect existing runtime authorization gate.

## 5) Standardize tool response envelopes

Ensure every tool execute path returns one consistent structure.

### Success envelope

```ts
{
  ok: true,
  data: { ... },
  references?: {
    summaryIds?: string[];
    artifactIds?: string[];
    eventIds?: string[];
  }
}
```

### Error envelope

```ts
{
  ok: false,
  error: {
    code: string,
    message: string,
    details?: Record<string, unknown>
  }
}
```

Required behavior:

- Unauthorized expand returns controlled structured denial.
- Invalid references/not-found errors map to structured error envelopes.
- Unexpected internal errors map to generic adapter failure code (non-crashing).

## 6) Preserve follow-up references in tool outputs

For successful responses, include identifiers needed by follow-up calls when applicable:

- summary IDs
- artifact IDs
- event IDs

Expected: consumers can chain describe/expand workflows without ad hoc parsing.

## 7) Add or update package exports and dependency wiring

Required updates:

- export adapter public functions/types from adapters package index
- ensure sdk exports include named presets
- if Vercel AI SDK dependency is needed, add it only to adapter package (not application/domain)

## 8) Add automated tests

### 8.1 SDK tests

Update `packages/sdk/src/index.test.ts` (or add dedicated preset tests) to verify:

- generic create works for in-memory and PostgreSQL configs
- named presets return usable engine contracts
- invalid/incomplete initialization fails with actionable errors

### 8.2 Adapter registration tests

Add tests under adapters tools area to verify:

- tool bundle exposes required memory tools
- tool definitions are callable with expected input contracts

### 8.3 Success-path tool execution tests

Verify:

- search and metadata lookup return success envelopes
- references are preserved when relevant

### 8.4 Negative-path tool tests (mandatory)

Verify all defined negative scenarios:

- unauthorized expand -> structured denial envelope
- invalid summary/artifact reference -> structured error envelope
- unexpected internal failure -> consistent generic tool error envelope

Target: 100% coverage of defined negative-path scenarios in scope.

## 9) Run focused checks

```bash
pnpm vitest run packages/sdk/src/index.test.ts
pnpm vitest run packages/adapters/src/tools/**/*.test.ts
pnpm vitest run packages/application/src/use-cases/__tests__/expand.test.ts
pnpm vitest run packages/application/src/use-cases/__tests__/grep.test.ts
pnpm vitest run packages/application/src/use-cases/__tests__/describe.test.ts
```

Expected: SDK + adapter contract behavior passes, including structured negative paths.

## 10) Run full quality gates

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all workspace quality gates pass.

## 11) Acceptance checklist

- [ ] SDK exposes one generic create function plus named presets.
- [ ] SDK supports in-memory and PostgreSQL engine creation paths.
- [ ] Invalid initialization requests fail with actionable validation feedback.
- [ ] Vercel tool bundle provides callable memory search/describe/expand operations.
- [ ] Restricted expand enforces runtime authorization and returns controlled denial output.
- [ ] All tool failures use one consistent structured error envelope.
- [ ] Tool success outputs preserve follow-up references when applicable.
- [ ] 100% of defined negative-path scenarios are covered by automated tests.
- [ ] Full workspace quality gates pass.
