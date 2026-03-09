# Quickstart: Basic Tokenizer Adapters

This quickstart describes how to implement and validate the Phase 1 basic tokenizer feature with two selectable behaviors: deterministic estimator and model-aligned tokenizer.

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

Expected: baseline is green before tokenizer changes.

## 2) Confirm existing tokenizer boundary and deterministic baseline

Verify current baseline:

- `TokenizerPort` exists in `packages/application/src/ports/driven/llm/tokenizer.port.ts`
- deterministic adapter exists in `packages/adapters/src/tokenizer/simple-tokenizer.adapter.ts`
- deterministic test double exists in `packages/adapters/src/testing/simple-tokenizer.ts`
- sdk currently hardwires deterministic tokenizer in `packages/sdk/src/index.ts`

Expected: deterministic 1:4 behavior is already implemented and tested.

## 3) Add model-aligned tokenizer adapter (tiktoken-backed)

Implement a new tokenizer adapter in `packages/adapters/src/tokenizer/` for model-aligned counts using one predefined Phase 1 default model family.

Required behavior:

- Implements `TokenizerPort` exactly.
- Produces model-aligned counts for `countTokens(text)`.
- Supports byte-based estimation path in a way consistent with selected model-aligned behavior.

## 4) Add tokenizer output validation and explicit tokenizer errors

Ensure tokenizer outputs are validated before use.

Required behavior:

- Reject invalid outputs (negative, non-finite, invalid integer semantics).
- Throw explicit tokenizer error and stop operation.
- Do not clamp or silently repair invalid values.

## 5) Extend SDK tokenizer configuration and selection

Update `createMemoryEngine()` config surface in `packages/sdk/src/index.ts`:

- Add tokenizer behavior selection at initialization.
- Support deterministic + model-aligned selections.
- Reject unsupported tokenizer selections with clear initialization errors.

Expected outcomes:

- deterministic selection uses existing simple estimator behavior.
- model-aligned selection uses tiktoken-backed adapter.
- invalid selection fails fast.

## 6) Add/extend tests

### 6.1 Adapter tests

- deterministic adapter tests (existing) continue to pass.
- model-aligned adapter tests verify exact fixture counts for default model-family behavior (0% tolerance).

### 6.2 SDK configuration tests

- selecting deterministic behavior wires correct adapter.
- selecting model-aligned behavior wires correct adapter.
- invalid config throws expected configuration error.

### 6.3 Invalid-output tests

- simulate invalid tokenizer output and verify explicit tokenizer error and operation stop behavior.

### 6.4 Integration tests for tokenizer consumers

Run or extend tests around token-dependent flows:

- `run-compaction` token accounting paths
- `store-artifact` text/binary/path token counting paths

Expected: flows remain contract-compatible with either tokenizer behavior.

## 7) Run focused checks

```bash
pnpm vitest run packages/adapters/src/tokenizer/__tests__/simple-tokenizer.adapter.test.ts
pnpm vitest run packages/adapters/src/tokenizer/__tests__/tiktoken-tokenizer.adapter.test.ts
pnpm vitest run packages/sdk/src/**/*.test.ts
pnpm vitest run packages/application/src/use-cases/**/*.test.ts
```

Expected: tokenizer behavior selection and validation tests pass.

## 8) Run full quality gates

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all workspace quality gates pass.

## 9) Acceptance checklist

- [ ] `TokenizerPort` remains unchanged and behavior-substitutable.
- [ ] Deterministic behavior uses 1 token ~= 4 chars/bytes (rounded up).
- [ ] Model-aligned behavior implemented for predefined Phase 1 default model family.
- [ ] SDK supports explicit tokenizer behavior selection.
- [ ] Invalid tokenizer configuration fails initialization clearly.
- [ ] Invalid tokenizer outputs are rejected with explicit tokenizer error and operation stop.
- [ ] Model-aligned fixtures pass exact token-count matching (0% tolerance).
- [ ] Token-dependent flows run with either tokenizer behavior without business-contract changes.
