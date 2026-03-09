---
description: Implement a Beads issue in LedgerMind (Clean Architecture TypeScript monorepo) using spec-kit artifacts as source of truth.
argument-hint: <beads-issue-id> [--scope domain|application|adapters|infrastructure|sdk|cross-cutting] [--dry-run]
---

# Implement Beads Issue (LedgerMind — Clean Architecture TS Monorepo)

You are implementing a Beads issue (task/epic/bug/feature) in this repository.

This repo is a **pnpm 9.x monorepo + Turborepo** with **strict Clean Architecture**:
- **Runtime**: Node.js 22 LTS
- **Language**: TypeScript 5.x (strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- **Testing**: Vitest 3.x (golden, property-based, conformance, regression)
- **Database**: PostgreSQL (pg + node-pg-migrate) — infrastructure layer only
- **Build**: tsup per package, orchestrated by Turborepo
- **Layers** (strict dependency rule — all deps point inward):
  - `packages/domain/` → zero runtime deps (entities, VOs, services, events, errors)
  - `packages/application/` → depends on domain (use cases, port interfaces, DTOs, strategies)
  - `packages/adapters/` → depends on application + domain (storage, LLM, tool, explorer adapters)
  - `packages/infrastructure/` → depends on adapters + application + domain (SQL, crypto, config)
  - `packages/sdk/` → depends on all (public API: `createMemoryEngine()`)
- **Cross-package tests**: `tests/` (golden, property, conformance, regression)
- **Specs**: `specs/` (spec-kit artifacts — source of truth for implementation)
- **Design docs**: `docs/` (architecture, design decisions, testing strategy)

**CRITICAL:** Read issue → read ALL relevant docs/specs/skills → check dependencies → plan with constitution check → implement incrementally → run verification gates → close.

---

## Hard Rules (Do Not Violate)

1. **No blind coding**: MUST load the Beads issue, ALL relevant spec artifacts, design docs, constitution, relevant skills, and relevant package code BEFORE writing any implementation code.
2. **Constitution compliance is mandatory**: `.specify/memory/constitution.md` governs quality, testing, UX, performance, and simplicity. Every change must comply.
3. **Clean Architecture strict dependency rule**: `domain ← application ← adapters ← infrastructure ← sdk`. No inward violations. No shortcut imports.
4. **Forbidden imports enforcement**: Domain and application layers MUST NOT import SQL/pg/crypto/fs/zod/framework SDKs. Load `clean-architecture-guardrails` skill when in doubt.
5. **Keep changes minimal**: reuse existing ports, types, patterns, and utilities. Avoid new libraries unless required by spec.
6. **Tests required**: every behavioral change MUST include automated tests at the appropriate level per `docs/testing-strategy.md`. Bug fixes MUST include a regression test.
7. **Verification gates are mandatory** before closing:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - `pnpm build`

---

## Phase 0 — Preconditions & Intake (MANDATORY)

### 0.1 Parse Arguments

From `$ARGUMENTS` parse:
- **Required**: `$ISSUE_ID` (e.g., `bd-abc123` or `bd-abc123.1`)
- **Optional**:
  - `--scope domain|application|adapters|infrastructure|sdk|cross-cutting`
  - `--dry-run` (plan only: **no file changes**, **no `bd update`**, **no `bd close`**, **no `bd dolt push`**)

If `$ISSUE_ID` is missing, stop and show usage:
```text
/implement-beads <beads-issue-id> [--scope domain|application|adapters|infrastructure|sdk|cross-cutting] [--dry-run]
```

---

### 0.2 Verify Beads CLI Availability

```bash
bd --version
```

If `bd` is not available: **STOP** and instruct the user to install Beads (`brew install beads` or see https://github.com/steveyegge/beads).

---

### 0.3 Sync Beads State

Pull latest state before reading issues:

```bash
bd dolt pull
```

> **Note**: `bd sync` is deprecated. Always use `bd dolt pull` / `bd dolt push`.

---

### 0.4 Load Issue Context

```bash
bd show "$ISSUE_ID" --json
```

Extract and display:

```text
🧩 BEADS ISSUE LOADED
════════════════════════════════
ID:         <id>
Type:       <epic | task | bug | feature | chore | decision>
Title:      <title>
Status:     <open | in_progress | blocked | deferred | closed>
Priority:   <0-4>
Assignee:   <assignee or "unassigned">
Spec ID:    <spec_id or "none">

Description:
<description summary — note if full spec content is embedded>

Acceptance Criteria:
<acceptance_criteria field content>

Dependencies:
- <list dependency IDs and types, or "none">

Labels:
- <labels or "none">

Mentioned Paths:
- <extract paths matching packages/..., tests/..., specs/..., docs/...>
════════════════════════════════
```

If issue is already `closed`, stop and ask whether to reopen/continue (do not proceed automatically).

---

### 0.5 Dependency Gate (Blocked Work Must Not Start)

Use `bd ready` to confirm it's implementable:

```bash
bd ready --json
```

If the issue is **not present** in `bd ready` output, treat it as blocked and show:

```text
⛔ ISSUE NOT READY (BLOCKED OR NOT ELIGIBLE)
────────────────────────────────────────
Action:
- Implement the blocking issues first, OR
- Remove/adjust invalid dependencies: bd dep list <id>
- Check blockers: bd blocked --json
────────────────────────────────────────
```

**STOP** here if blocked/not ready.

---

### 0.6 Determine Scope (or Use `--scope`)

Interpret scope by Clean Architecture layers:

- **domain**: entities, value objects, domain services, domain events, domain errors — pure logic, zero runtime deps
- **application**: use cases, port interfaces, DTOs, policies/strategies — orchestrates domain
- **adapters**: implementations of ports (storage, LLM, tool, explorer adapters) — depends on application + domain
- **infrastructure**: SQL/pg, crypto, config, migrations, composition root — concrete runtime wiring
- **sdk**: public API surface (`createMemoryEngine()`), framework integrations
- **cross-cutting**: monorepo config, shared test harnesses, docs, lint rules, CI scripts, multiple layers

If `--scope` is provided, use it. Otherwise infer:

| Issue Mentions | Scope |
|---|---|
| entity, value object, domain service, domain event, domain error, invariant, aggregate | domain |
| use case, port, DTO, strategy, policy, orchestration | application |
| adapter, storage adapter, LLM adapter, tool adapter, explorer, `implements *Port` | adapters |
| PostgreSQL, migration, SQL, crypto, config, composition root, pg, `node-pg-migrate` | infrastructure |
| SDK, `createMemoryEngine`, public API, framework adapter, Vercel | sdk |
| monorepo, turborepo, eslint, CI, docs, testing harness, multiple packages | cross-cutting |

Print:

```text
🎯 SCOPE
────────────────────────
Scope:   <domain|application|adapters|infrastructure|sdk|cross-cutting>
Reason:  <one sentence>
Dry-run: <true|false>
────────────────────────
```

---

### 0.7 Mark In Progress (unless `--dry-run`)

If status is `open`, claim the issue:

```bash
bd update "$ISSUE_ID" --claim --json
```

If `--dry-run`, do not update anything and clearly state that no status changes will be made.

---

## Phase 1 — Mandatory Reading & Context Load (MUST COMPLETE BEFORE CODING)

**Goal:** Deeply understand the requirements, architecture, and house style. **No implementation may begin until this phase is complete.**

### 1.1 Always Load Policy & Design Files (MUST READ ALL)

Read these files to align with project governance and architecture:

**Policy files:**
- `CLAUDE.md` — project overview, commands, architecture summary, implementation order
- `AGENTS.md` — agent workflow, commands, session completion rules
- `.specify/memory/constitution.md` — the 5 non-negotiable principles (code quality, testing, UX, performance, simplicity)

**Design documentation (read relevant sections):**
- `docs/high-level-design.md` — full architecture blueprint: layers, domain model, use cases, ports, adapters, schema, compaction, explorers, error taxonomy, roadmap
- `docs/design-decisions-addendum.md` — ID canonicalization, LedgerEvent schema, DAG integrity checks, compaction rules, test stubs
- `docs/testing-strategy.md` — golden tests, property-based, conformance, regression, CI pipeline

**Skills (load based on issue scope):**
- **Always**: `clean-architecture-guardrails` — layer boundary enforcement
- If IDs/hashing: `ids-and-hashing` — SHA-256 canonicalization rules
- If compaction/DAG: `compaction-rules`, `dag-integrity`
- If ports/adapters: `ports-and-adapters`
- If explorers: `explorer-template`
- If golden tests: `golden-tests`
- If PostgreSQL: `pg-schema`

---

### 1.2 Load Speckit Artifacts (SOURCE OF TRUTH)

Beads issues in this repo typically have full spec content embedded in their description body AND reference a `specs/` directory.

**Step 1 — Extract Spec Folder from Issue:**

In the issue description (from `bd show`) or `spec_id` field, look for references like:
```text
## Source
Spec: specs/001-domain-value-objects
```
Or the `spec_id` field may contain: `001-domain-value-objects`

**Set `$SPEC_DIR`**: e.g., `specs/001-domain-value-objects`

**Step 2 — Read ALL Spec Artifacts (if $SPEC_DIR exists):**

Read each file carefully — these are the source of truth for implementation:

- `$SPEC_DIR/spec.md` — user stories, functional requirements, acceptance scenarios, edge cases
- `$SPEC_DIR/plan.md` — tech stack, project structure, phases, constitution check
- `$SPEC_DIR/data-model.md` — entity/VO definitions, fields, relationships, validation rules, invariants
- `$SPEC_DIR/research.md` — technology decisions with rationale
- `$SPEC_DIR/quickstart.md` — key validation scenarios
- `$SPEC_DIR/contracts/` — all files: API/interface contracts
- `$SPEC_DIR/checklists/` — all files: quality gates that must pass

**Use these as implementation guidance:**

| Artifact | Use For |
|----------|---------|
| `spec.md` | User story details, acceptance scenarios, edge cases, functional requirements |
| `plan.md` | Tech stack decisions, project structure, implementation phases, constitution gates |
| `data-model.md` | Entity/VO attributes, relationships, validation rules, invariants, state transitions |
| `contracts/` | Port interface definitions, API schemas, event formats |
| `research.md` | Technical decisions, library choices, constraints, alternatives considered |
| `quickstart.md` | Key validation and integration scenarios |
| `checklists/` | Quality gates — all must pass before implementation is complete |

If no spec folder exists and no spec content is in the issue body, proceed using only the issue description + design docs.

---

### 1.3 Load Relevant Package Code

Based on the determined scope and mentioned paths, read the target package(s):

- **Target package**: `packages/<scope>/src/index.ts` and relevant source files
- **Adjacent packages** (for boundary understanding): read the port interfaces or types being consumed/implemented
- **Existing tests**: check for test files in `packages/<scope>/src/__tests__/` or related patterns
- **Cross-package tests**: check `tests/` for relevant golden/conformance/property test files

For domain scope, also inspect:
- Existing entities, value objects, and domain services for naming/pattern conventions

For application scope, also inspect:
- Port interface definitions and existing use cases for patterns

For adapters scope, also inspect:
- Existing adapter implementations to follow the same port-implementation pattern

---

### 1.4 Summarize Discovered Patterns (Short)

Produce a short "patterns discovered" note:

```text
📐 PATTERNS DISCOVERED
────────────────────────────────
Layering:     <how packages reference each other>
Naming:       <entity/VO/port/use-case naming conventions>
Exports:      <barrel export patterns, index.ts structure>
Error model:  <DomainError taxonomy, typed errors>
Test style:   <vitest patterns, golden fixtures, stubs used>
Build:        <tsup/tsc-b, package.json scripts>
────────────────────────────────
```

**Checkpoint — confirm before proceeding:**

```text
✅ MANDATORY READING COMPLETE
────────────────────────────────
- [ ] Constitution read
- [ ] Design docs read (relevant sections)
- [ ] Spec artifacts read (all available)
- [ ] Relevant skills loaded
- [ ] Target package code inspected
- [ ] Patterns documented
────────────────────────────────
```

All boxes must be checked before proceeding to Phase 2.

---

## Phase 2 — Plan (Implementation Plan + Constitution Check)

### 2.1 Restate Acceptance Criteria as Verifiable Checks

Convert each acceptance criterion into:
- **Code change target(s)**: which files/modules in which package
- **Test(s)**: what automated test will prove it (unit/golden/conformance/property)

### 2.2 Clean Architecture Plan (strict)

Identify for each change:
- **Which layer** it belongs in (domain/application/adapters/infrastructure/sdk)
- **What ports/interfaces** are needed (application defines; adapters implement)
- **New exports**: list each and justify its layer placement
- **Import direction**: confirm all imports flow inward only

### 2.3 Constitution Check (REQUIRED)

Evaluate the plan against the 5 constitutional principles:

```text
📋 CONSTITUTION CHECK
════════════════════════════════
I.   Code Quality:    <PASS/FAIL — boundaries preserved, no dead code, complexity justified>
II.  Testing:         <PASS/FAIL — appropriate tests identified per change type>
III. UX Consistency:  <PASS/N/A — only for user-facing: SDK API, CLI, docs>
IV.  Performance:     <PASS/N/A — measurable targets defined if applicable>
V.   Simplicity:      <PASS/FAIL — minimal diff, no premature abstractions>
════════════════════════════════
```

All applicable checks must PASS before implementation begins. If any FAIL, revise the plan.

### 2.4 No-Go Conditions

If any of these are true, **STOP** and ask for clarification:
- Spec conflicts with design docs (`docs/high-level-design.md`)
- Implementation would require forbidden imports (domain/application importing infrastructure)
- Would require a new library not already in the dependency tree without explicit justification
- Acceptance criteria are ambiguous or contradictory

---

## Phase 3 — Implement Incrementally (TDD-Oriented)

### 3.1 Test-First (Per Testing Strategy)

Follow `docs/testing-strategy.md` for test-level selection:

- **Unit tests**: Vitest in-package for domain logic, value object invariants, use case orchestration
- **Golden tests**: deterministic fixtures with `SimpleTokenizer` + `DeterministicSummarizer` stubs (see `golden-tests` skill)
- **Property-based tests**: fast-check for invariant properties (if already used in repo)
- **Conformance tests**: cross-adapter tests in `tests/` ensuring adapter substitutability
- **Regression tests**: for bug fixes — must fail before fix, pass after

Run targeted tests during development:
```bash
pnpm vitest run path/to/test.ts
```

### 3.2 Implementation Guidelines (Clean Architecture)

- **Domain**: keep pure — no IO, no framework imports, no side effects. Entities enforce their own invariants via factory functions or constructors.
- **Application**: orchestrate via ports. Use cases receive port implementations via constructor/parameter injection. Define DTOs at this layer.
- **Adapters**: implement port interfaces defined in application. One adapter per port. Follow existing adapter patterns.
- **Infrastructure**: wire concrete implementations. PostgreSQL adapters use `node-postgres` directly. Migrations via `node-pg-migrate`.
- **SDK**: expose stable public API. Minimize churn. Never leak internal types.

Forbidden patterns:
- No `any` types, no `@ts-expect-error`
- No importing from outer layers into inner layers
- No hidden globals — use explicit dependency injection

### 3.3 Document What You Changed (As You Go)

Maintain a running list:
- Files created/changed (with package paths)
- New exports/APIs added
- Tests added/modified
- How to test locally

---

## Phase 4 — Verification Gates (MANDATORY)

Run from repo root:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Produce a gate report:

```text
✅ VERIFICATION GATES
════════════════════════════════
typecheck:  PASS
lint:       PASS
test:       PASS
build:      PASS
════════════════════════════════
```

If any gate fails:
- Do not close the Beads issue
- Keep status `in_progress`
- Summarize failures + specific fix actions
- Fix and re-run gates until all pass

For faster iteration, use targeted commands:
```bash
pnpm vitest run path/to/specific-test.ts    # Single test file
turbo run typecheck --filter @ledgermind/domain  # Single package
```

---

## Phase 5 — Update Beads + Close (Skip if `--dry-run`)

### 5.1 Append Implementation Notes to the Issue

```bash
bd update "$ISSUE_ID" --append-notes "
## Implementation Notes ($(date +%Y-%m-%d))

### What changed
- packages/<layer>/src/<...>.ts: <summary>
- tests/<...>.test.ts: <summary>

### How to verify
pnpm typecheck && pnpm lint && pnpm test && pnpm build

### Notes / Limitations
- <if any>
" --json
```

---

### 5.2 Close the Issue

```bash
bd close "$ISSUE_ID" --reason "Implemented per acceptance criteria. Verified: typecheck, lint, test, build all pass." --suggest-next --json
```

---

### 5.3 Push Beads State

```bash
bd dolt push
```

---

## Output Summary (Always)

At the end, print:

```text
✅ BEADS ISSUE COMPLETED
════════════════════════════════
Issue:  <id> — <title>
Scope:  <domain|application|adapters|infrastructure|sdk|cross-cutting>

Mandatory reading: ✅ complete

Files changed:
- <path>
- <path>

Verification:
- pnpm typecheck: PASS
- pnpm lint:      PASS
- pnpm test:      PASS
- pnpm build:     PASS

Beads:
- status: closed
- dolt push: done
════════════════════════════════
Next: bd ready --json
```

If `--dry-run`, print instead:

```text
🧪 DRY RUN COMPLETE
════════════════════════════════
No files were changed.
No Beads status was updated.
No dolt push was performed.
Proposed plan + verification steps are ready.
Mandatory reading: ✅ complete
════════════════════════════════
```

---

## Error Handling

### Issue Not Found
```bash
bd list --json
```
Ask the user to confirm the correct ID.

### Issue Blocked
Show blockers with `bd dep tree <id>` and stop. Recommend implementing blockers first.

### Verification Failures
- Keep issue `in_progress`
- Provide the exact failing output summary and a short fix plan
- Re-run gates after fixes

### Boundary Violations
If lint/typecheck indicates forbidden imports or layer boundary breaches:
- Identify the violating import
- Move code to the correct layer or define a port interface
- Load `clean-architecture-guardrails` skill for guidance
- Re-run gates

---

## Agent Teams Compatibility

When using **Agent Teams** (parallel Beads implementation), this command serves as the **canonical reference** — but phases split across lead and teammates:

### Phase Ownership

| Phase | Single Session | Agent Teams: Lead | Agent Teams: Teammate |
|---|---|---|---|
| **0.1–0.3** Parse + Verify + Sync | ✅ | ✅ | — |
| **0.4** Load Issue | ✅ | ✅ (sends to teammate) | Receives from lead |
| **0.5** Dependency Gate | ✅ | ✅ | — |
| **0.6** Determine Scope | ✅ | ✅ | — |
| **0.7** Mark In Progress | ✅ | ✅ | — |
| **1.1** Load Policy/Design Files | ✅ | — | ✅ (self-load) |
| **1.2** Load Speckit Artifacts | ✅ | ✅ (sends to teammate) | Receives + reads |
| **1.3** Load Package Code | ✅ | — | ✅ (self-load for their layer) |
| **1.4** Summarize Patterns | ✅ | — | ✅ (internal) |
| **2.1–2.4** Plan + Constitution | ✅ | Reviews + approves | ✅ (produces plan) |
| **3.1–3.3** Implement | ✅ | — | ✅ |
| **4** Verification Gates | ✅ (full) | ✅ (full) | Targeted only |
| **5** Close + Push | ✅ | ✅ (only lead) | ❌ Never |

### Teammate Constraints

- Teammates **cannot run `/implement-beads`** — they receive explicit instructions from the lead
- Teammates **must announce file/package ownership** before editing (one file = one owner)
- Teammates **must not run `bd close` or `bd dolt push`** — only the lead does this
- Teammates run **targeted checks** (`pnpm typecheck` + `pnpm vitest run <path>`)
- Teammates **report back** with: files changed, new exports/APIs, check results, how to test locally, any issues

---

## Quick Reference

```bash
# Implement
/implement-beads bd-abc123

# Plan only (no changes, no bd updates)
/implement-beads bd-abc123 --dry-run

# Force explicit scope
/implement-beads bd-abc123 --scope domain
/implement-beads bd-abc123 --scope application
/implement-beads bd-abc123 --scope cross-cutting

# Beads CLI
bd show <id> --json
bd list --json
bd ready --json
bd update <id> --claim --json
bd close <id> --reason "..." --suggest-next --json
bd dep tree <id>
bd dolt pull
bd dolt push

# Verification (this repo)
pnpm typecheck
pnpm lint
pnpm test
pnpm build

# Targeted testing
pnpm vitest run path/to/test.ts
pnpm test:domain
```

---

## Architecture Quick Reference

```
packages/
├── domain/              # Zero deps — entities, VOs, services, events, errors
│   └── src/
├── application/         # Depends on domain — use cases, ports, DTOs, strategies
│   └── src/
├── adapters/            # Depends on application + domain — port implementations
│   └── src/
├── infrastructure/      # Depends on adapters + app + domain — SQL, crypto, config
│   └── src/
└── sdk/                 # Depends on all — public API: createMemoryEngine()
    └── src/

specs/                   # Spec-kit artifacts (source of truth)
├── 001-feature-name/
│   ├── spec.md          # User stories, FRs, acceptance scenarios
│   ├── plan.md          # Tech stack, structure, phases
│   ├── data-model.md    # Entity definitions, invariants
│   ├── research.md      # Technical decisions
│   ├── quickstart.md    # Validation scenarios
│   ├── contracts/       # Interface contracts
│   └── checklists/      # Quality gates

docs/                    # Design documentation
├── high-level-design.md
├── design-decisions-addendum.md
├── testing-strategy.md
├── claude-code-integration.md
└── lcm-framework-research.md

tests/                   # Cross-package tests (golden, property, conformance, regression)

.specify/memory/         # Constitution (highest-priority policy)
└── constitution.md
```
