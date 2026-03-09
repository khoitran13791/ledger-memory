# Feature Specification: Phase 1 Core Explorers

**Feature Branch**: `[001-core-explorers]`
**Created**: 2026-03-05
**Status**: Draft
**Input**: User description: "i want to implement section `5 core explorers` in `Phase 1 — Core Engine (Extract + Stabilize)` of @docs/high-level-design.md and @docs/design-decisions-addendum.md"

## Clarifications

### Session 2026-03-06

- Q: When extension and detected content type disagree, what precedence should resolution use? → A: Use weighted scoring across all signals, with deterministic tie-break rules.
- Q: For unreadable artifacts, should exploration return a structured failure result or throw an operation error? → A: Hybrid: return structured failure for known unreadable cases, throw only for unexpected internal faults.
- Q: What minimum metadata set should every exploration result include (including fallback and structured failure results)? → A: Core operational set: artifact reference, selected explorer, input classification, confidence/score, truncation indicator, and failure classification when applicable.
- Q: For very large artifacts, what baseline exploration mode should apply? → A: Stratified sampling (beginning + middle + end) before summarization.
- Q: How granular should unsupported-type classification be in fallback/structured failure outputs? → A: Coarse classes: unsupported-readable, unsupported-unreadable, malformed-structured.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explore core artifact types (Priority: P1)

As an agent runtime integrator, I want artifact exploration to automatically produce useful structural summaries for the five Phase 1 core file categories so that large or complex files can be referenced in memory without sending full raw content to the model.

**Why this priority**: This is the direct scope requested by the feature and is required for Phase 1 memory usability.

**Independent Test**: Can be fully tested by submitting one artifact from each core category (TypeScript source, Python source, JSON, Markdown, unsupported type) and verifying a valid exploration result is returned for each.

**Acceptance Scenarios**:

1. **Given** a stored artifact in one of the four specialized categories, **When** exploration is requested, **Then** the system returns a structured summary, metadata, token count, and identifies the selected specialized explorer.
2. **Given** a stored artifact outside specialized categories, **When** exploration is requested, **Then** the system returns a fallback summary, metadata, token count, and identifies the fallback explorer.

---

### User Story 2 - Handle unsupported, malformed, and boundary inputs safely (Priority: P2)

As an operator, I want exploration to degrade gracefully for malformed, ambiguous, or oversized artifacts so that memory workflows remain reliable even when inputs are imperfect.

**Why this priority**: Reliability and safety of exploration behavior protects the broader memory pipeline from breakage.

**Independent Test**: Can be tested by exploring malformed structured files, empty files, unknown extensions, and large files, then validating successful fallback or clear failure behavior without pipeline interruption.

**Acceptance Scenarios**:

1. **Given** a malformed or partially unreadable structured artifact, **When** exploration is requested, **Then** the system provides a clear non-crashing outcome (fallback summary or explicit readable failure reason).
2. **Given** a very large artifact and a token-constrained exploration request, **When** exploration is requested, **Then** the result stays within the requested limit and still includes essential navigational context.

---

### User Story 3 - Ensure deterministic explorer resolution (Priority: P3)

As a maintainer, I want explorer resolution and output shape to be deterministic so that behavior is predictable, testable, and stable across runs.

**Why this priority**: Determinism is required for confidence in golden tests, conformance tests, and production debugging.

**Independent Test**: Can be tested by repeatedly exploring the same artifact with the same inputs and verifying consistent explorer selection and equivalent output structure.

**Acceptance Scenarios**:

1. **Given** the same artifact and the same exploration inputs, **When** exploration is run repeatedly, **Then** the same explorer is selected each time.
2. **Given** multiple explorers that could plausibly handle an input, **When** resolution occurs, **Then** a single explorer is selected according to a deterministic precedence policy.

---

### Edge Cases

