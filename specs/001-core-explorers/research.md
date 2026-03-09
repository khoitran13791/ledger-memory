# Research: Phase 1 Core Explorers

## Decision 1: Keep `ExplorerPort` and `ExplorerRegistryPort` interfaces unchanged

- **Decision**: Implement Phase 1 behavior entirely behind existing explorer interfaces:
  - `ExplorerPort.canHandle(mimeType, path, hints): number`
  - `ExplorerPort.explore(input): Promise<ExplorerOutput>`
  - `ExplorerRegistryPort.resolve(mimeType, path, hints): ExplorerPort`
- **Rationale**:
  - Current `ExploreArtifactUseCase` and SDK composition already depend on these contracts.
  - Requirements focus on selection policy, metadata, and failure behavior, not new API surface.
  - Preserves Clean Architecture boundaries and avoids unnecessary contract churn.
- **Alternatives considered**:
  - Adding new explorer result union types in application ports.
    - Rejected because structured failure requirements can be represented in `metadata` without widening core contracts.

## Decision 2: Use weighted scoring across extension, content type, and sniffing with deterministic tie-break

- **Decision**: Explorer resolution uses a deterministic weighted score model:
  - extension signal weight: **60**
  - declared/detected MIME/content-type signal weight: **25**
  - content sniffing signal weight: **15**
  - total score range: **0..100**
- **Tie-break order**:
  1. highest total score,
  2. highest extension contribution,
  3. highest MIME contribution,
  4. highest sniffing contribution,
  5. earliest registration order (stable deterministic fallback).
- **Rationale**:
  - Matches clarified FR-004a requirement for weighted multi-signal resolution.
  - Keeps deterministic selection behavior for repeated identical inputs (SC-004).
  - Preserves existing deterministic registration-order fallback semantics in current registry.
- **Alternatives considered**:
  - Extension-only or MIME-only priority chains.
    - Rejected because clarification explicitly requires weighted combination across all signals.

## Decision 3: Standardize input classification before explorer execution

- **Decision**: Every exploration request is assigned one deterministic classification used in metadata and diagnostics:
  - `typescript-source`
  - `python-source`
  - `json-structured`
  - `markdown-document`
  - `unsupported-readable`
  - `unsupported-unreadable`
  - `malformed-structured`
- **Rationale**:
  - Clarified FR-009a/FR-009b require explicit input classification in all outcomes.
  - Provides consistent routing and debugging across success/failure paths.
- **Alternatives considered**:
  - Free-form textual classification values.
    - Rejected because non-canonical labels reduce determinism and testability.

## Decision 4: Return structured failure payloads for known unreadable/malformed cases

- **Decision**: For known failure classes, explorers return normal `ExplorerOutput` containing structured-failure metadata instead of throwing.
  - `unsupported-unreadable`
  - `malformed-structured`
  - `unsupported-readable` (coarse unsupported classification with actionable fallback guidance)
- **Rationale**:
  - Clarification and FR-012a require structured failure payloads for known cases.
  - Keeps workflow continuity and avoids operation-level interruption for expected bad inputs.
- **Alternatives considered**:
  - Throw exceptions for all malformed/unreadable cases.
    - Rejected because spec requires hybrid behavior: structured known failures, exceptions only for unexpected internal faults.

## Decision 5: Preserve operation-level exceptions for unexpected internal faults

- **Decision**: Unexpected internal faults still throw and are surfaced through `ArtifactExplorationFailedError` from `ExploreArtifactUseCase`.
- **Rationale**:
  - FR-012b explicitly requires operation-level errors for unexpected faults.
  - Maintains existing typed error mapping behavior in application layer.
- **Alternatives considered**:
  - Convert all exceptions to structured failure outputs.
    - Rejected because it hides infrastructure/logic defects and violates FR-012b.

## Decision 6: Enforce a minimum metadata contract for all outcomes

- **Decision**: All explorer outputs include these minimum metadata fields:
  - `artifactReference` (id/path/mime)
  - `selectedExplorer`
  - `inputClassification`
  - `score` (selected score)
  - `confidence` (normalized from score)
  - `truncated` (boolean)
- **Structured failure outputs additionally include**:
  - `failureClassification`
  - `failureReason`
  - `actionableGuidance[]`
- **Rationale**:
  - Directly satisfies FR-009a and FR-009b.
  - Unifies successful and failure result handling under one predictable shape.
- **Alternatives considered**:
  - Per-explorer custom metadata without required shared keys.
    - Rejected because it breaks cross-explorer consistency and conformance testing.

## Decision 7: Apply stratified sampling baseline for large artifacts before summarization

- **Decision**: For large artifacts, explorers first build a deterministic 3-segment sample (beginning + middle + end) before structural summarization.
  - Segment count fixed at 3.
  - Segment boundaries are deterministic for identical input size.
  - Sampling and truncation details are disclosed in metadata.
- **Rationale**:
  - Clarified FR-010a requires stratified sampling baseline.
  - Preserves navigational context under token constraints better than head-only clipping.
- **Alternatives considered**:
  - Head-only truncation as default for all large inputs.
    - Rejected because it drops middle/tail context and conflicts with clarified baseline.

## Decision 8: Keep fallback explorer always resolvable and non-empty for readable unsupported inputs

- **Decision**: Fallback remains always available and must return usable summaries for readable unsupported artifacts, including token-budget compliance and truncation disclosure.
- **Rationale**:
  - Satisfies FR-008 and SC-002.
  - Current default registry already guarantees fallback registration; this behavior is preserved while enriching metadata contract.
- **Alternatives considered**:
  - No fallback for unknown extensions.
    - Rejected because it would violate core Phase 1 category coverage and non-empty payload success criteria.

## Decision 9: Validate behavior with deterministic explorer and resolver tests

- **Decision**: Add deterministic tests for:
  - weighted resolution (including disagreement between extension/content-type/sniffing),
  - tie-break stability,
  - structured failure outputs,
  - metadata contract compliance,
  - stratified sampling + token-limit truncation behavior.
- **Rationale**:
  - Required by SC-004, SC-005, and SC-006.
  - Prevents regressions in resolver determinism and output-shape guarantees.
- **Alternatives considered**:
  - Relying on smoke tests only.
    - Rejected because deterministic behavior and metadata invariants need direct assertion coverage.
