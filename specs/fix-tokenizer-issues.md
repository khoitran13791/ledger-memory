# Task: Fix 5 Tokenizer Issues in LedgerMind

You are working on the LedgerMind project — a clean architecture memory engine for LLM agents. The "Basic tokenizer" deliverable in Phase 1 has been verified against the HLD (`docs/high-level-design.md`) and addendum (`docs/design-decisions-addendum.md`). 5 issues were found. Implement all 5 fixes below.

**IMPORTANT:** Read each file mentioned before modifying. Follow existing code conventions (branded types, `Object.freeze`, domain constructors, port injection via deps). Run `npx turbo run test --filter=@ledgermind/adapters` after changes to ensure all tests pass.

---

## Issue 1 (MEDIUM): Fix `TiktokenTokenizerAdapter.estimateFromBytes` invalid input handling

File: `packages/adapters/src/tokenizer/tiktoken-tokenizer.adapter.ts`

### Problem

Line 32-34: When `byteLength` is negative or non-integer, the code does `return createTokenCount(byteLength)` which delegates the throw to `createTokenCount`'s invariant check. This is misleading control flow — it uses a constructor as an error-throwing mechanism. It also interacts badly with `ValidatingTokenizerAdapter`, which wraps *all* delegate exceptions as `InvalidTokenizerOutputError`, misclassifying an input validation error as an output error.

### Fix

Replace the misleading pattern with an explicit throw. Import `InvariantViolationError` from `@ledgermind/domain` and throw directly:

```typescript
// Before (misleading):
if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
  return createTokenCount(byteLength); // throws indirectly
}

// After (explicit):
if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
  throw new InvariantViolationError(
    'estimateFromBytes: byteLength must be a non-negative safe integer.',
  );
}
```

---

## Issue 2 (LOW): Add HLD-aligned re-export files for file naming compliance

### Problem

HLD §10 package structure (lines 1152-1154) expects:
- `tokenizer/tiktoken.adapter.ts`
- `tokenizer/simple-estimator.adapter.ts`

Actual files are named:
- `tokenizer/tiktoken-tokenizer.adapter.ts`
- `tokenizer/simple-tokenizer.adapter.ts`

### Fix

Add thin re-export shim files with the HLD-expected names. Do NOT rename or move existing files — that would churn imports across the codebase.

Create `packages/adapters/src/tokenizer/tiktoken.adapter.ts`:

```typescript
export { TiktokenTokenizerAdapter } from './tiktoken-tokenizer.adapter';
export type { TiktokenTokenizerAdapterOptions } from './tiktoken-tokenizer.adapter';
```

Create `packages/adapters/src/tokenizer/simple-estimator.adapter.ts`:

```typescript
export { SimpleTokenizerAdapter } from './simple-tokenizer.adapter';
```

Update `packages/adapters/src/tokenizer/index.ts` to also export from the new shim files (or verify the existing exports already cover the same symbols — if so, no index change needed).

---

## Issue 3 (LOW): Add comprehensive tokenizer unit tests

### Problem

Only a single export smoke test exists (`tokenizer-exports.test.ts`). No coverage for rounding, empty strings, invalid inputs, monotonicity, or decorator error behavior.

### Fix

Create three new test files:

### 3a: `packages/adapters/src/tokenizer/__tests__/simple-tokenizer.adapter.test.ts`

Test cases:
- `countTokens('')` returns `{ value: 0 }` (empty string)
- `countTokens('abcd')` returns `{ value: 1 }` (exact multiple of 4)
- `countTokens('ab')` returns `{ value: 1 }` (rounds up)
- `countTokens('abcde')` returns `{ value: 2 }` (rounds up past boundary)
- `estimateFromBytes(0)` returns `{ value: 0 }`
- `estimateFromBytes(4)` returns `{ value: 1 }`
- `estimateFromBytes(5)` returns `{ value: 2 }` (rounds up)
- Consistency: `countTokens(text).value === estimateFromBytes(text.length).value` for ASCII text

### 3b: `packages/adapters/src/tokenizer/__tests__/tiktoken-tokenizer.adapter.test.ts`