- How does exploration behave for empty files with valid extensions?
- How does the system resolve inputs where extension and detected content type disagree?
- How does the system respond when structured content is malformed (for example, invalid JSON syntax)?
- How does exploration preserve useful output when token limits are extremely small?
- How does the system handle unreadable binary or encrypted artifacts while preserving workflow continuity?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support artifact exploration for the five Phase 1 core categories: TypeScript source, Python source, JSON, Markdown, and a fallback category for unsupported inputs.
- **FR-002**: The system MUST select exactly one explorer for each exploration request.
- **FR-003**: The system MUST expose which explorer handled the request in the exploration result.
- **FR-004**: The system MUST apply deterministic resolution rules so the same input and hints always map to the same explorer.
- **FR-004a**: Explorer resolution MUST use a weighted scoring model across extension, declared/detected content type, and content sniffing signals, with deterministic tie-break behavior.
- **FR-005**: For source-code artifacts in supported specialized categories, exploration output MUST include navigational structure (for example, major declarations and dependency references).
- **FR-006**: For JSON artifacts, exploration output MUST include structural shape details (for example, key hierarchy and container/value patterns).
- **FR-007**: For Markdown artifacts, exploration output MUST include document structure details (for example, heading hierarchy and section outline).
- **FR-008**: For unsupported but readable artifacts, the fallback explorer MUST provide a usable summary and baseline metadata instead of returning an empty result.
- **FR-009**: Each successful exploration response MUST include summary text, structured metadata, and token-count information.
- **FR-009a**: The minimum metadata contract for every exploration response MUST include artifact reference, selected explorer, input classification, confidence/score, and truncation indicator.
- **FR-009b**: Structured failure exploration responses MUST include the same minimum metadata contract plus failure classification.
- **FR-010**: Exploration output MUST honor caller-provided token limits; if detail reduction is required, the result MUST remain within limit and disclose truncation/reduction.
- **FR-010a**: For very large artifacts, baseline exploration MUST use stratified sampling across beginning, middle, and end segments before producing the summary.
- **FR-011**: Exploration MUST be read-only with respect to original artifact content and immutable history records.
- **FR-012**: The system MUST return clear, actionable failure responses for unreadable artifacts without causing broader memory workflow failure.
- **FR-012a**: For known unreadable artifact cases, exploration MUST return a structured failure result payload (including failure classification and actionable guidance) rather than surfacing an operation-level exception.
- **FR-012c**: Unsupported/failure classification MUST use coarse standardized classes: `unsupported-readable`, `unsupported-unreadable`, and `malformed-structured`.
- **FR-012b**: Unexpected internal exploration faults MUST surface as operation-level errors while preserving consistency for subsequent requests.
- **FR-013**: The system MUST allow future explorer additions without breaking deterministic behavior for the initial five core categories.

### Key Entities *(include if feature involves data)*

- **Artifact**: A stored file or content object that can be explored; includes identity, source context, and content representation.
- **Explorer Capability**: A declared ability to handle a class of artifacts, including matching criteria and relative suitability.
- **Explorer Resolution Decision**: The deterministic selection outcome that binds one exploration request to one explorer.
- **Exploration Result**: The returned payload containing summary text, metadata, token-count information, and selected explorer identity.

## Assumptions

- Phase 1 scope is limited to the five core explorer categories identified in the roadmap; additional explorer categories are explicitly out of scope for this feature.
- Exploration is intended to produce compact navigational understanding, not full semantic reconstruction of original content.
- Existing artifact storage and exploration entry points are available for this feature to build upon.

## Dependencies

- Artifact storage and retrieval must be available for all artifacts submitted to exploration.
- Token-budget enforcement capabilities must be available to validate exploration output size constraints.
- Conformance and regression test suites must be available to verify deterministic behavior and edge-case handling.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an acceptance corpus containing all five Phase 1 categories, 100% of exploration requests return a non-empty result payload with summary, metadata, token-count information, and selected explorer identity.
- **SC-002**: For unsupported-but-readable artifacts in the acceptance corpus, 100% of exploration requests are successfully handled by fallback behavior.
- **SC-003**: For unreadable artifacts in the acceptance corpus, 100% of requests return explicit, actionable failure responses without interrupting subsequent exploration requests.
- **SC-004**: Across repeated runs of the same acceptance corpus (minimum three runs), explorer selection remains consistent in 100% of cases.
- **SC-005**: For requests with explicit output-token limits, 100% of returned exploration outputs remain at or below the requested limit.
- **SC-006**: Edge-case acceptance scenarios defined in this spec are covered by automated tests before feature sign-off.
