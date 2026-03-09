# Data Model: Basic Tokenizer Adapters

This feature introduces tokenizer behavior selection and validation while preserving the existing tokenizer boundary contract used by Phase 1 core flows.

## 1) Tokenizer Capability (Boundary Service)

### Description
A boundary-level service that returns token counts for text and bytes to support budget, threshold, compaction, and artifact accounting paths.

### Contract (existing)
```ts
interface TokenizerPort {
  countTokens(text: string): TokenCount;
  estimateFromBytes(byteLength: number): TokenCount;
}
```

### Invariants
- Returned values must represent valid `TokenCount` values (non-negative safe integers).
- Contract shape remains unchanged across behaviors.

### Behavioral rules
- All tokenizer consumers interact only through `TokenizerPort`.
- Tokenizer implementation details remain outside domain/application business rules.

---

## 2) Tokenizer Behavior Variant

### Description
A configuration-selected behavior strategy implementing `TokenizerPort`.

### Variants in scope
1. **Deterministic estimator**
   - rule: `Math.ceil(length / 4)` for text chars and bytes
   - purpose: stable, repeatable tests and deterministic baselines
2. **Model-aligned tokenizer**
   - backed by tiktoken encoding
   - aligned to one predefined Phase 1 default model family

### Invariants
- Both variants must satisfy identical `TokenizerPort` semantics.
- Switching variants must not require changes to use-case contracts.

### Behavioral rules
- Deterministic variant output is stable across repeated identical inputs.
- Model-aligned variant output must match reference fixtures exactly for Phase 1 default-family cases.

---

## 3) Tokenizer Configuration (SDK Input)

### Description
Engine-level input that selects tokenizer behavior at composition time.

### Conceptual fields
- tokenizer strategy kind (`deterministic` or `model-aligned`)
- optional model-family/encoding selector for model-aligned behavior (bounded to predefined Phase 1 default)

### Validation rules
- Missing/unsupported tokenizer selection is rejected during initialization.
- Unsupported model-family/encoding selection is rejected during initialization.

### Behavioral rules
- Configuration parsing/validation occurs before engine construction completes.
- Invalid config produces explicit configuration-level failure.

---

## 4) Token Count Value

### Description
Non-negative integer value consumed by budget and threshold logic.

### Type ownership
- Domain value object: `TokenCount` created through `createTokenCount`.

### Validation rules
- Must be a non-negative safe integer.
- Non-finite values are invalid.

### Behavioral rules
- Tokenizer outputs must be converted/validated as `TokenCount` before use by application flows.
- Invalid outputs must stop the operation with explicit tokenizer error.

---

## 5) Tokenizer Error Model

### Description
Typed failure model for tokenizer-specific runtime failures.

### Error families in scope
1. **Tokenizer configuration error**
   - unsupported/missing tokenizer behavior selection at initialization
2. **Invalid tokenizer output error**
   - tokenizer produced invalid value (negative, non-finite, unsafe integer)

### Behavioral rules
- Errors are explicit and surfaced at application/sdk boundary.
- Invalid tokenizer output is never silently corrected/clamped.
- Operations depending on invalid output terminate immediately.

---

## 6) Relationship Map

- `MemoryEngineConfig` selects one `Tokenizer Behavior Variant`.
- Selected behavior implements `TokenizerPort` and is injected into:
  - `RunCompactionUseCase`
  - `StoreArtifactUseCase`
  - explorer registry/fallback flows (through existing composition path)
- Tokenizer results become `TokenCount Value` consumed by budget/threshold logic.
- Invalid tokenizer outputs trigger `Tokenizer Error Model` and abort requesting operation.

---

## 7) Requirement Mapping Matrix

- FR-001, FR-002, FR-003 -> Sections 1, 2
- FR-004 -> Sections 1, 4
- FR-005, FR-005a -> Section 2 (deterministic variant)
- FR-006, FR-007 -> Section 2 (model-aligned variant)
- FR-008, FR-009 -> Section 3
- FR-010 -> Sections 4, 5
- FR-011, FR-012 -> Sections 1, 2, 6
- FR-013 -> Sections 4, 6
- FR-014 -> Section 2 (exact-match model-aligned validation)

---

## 8) Out-of-Scope Reinforcement

- No changes to compaction policy algorithm or DAG rules.
- No changes to persistence schema or storage adapters due to tokenizer feature itself.
- No summarizer provider adapter implementation in this feature.
