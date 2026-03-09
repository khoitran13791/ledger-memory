# Research: Basic Tokenizer Adapters

## Decision 1: Keep `TokenizerPort` contract unchanged and implement both behaviors behind it

- **Decision**: Preserve the existing application contract:
  - `countTokens(text: string): TokenCount`
  - `estimateFromBytes(byteLength: number): TokenCount`
  and implement deterministic + model-aligned behavior as adapter choices behind this boundary.
- **Rationale**:
  - Existing consumers (`run-compaction`, `store-artifact`, explorer fallback, sdk composition) already depend on this interface.
  - Feature FR-011 explicitly requires behavior selection without changing domain/application business contracts.
  - This keeps Clean Architecture boundaries stable.
- **Alternatives considered**:
  - Expanding `TokenizerPort` with model/provider parameters.
    - Rejected because it leaks implementation detail into inner layers and forces unnecessary use-case contract churn.

## Decision 2: Phase 1 deterministic behavior is the existing 1:4 estimator with round-up

- **Decision**: Continue using `Math.ceil(length / 4)` for both text and bytes as deterministic behavior.
- **Rationale**:
  - Spec clarification explicitly sets this rule (FR-005a).
  - Existing implementations already follow it (`SimpleTokenizerAdapter`, testing `SimpleTokenizer`) and existing tests verify expected outcomes.
  - Preserves golden-test stability and repeatability.
- **Alternatives considered**:
  - Switching deterministic estimator to a different ratio or heuristic.
    - Rejected because it would violate clarified requirement and destabilize existing deterministic fixtures.

## Decision 3: Phase 1 model-aligned tokenizer uses tiktoken with a predefined default GPT-family model

- **Decision**: Implement model-aligned behavior using tiktoken and align to one predefined default model-family target for Phase 1 (OpenAI GPT-family encoding).
- **Rationale**:
  - HLD/roadmap explicitly call out “simple estimator + tiktoken” for basic tokenizer scope.
  - This fulfills FR-006/FR-007 while staying minimal.
  - A single default-family target avoids over-configuration during Phase 1.
- **Alternatives considered**:
  - Implementing multiple provider-specific tokenizers in this feature.
    - Rejected as out of scope and unnecessary for Phase 1.
  - Building a custom tokenizer from scratch.
    - Rejected due to correctness/maintenance risk versus proven tokenizer libraries.

## Decision 4: SDK must select tokenizer behavior at engine initialization via explicit config

- **Decision**: Extend `MemoryEngineConfig` with tokenizer selection and instantiate tokenizer implementation in `createMemoryEngine()` accordingly.
- **Rationale**:
  - Spec FR-008/FR-009 requires configuration-driven selection and fast failure for invalid configuration.
  - Current sdk hardcodes `SimpleTokenizerAdapter`; this feature closes that gap.
  - Keeps selection at composition root where dependency wiring belongs.
- **Alternatives considered**:
  - Runtime switching of tokenizer behavior after engine creation.
    - Rejected because it adds mutable runtime complexity not required by spec.
  - Detecting tokenizer behavior implicitly from model strings without explicit config.
    - Rejected due to ambiguity and weaker validation semantics.

## Decision 5: Invalid tokenizer outputs are rejected via explicit tokenizer error wrapper

- **Decision**: Add validation around tokenizer outputs so negative, non-finite, or otherwise invalid token counts produce explicit tokenizer errors and abort the operation.
- **Rationale**:
  - Spec FR-010 requires explicit error + stop behavior for invalid outputs.
  - `createTokenCount` already enforces non-negative safe integers; surfacing this as a tokenizer-specific application error improves failure clarity at use-case boundary.
  - Wrapping both deterministic and model-aligned adapters ensures uniform guarantees.
- **Alternatives considered**:
  - Clamping invalid values to zero.
    - Rejected because it hides faults and violates explicit rejection requirement.
  - Letting raw invariant exceptions propagate without tokenizer context.
    - Rejected because it produces weaker diagnostics than required by spec.

## Decision 6: Validate model-aligned behavior with exact-match fixtures (0% tolerance)

- **Decision**: Add explicit fixture-based tests where model-aligned token counts must exactly match expected reference values for the selected default model-family behavior.
- **Rationale**:
  - Spec FR-014 + SC-005 require exact-match validation (0% tolerance).
  - Exact fixture assertions prevent silent drift when tokenizer dependency changes.
- **Alternatives considered**:
  - Accepting range/tolerance checks.
    - Rejected by clarified requirement.

## Decision 7: Keep tokenizer changes scoped; do not modify compaction policy, DAG, or persistence

- **Decision**: Restrict implementation to tokenizer adapters, sdk composition/config, and targeted tests.
- **Rationale**:
  - Spec out-of-scope section excludes compaction policy/DAG/persistence changes.
  - Existing use cases already consume tokenizer through `TokenizerPort`; substitutability can be proven without broader refactor.
- **Alternatives considered**:
  - Refactoring compaction/storage flows while touching tokenizer paths.
    - Rejected as scope expansion and risk without direct requirement value.

## Decision 8: Preserve framework-agnostic usage by containing tokenizer dependencies in adapters

- **Decision**: Keep tokenizer library coupling (tiktoken) in `packages/adapters` and do not leak those types into domain/application.
- **Rationale**:
  - Aligns with Clean Architecture dependency rules and FR-012 framework-agnostic requirement.
  - Application/use-case layer continues to depend only on `TokenizerPort`.
- **Alternatives considered**:
  - Importing tiktoken directly in sdk or application use cases.
    - Rejected due to boundary violations and reduced substitutability.
