# Quickstart: Phase 1 Core Explorers

This quickstart describes how to implement and validate the Phase 1 core explorer set:
TypeScript, Python, JSON, Markdown, and Fallback.

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

Expected: baseline is green before explorer changes.

## 2) Confirm existing explorer foundation

Verify current baseline:

- `ExplorerPort` exists in `packages/application/src/ports/driven/explorer/explorer.port.ts`
- `ExplorerRegistryPort` exists in `packages/application/src/ports/driven/explorer/explorer-registry.port.ts`
- deterministic registry exists in `packages/adapters/src/explorers/explorer-registry.ts`
- fallback explorer exists in `packages/adapters/src/explorers/fallback-explorer.ts`
- default registry wiring exists in `packages/adapters/src/explorers/default-explorer-registry.ts`
- orchestration exists in `packages/application/src/use-cases/explore-artifact.ts`

Expected: current behavior resolves and explores via fallback path with typed error mapping.

## 3) Implement specialized explorers

Add new explorer implementations in `packages/adapters/src/explorers/`:

- `typescript-explorer.ts`
- `python-explorer.ts`
- `json-explorer.ts`
- `markdown-explorer.ts`

Each implementation must:

- implement `ExplorerPort` exactly,
- expose deterministic `name`,
- implement deterministic `canHandle` scoring inputs,
- produce structural summaries for its category,
- include required metadata contract keys,
- honor token budget through `maxTokens` handling,
- preserve read-only behavior.

## 4) Update resolver scoring behavior

In registry resolution flow:

- apply weighted selection using extension + MIME/content-type + sniffing signals,
- enforce deterministic tie-break sequence,
- preserve stable registration-order fallback when prior tie-break stages are equal.

Expected outcome:

- repeated identical inputs always resolve to the same explorer,
- disagreements between extension and MIME/content-type are resolved by weighted policy.

## 5) Update default explorer registry wiring

In `createDefaultExplorerRegistry(...)`:

- register specialized explorers,
- keep fallback explorer registered as terminal handling path,
- maintain stable registration order.

Expected outcome:

- all five Phase 1 categories are covered through default SDK composition.

## 6) Enforce metadata and failure contracts

Across specialized + fallback outputs, ensure metadata always includes:

- artifact reference
- selected explorer
- input classification
- score
- confidence
- truncation indicator

For structured failures, include additionally:

- failure classification (`unsupported-readable`, `unsupported-unreadable`, `malformed-structured`)
- failure reason
- actionable guidance

Behavior rules:

- known unreadable/malformed cases => structured failure payload (non-crashing outcome),
- unexpected internal faults => typed operation-level errors via existing use-case error mapping.

## 7) Add stratified sampling baseline for large artifacts

Before summarizing very large inputs:

- sample beginning + middle + end segments,
- summarize using sampled representation,
- disclose sampling + truncation in metadata.

Expected outcome:

- output remains token-budget compliant while preserving navigational context.

## 8) Add/extend tests

### 8.1 Registry tests

Extend `packages/adapters/src/explorers/__tests__/explorer-registry.test.ts` for:

- weighted resolution behavior,
- deterministic tie-break,
- repeated-run determinism,
- extension/MIME disagreement cases.

### 8.2 Explorer tests

Add new tests:

- `typescript-explorer.test.ts`
- `python-explorer.test.ts`
- `json-explorer.test.ts`
- `markdown-explorer.test.ts`

Validate:

- structural summary contract,
- metadata required keys,
- token-limit compliance,
- truncation disclosure,
- stratified sampling behavior for large inputs.

### 8.3 Use-case tests

Extend `packages/application/src/use-cases/__tests__/explore-artifact.test.ts` for:

- structured failure payload behavior for known unreadable/malformed inputs,
- typed operation-level exception behavior for unexpected faults.

## 9) Run focused checks

```bash
pnpm vitest run packages/adapters/src/explorers/__tests__/explorer-registry.test.ts
pnpm vitest run packages/adapters/src/explorers/__tests__/typescript-explorer.test.ts
pnpm vitest run packages/adapters/src/explorers/__tests__/python-explorer.test.ts
pnpm vitest run packages/adapters/src/explorers/__tests__/json-explorer.test.ts
pnpm vitest run packages/adapters/src/explorers/__tests__/markdown-explorer.test.ts
pnpm vitest run packages/application/src/use-cases/__tests__/explore-artifact.test.ts
```

Expected: deterministic selection, metadata contract, token budget, and failure contract tests pass.

## 10) Run full quality gates

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all workspace quality gates pass.

## 11) Acceptance checklist

- [ ] Five Phase 1 explorer categories are covered (TS, Python, JSON, Markdown, Fallback).
- [ ] Resolver uses weighted extension/MIME/sniffing scoring with deterministic tie-break.
- [ ] Same input repeatedly selects the same explorer.
- [ ] Every output includes required metadata contract keys.
- [ ] Known unreadable/malformed cases return structured failure payloads.
- [ ] Unexpected internal faults surface as typed operation-level errors.
- [ ] Large artifact handling applies stratified sampling baseline.
- [ ] All outputs respect caller token limits and disclose truncation when applied.
- [ ] Focused and full test suites pass.
