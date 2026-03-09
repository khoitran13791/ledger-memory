# Feature Specification: Basic Tokenizer Adapters

**Feature Branch**: `001-basic-tokenizer`
**Created**: 2026-03-04
**Status**: Draft
**Input**: User description: "i would like to implement section `Basic tokenizer` in `Phase 1 — Core Engine (Extract + Stabilize)` in @docs/high-level-design.md. read @docs/design-decisions-addendum.md for more context"

## Clarifications

### Session 2026-03-04

- Q: Should this feature deliver one tokenizer behavior or both planned behaviors? → A: Deliver both behaviors in this feature (deterministic estimator + model-aligned tokenizer behavior).
- Q: What should be the canonical alignment target for the model-aligned tokenizer behavior in this feature? → A: Align to one predefined default model family for Phase 1.
- Q: What fixed conversion rule should deterministic estimation use in Phase 1? → A: Use 1 token ≈ 4 characters/bytes, rounded up.
- Q: How should the system handle invalid tokenizer outputs in Phase 1? → A: Reject with explicit tokenizer error and stop the operation.
- Q: What tolerance should be accepted for model-aligned token counts in Phase 1 validation? → A: Require exact count match (0% tolerance).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Estimate and count tokens for core flows (Priority: P1)

As an application-layer developer, I want a tokenizer capability available through the defined boundary so append, compaction, and context materialization flows can compute token usage and budget decisions consistently.

**Why this priority**: Token counting is a hard prerequisite for budget enforcement and compaction thresholds. Without it, core Phase 1 flows cannot operate correctly.

**Independent Test**: Can be fully tested by exercising token-count and byte-estimation requests through the tokenizer boundary and validating that outputs are returned for typical and boundary-sized inputs.

**Acceptance Scenarios**:

1. **Given** valid text content, **When** token count is requested, **Then** the system returns a non-negative token count value.
2. **Given** a byte-length input, **When** token estimation is requested, **Then** the system returns a non-negative estimated token count value.
3. **Given** token-dependent operations (such as budget checks), **When** tokenizer outputs are used, **Then** the operation can proceed without requiring direct knowledge of tokenizer internals.

---

### User Story 2 - Select tokenizer behavior by configuration (Priority: P2)

As an SDK integrator, I want to configure which basic tokenizer behavior is used so I can run deterministic tests with a simple estimator and switch to a model-aligned tokenizer strategy where needed.

**Why this priority**: Phase 1 requires a basic tokenizer capability and deterministic testing support. Configuration-driven selection enables both development and validation workflows.

**Independent Test**: Can be tested by creating engine configurations that request each tokenizer behavior and verifying that the selected behavior is the one used during token requests.

**Acceptance Scenarios**:

1. **Given** a configuration selecting the simple estimator, **When** token count and byte-estimation operations are run, **Then** results follow the simple-estimator behavior.
2. **Given** a configuration selecting the model-aligned tokenizer behavior, **When** token operations are run, **Then** results follow that behavior.
3. **Given** an invalid tokenizer configuration, **When** initialization is attempted, **Then** initialization fails with a clear configuration-level failure.

---

### User Story 3 - Keep tokenizer logic replaceable and architecture-safe (Priority: P3)

As an architecture reviewer, I want tokenizer logic isolated behind the existing tokenizer boundary so new tokenizer implementations can be introduced without changing domain or application business rules.

**Why this priority**: Maintaining Clean Architecture boundaries preserves substitutability and avoids coupling core logic to one tokenizer implementation.

**Independent Test**: Can be tested by verifying that token-dependent application flows continue to operate when tokenizer implementation is swapped, with no boundary violations.

**Acceptance Scenarios**:

1. **Given** two tokenizer implementations that satisfy the same boundary contract, **When** they are substituted in equivalent runs, **Then** application flows complete successfully with each implementation.
2. **Given** package boundary rules, **When** tokenizer-related dependencies are reviewed, **Then** tokenizer implementation details remain outside inner layers.

---

### Edge Cases

- What happens when token counting is requested for an empty string?
- How does the system behave when byte estimation is requested for zero bytes?
- What happens when extremely large text input is provided to token counting?
- How does initialization behave when tokenizer configuration is missing or unsupported?
- What behavior is expected when tokenizer output would be interpreted as invalid (for example, negative or non-finite values)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a basic tokenizer capability through the existing tokenizer boundary used by application flows.
- **FR-002**: The tokenizer capability MUST support counting tokens for text input.
- **FR-003**: The tokenizer capability MUST support estimating token counts from byte-length input.
- **FR-004**: Tokenizer operations MUST return non-negative token count values.
- **FR-005**: The system MUST provide a deterministic tokenizer behavior suitable for repeatable Phase 1 tests.
- **FR-005a**: Deterministic estimation MUST use the fixed rule 1 token ≈ 4 characters/bytes, rounded up.
- **FR-006**: The system MUST provide a model-aligned tokenizer behavior in this feature.
- **FR-007**: The model-aligned tokenizer behavior MUST align to one predefined default model family for Phase 1.
- **FR-008**: The system MUST provide a configurable way to choose between the deterministic estimator and the model-aligned tokenizer behavior at engine setup time.
- **FR-009**: Invalid tokenizer configuration MUST be rejected during initialization with a clear failure.
- **FR-010**: Invalid tokenizer outputs MUST be rejected with an explicit tokenizer error, and the requesting operation MUST stop without using the invalid value.
- **FR-011**: Tokenizer behavior selection MUST NOT require changes to domain or application business logic contracts.
- **FR-012**: Tokenizer functionality MUST remain framework-agnostic and usable across supported integration patterns.
- **FR-013**: Tokenizer outputs MUST be usable by budget and threshold decision flows without additional conversion steps outside the tokenizer boundary.
- **FR-014**: Model-aligned tokenizer validation in Phase 1 MUST require exact token-count match against the defined default model-family reference behavior (0% tolerance).

### Key Entities *(include if feature involves data)*

- **Tokenizer Capability**: Boundary-level service responsible for deriving token counts from text and bytes for budget-aware operations.
- **Tokenizer Configuration**: Input that selects which tokenizer behavior is active for a given engine instance.
- **Token Count Value**: Non-negative value used by budget computation, threshold checks, and compaction decisions.

### Assumptions

- The tokenizer boundary contract already exists from prior Phase 1 port work and this feature focuses on implementing basic behaviors behind that boundary.
- At least one deterministic tokenizer behavior is required for golden and repeatable tests in Phase 1.
- Tokenizer implementation details may vary, but downstream flows consume only boundary outputs.

### Out of Scope

- Implementing summarizer provider adapters.
- Changing compaction policies, DAG logic, or persistence schema.
- Defining new memory tools beyond tokenizer-related capability.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of token-count and byte-estimation requests in Phase 1 core flows complete through the tokenizer boundary without direct implementation coupling.
- **SC-002**: Deterministic tokenizer behavior produces stable outputs for repeated identical inputs across test runs.
- **SC-003**: Configuration validation prevents unsupported tokenizer selections with clear initialization failures.
- **SC-004**: Token-dependent flows can run with either supported tokenizer behavior without requiring changes to business-rule contracts.
- **SC-005**: Model-aligned tokenizer validation fixtures pass only when token counts exactly match the Phase 1 default model-family reference behavior.
