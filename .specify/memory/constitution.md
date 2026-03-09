<!--
Sync Impact Report
- Version change: unversioned/template → 1.0.0
- Modified principles:
  - Template Principle 1 → I. Code Quality as a Non-Negotiable Contract
  - Template Principle 2 → II. Testing Standards are Mandatory
  - Template Principle 3 → III. User Experience Consistency
  - Template Principle 4 → IV. Performance Requirements are First-Class
  - Template Principle 5 → V. Simplicity and Change Safety
- Added sections:
  - Engineering Standards & Constraints
  - Delivery Workflow & Quality Gates
- Removed sections:
  - Misplaced feature-spec template content previously in this file
- Templates requiring updates:
  - ✅ updated: .specify/templates/plan-template.md
  - ✅ updated: .specify/templates/spec-template.md
  - ✅ updated: .specify/templates/tasks-template.md
  - ⚠ pending: .specify/templates/commands/*.md (directory not present)
  - ✅ updated: CLAUDE.md
- Follow-up TODOs:
  - TODO(COMMAND_TEMPLATE_DIR): add .specify/templates/commands/ if command templates are required.
-->
# LedgerMind Constitution

## Core Principles

### I. Code Quality as a Non-Negotiable Contract
All production code MUST be readable, deterministic, and maintainable. Changes MUST
preserve Clean Architecture boundaries, pass linting/type checks, and avoid dead code,
speculative abstractions, and hidden coupling. Any intentional complexity MUST include
an explicit justification in planning artifacts.
Rationale: Consistent code quality prevents architecture drift and keeps the system
evolvable under frequent iteration.

### II. Testing Standards are Mandatory
Every behavioral code change MUST include automated tests at the appropriate level
(unit, integration, conformance, or end-to-end). Bug fixes MUST include a regression
test that fails before the fix and passes after it. Deterministic tests
(golden/property/conformance) are the required baseline for CI, while stochastic quality
evaluations may run separately.
Rationale: Reliability depends on executable proof, not manual verification or intent.

### III. User Experience Consistency
Any user-facing change MUST follow established interaction patterns, naming, and
messaging conventions across CLI, tool outputs, and developer-facing documentation.
User journeys defined in specifications MUST remain independently testable and include
explicit error-state behavior. Accessibility and clarity requirements MUST be captured
when applicable to the interface surface.
Rationale: Consistent UX reduces cognitive load, support burden, and integration errors.

### IV. Performance Requirements are First-Class
Features MUST define measurable performance targets and resource constraints before
implementation (for example latency, throughput, memory, token budget, and compaction
convergence behavior). Implementations MUST include verification steps that demonstrate
compliance with declared targets. Performance regressions MUST be treated as release
blockers unless explicitly waived with documented approval.
Rationale: Performance is a product requirement, not a post-release optimization activity.

### V. Simplicity and Change Safety
Design and implementation MUST prefer the simplest solution that satisfies current
requirements. Teams MUST avoid premature abstractions, backward-compatibility shims
without active consumers, and broad refactors outside requested scope. Changes MUST be
incremental, traceable to requirements, and reversible through version control.
Rationale: Simplicity improves delivery safety and keeps maintenance costs predictable.

## Engineering Standards & Constraints

- Clean Architecture dependency rule MUST be enforced
  (`domain <- application <- adapters <- infrastructure <- sdk`).
- Domain and application layers MUST NOT import forbidden runtime or infrastructure
  dependencies.
- Static quality gates (`pnpm lint`, `pnpm typecheck`) MUST pass before merge.
- Security-sensitive changes MUST document threat boundaries and input validation
  strategy at system edges.
- Specifications MUST include explicit measurable outcomes for quality, UX behavior,
  and performance.

## Delivery Workflow & Quality Gates

1. Plan artifacts MUST include a Constitution Check that evaluates code quality,
   testing, UX consistency, and performance requirements.
2. Task plans MUST include concrete validation tasks for:
   - static quality checks,
   - automated tests,
   - UX consistency review (for user-facing changes),
   - performance verification against defined targets.
3. Pull requests MUST include evidence of tests executed and any
   benchmark/profiling output required by the feature plan.
4. Releases MUST NOT proceed with unresolved constitution violations unless a
   documented waiver is approved by maintainers.

## Governance

This constitution is the highest-priority engineering policy for this repository.
When conflicts occur, this constitution overrides local conventions and ad hoc practices.

Amendment policy:
- Amendments MUST be proposed via pull request that includes:
  - the exact text change,
  - rationale,
  - impact assessment on templates, workflows, and existing docs.
- Amendment approval requires maintainer review and explicit acceptance in repository
  history.

Versioning policy (semantic versioning for governance):
- MAJOR: backward-incompatible principle removals or redefinitions.
- MINOR: new principle/section or materially expanded policy requirements.
- PATCH: clarifications, wording improvements, and non-semantic refinements.

Compliance review expectations:
- Every implementation plan MUST pass the Constitution Check before design and again
  before implementation.
- Every pull request review MUST include explicit confirmation of constitution
  compliance.
- Exceptions MUST be recorded with scope, owner, and sunset date.

**Version**: 1.0.0 | **Ratified**: 2026-02-27 | **Last Amended**: 2026-02-27
