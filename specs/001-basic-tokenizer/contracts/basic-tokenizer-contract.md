# Contract: Basic Tokenizer Adapters

This contract defines required behavior for delivering deterministic and model-aligned tokenizer implementations behind the existing `TokenizerPort` boundary.

## 1) Boundary Contract (Unchanged)

### Interface
```ts
interface TokenizerPort {
  countTokens(text: string): TokenCount;
  estimateFromBytes(byteLength: number): TokenCount;
}
```

### Contract rules
- The interface shape is fixed for this feature.
- All tokenizer behaviors MUST satisfy this interface without introducing behavior-specific methods.
- Domain and application business contracts MUST NOT change to support tokenizer selection.

---

## 2) Deterministic Tokenizer Behavior Contract

### Required behavior
- For `countTokens(text)`:
  - output = `ceil(text.length / 4)`
- For `estimateFromBytes(byteLength)`:
  - output = `ceil(byteLength / 4)`

### Required properties
- Deterministic: identical inputs always produce identical outputs.
- Non-negative outputs for all valid inputs.

### Edge-case expectations
- Empty string => `0`
- Zero bytes => `0`

---

## 3) Model-Aligned Tokenizer Behavior Contract

### Required behavior
- Use tiktoken-based encoding aligned to one predefined default model family for Phase 1.
- `countTokens(text)` and byte-estimation pathways must use the model-aligned behavior as configured.

### Validation requirement
- Phase 1 fixture validation requires exact match to reference token counts (0% tolerance).

### Configuration requirement
- Model-aligned behavior must be selectable at engine setup via SDK config.

---

## 4) SDK Tokenizer Selection Contract

### Required behavior
- Engine initialization MUST accept tokenizer behavior selection.
- Supported selections:
  - deterministic estimator
  - model-aligned tokenizer

### Invalid configuration handling
- Missing/unsupported tokenizer config MUST fail initialization with clear configuration-level error.
- Engine MUST NOT silently fallback to a different tokenizer when config is invalid.

---

## 5) Tokenizer Output Validity Contract

### Valid output criteria
Tokenizer result used by callers MUST represent a valid `TokenCount`:
- finite number
- non-negative
- safe integer after conversion

### Invalid output handling
- Invalid tokenizer output MUST be rejected with explicit tokenizer error.
- Requesting operation MUST stop and MUST NOT continue with invalid token values.

---

## 6) Integration Contract for Existing Consumers

Tokenizer substitution must remain transparent for existing token-dependent flows:
- `RunCompactionUseCase`
- `StoreArtifactUseCase`
- SDK explorer-registry composition paths that rely on tokenizer counts

### Required behavior
- Both tokenizer behaviors can be injected into existing flows without changing use-case method signatures.
- Token-budget and threshold logic can consume tokenizer outputs without additional conversion steps outside tokenizer boundary.

---

## 7) Error Contract

### Required error families
1. **Tokenizer configuration error**
   - thrown when tokenizer selection/config is invalid during initialization
2. **Invalid tokenizer output error**
   - thrown when tokenizer returns invalid token count semantics

### Error behavior
- Errors should be explicit and typed according to project application error conventions.
- Error messages must clearly identify tokenizer source/context for diagnosability.

---

## 8) Test Conformance Contract

### Required test groups
1. **Deterministic adapter tests**
   - verify 1:4 round-up behavior and deterministic stability
2. **Model-aligned adapter tests**
   - verify exact fixture matches for predefined default model-family behavior
3. **SDK config tests**
   - verify behavior selection and invalid config rejection
4. **Output validation tests**
   - verify invalid tokenizer outputs are rejected and operation stops
5. **Substitution safety tests**
   - verify token-dependent flows operate with either behavior via `TokenizerPort`

### Acceptance threshold
- Model-aligned fixture tests pass only with exact count match (no tolerance).

---

## 9) Out-of-Scope Guardrails

This contract does NOT include:
- summarizer provider adapter implementation,
- compaction policy or DAG algorithm redesign,
- persistence schema changes,
- framework-specific tokenizer APIs leaking into domain/application layers.