Test cases:
- `countTokens('hello world')` returns a value > 0
- `countTokens('')` returns `{ value: 0 }`
- `estimateFromBytes(0)` returns `{ value: 0 }`
- `estimateFromBytes(-1)` throws `InvariantViolationError` (after Issue 1 fix)
- `estimateFromBytes(NaN)` throws `InvariantViolationError` (after Issue 1 fix)
- `estimateFromBytes(1.5)` throws `InvariantViolationError` (after Issue 1 fix)
- Monotonicity: `countTokens('hello').value <= countTokens('hello world foo bar').value`
- Large byte estimation: `estimateFromBytes(100000).value > 0`

### 3c: `packages/adapters/src/tokenizer/__tests__/validating-tokenizer.adapter.test.ts`

Test cases using a fake/mock delegate tokenizer:
- Passes through valid `TokenCount` from delegate unchanged
- Throws `InvalidTokenizerOutputError` when delegate returns `null`
- Throws `InvalidTokenizerOutputError` when delegate returns `undefined`
- Throws `InvalidTokenizerOutputError` when delegate returns `{ value: -1 }`
- Throws `InvalidTokenizerOutputError` when delegate returns `{ value: NaN }`
- Throws `InvalidTokenizerOutputError` when delegate returns `{ value: 1.5 }`
- Throws `InvalidTokenizerOutputError` when delegate returns `{}` (no value field)
- Throws `InvalidTokenizerOutputError` when delegate itself throws an unknown error

Import `InvalidTokenizerOutputError` from `@ledgermind/application`. Check existing test patterns in the codebase for mock/stub conventions.

---

## Issue 4 (INFO): Fix `ValidatingTokenizerAdapter` error wrapping semantics

File: `packages/adapters/src/tokenizer/validating-tokenizer.adapter.ts`

### Problem

Lines 105-114: The catch block wraps *all* delegate exceptions as `InvalidTokenizerOutputError`. This misclassifies input validation errors (like `InvariantViolationError` from Issue 1) as tokenizer output errors, obscuring the real problem.

### Fix

In the `invokeAndValidate` method's catch block, re-throw known domain errors (`InvariantViolationError`) unchanged. Only wrap truly unexpected failures:

```typescript
private invokeAndValidate(call: () => unknown, operation: TokenizerOperation): TokenCount {
  try {
    const output = call();
    return validateTokenizerTokenCount(output, this.tokenizerName, operation);
  } catch (error) {
    if (error instanceof InvalidTokenizerOutputError) {
      throw error;
    }

    // Preserve known domain errors (input validation, invariant violations)
    if (error instanceof Error && error.name === 'InvariantViolationError') {
      throw error;
    }

    throw new InvalidTokenizerOutputError(
      this.tokenizerName,
      operation,
      describeDelegateFailure(error),
    );
  }
}
```

Check how `InvariantViolationError` is exported from `@ledgermind/domain` — if it's a class, use `instanceof` directly instead of name-checking. Read the domain errors file first.

---

## Issue 5 (INFO): Document `SimpleTokenizerAdapter` UTF-16 code unit behavior

File: `packages/adapters/src/tokenizer/simple-tokenizer.adapter.ts`

### Problem

`text.length` counts UTF-16 code units, not characters or bytes. The addendum says "1 token ≈ 4 characters" which is ambiguous. For Phase 1 this is acceptable but should be documented.

### Fix

Add a clarifying JSDoc comment to the `countTokens` method:

```typescript
/**
 * Deterministic tokenizer adapter for snapshot-stable behavior.
 * Uses a fixed ratio of 1 token ≈ 4 characters/bytes.
 *
 * Note: Uses `text.length` (UTF-16 code units), not Unicode codepoints
 * or byte length. For ASCII text this matches "4 characters per token".
 * For non-ASCII (emoji, CJK), results may differ from byte-based estimation.
 * This is acceptable for Phase 1 deterministic testing.
 */
```

Apply the same documentation comment to `packages/adapters/src/testing/simple-tokenizer.ts` (the test stub copy).

---

## Verification checklist

After implementing all 5 issues:

- [ ] `npx turbo run test --filter=@ledgermind/adapters` — all tests pass (existing + new)
- [ ] `npx turbo run build --filter=@ledgermind/adapters` — no type errors
- [ ] No new imports from outer layers into domain (dependency rule)
- [ ] New re-export shim files exist and are importable
- [ ] `TiktokenTokenizerAdapter.estimateFromBytes` throws explicitly for invalid input
- [ ] `ValidatingTokenizerAdapter` preserves domain error types
- [ ] Both `SimpleTokenizerAdapter` and `SimpleTokenizer` have UTF-16 documentation
