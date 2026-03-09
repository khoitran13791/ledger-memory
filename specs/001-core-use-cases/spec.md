# Feature Specification: Phase 1 Core Use Cases

**Feature Branch**: `[001-core-use-cases]`
**Created**: 2026-03-01
**Status**: Draft
**Input**: User description: "i would like to implement `Core use cases` in `Phase 1 — Core Engine (Extract + Stabilize)` of @docs/high-level-design.md and @docs/design-decisions-addendum.md"

## Clarifications

### Session 2026-03-01

- Q: Which persistence backends are in scope for Phase 1 validation? → A: In-memory and PostgreSQL only.
- Q: What minimum retrieval workflow success target should Phase 1 enforce? → A: 90% minimum success.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep active context within budget (Priority: P1)

As an application developer integrating LedgerMind, I need to append conversation events and request a model-ready context that stays within budget so the agent can continue operating without manual memory management.

**Why this priority**: This is the primary value of the memory engine. If budget-safe materialization is not reliable, all downstream capabilities lose value.

**Independent Test**: Can be fully tested by appending a transcript that exceeds thresholds, requesting materialized context, and verifying the returned context is budget-safe (or returns an explicit deterministic budget-related failure).

**Acceptance Scenarios**:

1. **Given** a valid conversation and new events, **When** events are appended, **Then** they are persisted in order and become available in the active context projection.
2. **Given** active context above the hard threshold, **When** materialization is requested, **Then** compaction runs before response and the returned context stays within the available budget.
3. **Given** hard-threshold materialization where budget cannot be reached, **When** compaction reaches its configured limit, **Then** an explicit deterministic non-convergence error is returned.

---

### User Story 2 - Recover and inspect compacted history (Priority: P2)

As an operator or sub-agent, I need to search, inspect, and expand compacted memory so I can recover exact prior details without reloading the full transcript.

**Why this priority**: Compaction is only safe if important details remain discoverable and auditable after summaries replace raw context.

**Independent Test**: Can be fully tested by running compaction, then using search/describe/expand workflows to verify traceability from summary references back to source messages.

**Acceptance Scenarios**:

1. **Given** a compacted conversation, **When** a pattern search is requested, **Then** matching results are returned with references to their covering memory context.
2. **Given** a summary or artifact reference, **When** metadata is requested, **Then** the system returns identity, size, and provenance metadata.
3. **Given** an authorized sub-agent caller and a summary reference, **When** expansion is requested, **Then** the original ordered source messages are returned.
4. **Given** a non-authorized caller and a summary reference, **When** expansion is requested, **Then** the request is denied with an explicit authorization error.

---

### User Story 3 - Preserve artifact context through compaction (Priority: P3)

As a developer handling large files and tool outputs, I need artifact references to remain intact through summarization so compressed memory still points to the correct underlying resources.

**Why this priority**: Artifact continuity is required to avoid information loss when long or file-heavy conversations are compacted.

**Independent Test**: Can be fully tested by storing artifacts, compacting multiple rounds, and confirming that resulting summaries retain complete artifact reference sets.

**Acceptance Scenarios**:

1. **Given** large textual or binary content, **When** it is stored as an artifact, **Then** the system returns a stable artifact reference and estimated size metadata.
2. **Given** a stored artifact, **When** exploration is requested, **Then** an exploration summary and structured metadata are returned.
3. **Given** messages and summaries that reference artifacts, **When** compaction and condensation run, **Then** descendant summaries preserve the full union of source artifact references.

---

### Edge Cases

