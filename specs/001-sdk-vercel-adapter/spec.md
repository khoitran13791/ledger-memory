# Feature Specification: SDK Entrypoint and Vercel Memory Adapter

**Feature Branch**: `[001-sdk-vercel-adapter]`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "i would like to implement 2 items `SDK entrypoint` and `Vercel AI SDK adapter` in `Phase 1 — Core Engine (Extract + Stabilize)` of @docs/high-level-design.md and @docs/design-decisions-addendum.md"

## Clarifications

### Session 2026-03-07

- Q: What storage scope should the SDK entrypoint support in this feature? → A: Support both PostgreSQL and in-memory engine creation.
- Q: How should restricted memory operations be exposed in this adapter? → A: Expose restricted tools and enforce authorization at runtime.
- Q: What error response contract should adapter tools follow? → A: All tool errors use one consistent structured envelope.
- Q: What SDK entrypoint surface should be required in this feature? → A: Expose one generic create function plus named presets for common setups.
- Q: What minimum negative-path coverage threshold should this feature require? → A: Cover 100% of defined negative-path scenarios.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a memory engine from one public entrypoint (Priority: P1)

As an application developer, I can initialize a production-ready memory engine from a single public SDK entrypoint so I can start integrating memory without manually wiring internal components.

**Why this priority**: This is the adoption path for every downstream integration. Without a reliable entrypoint, no framework adapter can be used consistently.

**Independent Test**: Can be fully tested by creating an engine from the public entrypoint using valid configuration, then completing a minimal memory flow (append context + materialize context) successfully.

**Acceptance Scenarios**:

1. **Given** a valid PostgreSQL-backed or in-memory engine configuration, **When** the developer initializes through the public SDK entrypoint, **Then** a usable memory engine instance is returned.
2. **Given** an invalid or incomplete configuration, **When** initialization is attempted, **Then** initialization fails with actionable validation feedback and no partially initialized engine.
3. **Given** a created engine instance, **When** core memory operations are called, **Then** they are accessible through the same stable SDK-facing contract.

---

### User Story 2 - Use memory tools in a Vercel AI SDK workflow (Priority: P2)

As an application developer using Vercel AI SDK, I can register a LedgerMind tool bundle and call memory capabilities during agent/tool execution.

**Why this priority**: This delivers practical value from the SDK entrypoint by enabling real runtime usage in the first targeted framework integration.

**Independent Test**: Can be fully tested by registering the adapter tool bundle in a Vercel AI SDK flow and successfully executing memory tool calls during a conversation.

**Acceptance Scenarios**:

1. **Given** an initialized memory engine, **When** the developer creates the Vercel tool bundle, **Then** the runtime receives callable memory tool definitions.
2. **Given** a valid tool call in runtime context, **When** a memory operation is executed, **Then** the tool returns structured results including identifiers needed for follow-up operations.
3. **Given** a restricted operation in an unauthorized context, **When** the tool is invoked, **Then** access is denied in a controlled, non-crashing way.

---

### User Story 3 - Preserve a stable integration contract for future extensions (Priority: P3)

As a maintainer, I can rely on clear SDK and adapter behavior contracts so future framework adapters can follow the same integration model without re-defining baseline semantics.

**Why this priority**: Consistent contracts reduce integration drift and lower future maintenance cost across additional adapters.

**Independent Test**: Can be fully tested by validating that documented usage and automated tests align with implemented SDK and adapter behavior for both success and failure paths.

**Acceptance Scenarios**:

1. **Given** the public SDK and adapter contracts, **When** maintainers review or extend integrations, **Then** required inputs, outputs, and error expectations are unambiguous.
2. **Given** contract regression tests, **When** a breaking contract change is introduced, **Then** the test suite fails and signals the incompatibility.

---

### Edge Cases

- What happens when the SDK entrypoint is called without required conversation or storage settings?
- How does the system handle runtime tool calls when the underlying memory backend is temporarily unavailable?
- How is behavior preserved when a tool call requests restricted memory expansion from a non-authorized caller?
- What is the expected behavior when a tool request returns no matches (empty result set) but must still return a valid structured response?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a single public SDK entrypoint with a generic create function and named presets for common setups.
- **FR-002**: System MUST validate required initialization inputs before returning an engine instance.
- **FR-003**: System MUST reject invalid initialization requests with clear, actionable error feedback.
- **FR-004**: System MUST expose the core memory interaction surface through the SDK-created engine instance.
- **FR-005**: System MUST provide a Vercel AI SDK-compatible adapter that produces runtime-callable memory tool definitions, including restricted operations.
- **FR-006**: System MUST support runtime execution of memory search, memory metadata lookup, and controlled context expansion through the adapter.
- **FR-007**: System MUST enforce access restrictions for sensitive memory operations at runtime and return a structured denial response for unauthorized calls.
- **FR-008**: System MUST return structured tool responses that preserve relevant memory references for subsequent retrieval and inspection actions.
- **FR-009**: System MUST use one consistent structured error envelope for all adapter tool failures.
- **FR-010**: System MUST define and publish integration behavior expectations for both successful and failed SDK/adapter interactions.
- **FR-011**: System MUST include automated validation that covers primary entrypoint and adapter flows, including negative/error scenarios.
- **FR-012**: System MUST include automated tests for 100% of defined negative-path scenarios in scope for this feature.

### Key Entities *(include if feature involves data)*

- **Engine Initialization Request**: Represents all user-provided inputs needed to create a memory engine via the SDK entrypoint.
- **Memory Engine Instance**: Represents the initialized runtime interface used by applications to perform memory operations.
- **Tool Bundle Definition**: Represents the set of adapter-provided runtime tools that expose memory capabilities to Vercel AI SDK flows.
- **Tool Execution Context**: Represents caller and conversation context used to authorize and execute tool operations.
- **Tool Result Envelope**: Represents a structured response returned by each tool call, including data payload and follow-up references.

### Assumptions & Dependencies

- Scope is limited to the two Phase 1 deliverables requested: SDK entrypoint and Vercel AI SDK adapter.
- Existing core memory capabilities (append, compaction, retrieval, artifact handling) are available to be surfaced via SDK and adapter interfaces.
- Access-control behavior for restricted memory expansion follows the approved design direction in project design documents.
- Additional framework adapters, server mode, and UI capabilities are out of scope for this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New integrators can complete a first successful memory-enabled runtime flow (initialize engine, register tools, execute at least one memory tool call) using either the generic create function or a named preset, without ad hoc wiring steps.
- **SC-002**: 100% of acceptance scenarios for P1 and P2 user stories and 100% of defined negative-path scenarios are covered by automated tests and pass in CI.
- **SC-003**: Contract validation confirms that all adapter-exposed tool operations return structured, non-crashing responses for both success and error paths in test coverage.
- **SC-004**: Under representative Phase 1 usage scenarios, memory-enabled flows continue to meet defined context-budget behavior (no materialized context over-budget outcomes in covered tests).