- What happens when append is retried with the same idempotency key and the same payload versus a different payload?
- How does the system behave when all candidate context items are pinned and no compaction block can be formed?
- How does the system handle summarization outputs that do not reduce size at normal and aggressive levels?
- What happens when concurrent context mutations cause a projection version mismatch during replacement?
- How does the system respond when expand/describe/search references unknown summaries or artifacts?
- What is returned when materialization is requested for an empty conversation?
- What happens when a hard-threshold compaction request reaches max rounds without achieving budget?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist appended conversation events as immutable records with deterministic identities and conversation-local ordering.
- **FR-002**: The system MUST support idempotent event append behavior, including no-op handling for duplicate submissions and conflict signaling for key reuse with different content.
- **FR-003**: The system MUST maintain an active context projection whose item positions are contiguous and reference existing persisted records.
- **FR-004**: The system MUST compute available context budget from configured window size, overhead, and reserved output capacity before materialization.
- **FR-005**: The system MUST trigger non-blocking compaction scheduling when appended context crosses the soft threshold.
- **FR-006**: The system MUST execute blocking compaction before materialization when active context crosses the hard threshold.
- **FR-007**: The system MUST select compaction candidates as the oldest contiguous non-pinned block that satisfies minimum block-size and target-size rules.
- **FR-008**: The system MUST enforce escalation order for compaction (normal, then aggressive, then deterministic fallback) and accept normal/aggressive output only when it reduces size.
- **FR-009**: The system MUST guarantee bounded deterministic fallback output and use it to ensure compaction termination behavior.
- **FR-010**: The system MUST stop compaction after configured maximum rounds and return a deterministic failure when hard-trigger compaction cannot reach budget.
- **FR-011**: The system MUST return materialized context that is never larger than the available budget unless an explicit typed budget-related error is returned.
- **FR-012**: The system MUST provide memory retrieval capabilities for pattern-based search, metadata inspection, and summary expansion with caller authorization checks.
- **FR-013**: The system MUST support artifact storage and exploration while preserving artifact references through all summary generations and condensations.
- **FR-014**: The system MUST provide an integrity-report operation that evaluates all defined DAG and projection integrity checks and reports per-check status.
- **FR-015**: The system MUST emit auditable lifecycle events for append, compaction trigger, summary creation, compaction completion, artifact storage, and context materialization.
- **FR-016**: The system MUST return explicit typed failures for invalid references, stale projection versions, authorization denials, and budget/convergence failures without partial state corruption.

### Key Entities *(include if feature involves data)*

- **Conversation**: A memory session boundary with model budget settings, threshold configuration, and optional parent lineage.
- **Ledger Event**: An immutable record of system/user/assistant/tool activity with deterministic identity and ordered sequence.
- **Context Item**: A mutable projection entry pointing to either a raw event or a summary node, ordered by position.
- **Summary Node**: A compressed representation of one or more source items, classified by kind and connected through DAG edges.
- **DAG Edge**: A provenance relationship linking summaries to source messages or parent summaries.
- **Artifact**: Externally stored large content represented by a stable artifact reference and exploration metadata.
- **Integrity Report**: A structured result containing pass/fail status for each defined consistency and safety check.

## Assumptions

- Phase 1 core use cases include append, materialize context, run compaction, memory retrieval tools, artifact handling, and integrity reporting.
- Phase 1 validation covers the in-memory and PostgreSQL backends only; SQLite remains out of scope for this feature.
- Operator-level recursion workflows are out of scope for this feature and can be delivered in a later phase.
- This feature targets single-project memory operation and does not include multi-tenant or hosted-service concerns.
- Existing architecture documents are the source of truth for invariants, escalation rules, and integrity definitions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of acceptance scenarios for P1 pass in automated validation for append, compaction trigger, and budget-safe materialization.
- **SC-002**: In budget-stress validation scenarios, 100% of materialization calls either return within available budget or return an explicit typed budget/convergence error.
- **SC-003**: In deterministic replay validation, repeated runs of the same fixture produce identical memory IDs and equivalent summary lineage outcomes for all selected fixtures.
- **SC-004**: In escalation-path regression tests, 100% of non-shrinking normal/aggressive summaries escalate correctly and terminate within configured round limits.
- **SC-005**: All defined integrity checks pass after successful append+compaction sequences in conformance validation across the in-memory and PostgreSQL backends.
- **SC-006**: Retrieval validation shows at least 90% task success for finding and recovering compacted details using search → describe → expand workflows.
- **SC-007**: Artifact propagation validation shows 100% preservation of source artifact references across multi-round compaction and condensation scenarios.
