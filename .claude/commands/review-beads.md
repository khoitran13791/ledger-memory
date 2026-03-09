---
description: Review, proofread, and refine existing Beads issues (quality + dependency graph) for the LedgerMind Clean Architecture TypeScript monorepo
argument-hint: "[optional scope: open|all|epic:<id>|<id> <id> ...]"
---

# Review Beads Issues (LedgerMind — Clean Architecture TS Monorepo)

You are reviewing **existing** Beads issues/epics/tasks to make them easy to implement in this repository.

Repo context (use in your edits):
- **Stack:** pnpm 9.x monorepo + Turborepo, Node.js 22 LTS, TypeScript 5.x (strict)
- **Testing:** Vitest 3.x (golden, property-based, conformance, regression)
- **Database:** PostgreSQL (pg + node-pg-migrate) — infrastructure layer only
- **Build:** tsup per package, Turborepo orchestration
- **Architecture:** Clean Architecture with strict dependency rule:
  - `packages/domain/` → zero deps (entities, VOs, services, events, errors)
  - `packages/application/` → depends on domain (use cases, ports, DTOs, strategies)
  - `packages/adapters/` → depends on application + domain (port implementations)
  - `packages/infrastructure/` → depends on adapters + application + domain (SQL, crypto, config)
  - `packages/sdk/` → depends on all (public API: `createMemoryEngine()`)
- **Cross-package tests:** `tests/` (golden, property, conformance, regression)
- **Specs:** `specs/` (spec-kit artifacts — source of truth)
- **Design docs:** `docs/` (architecture, design decisions, testing strategy)
- **Constitution:** `.specify/memory/constitution.md` (highest-priority engineering policy)
- **Build gates:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`

**Goal:** Mechanical quality improvements + dependency hygiene **without changing intent**. If intent is unclear, add "Clarify" questions.

---

## Hard Rules

1. **Snapshot first** before any edits.
2. **Safe edits only:** improve wording/structure; do not change meaning.
3. **Don't guess:** if ambiguous, add explicit questions and mark as needing clarification.
4. **Max 5 passes** (stop early if clean).
5. **Validate dependencies** after changes (cycles + "ready" set sanity).
6. **Read relevant docs first:** before reviewing, read `CLAUDE.md` and `docs/high-level-design.md` (relevant sections) to understand correct layer assignments and terminology.

---

## Phase 0 — Parse Scope (MANDATORY)

Interpret `$ARGUMENTS`:

- empty → `open`
- `open` → review open issues
- `all` → review all issues
- `epic:<id>` → that epic + its descendants
- `<id> <id> ...` → specific issue IDs

Print:

```text
🧭 REVIEW SCOPE
────────────────────────
Target: <open|all|epic:...|ids...>
Mode:   review + safe fixes
Passes: up to 5
────────────────────────
```

---

## Phase 1 — Snapshot & Preconditions (MANDATORY)

### 1.1 Verify Beads CLI
```bash
bd --version
```

If unavailable: **STOP** and ask the user to install/configure Beads.

### 1.2 Sync Beads State
```bash
bd dolt pull
```

> **Note**: `bd sync` is deprecated. Always use `bd dolt pull` / `bd dolt push`.

### 1.3 Snapshot current state (backup)
```bash
bd list --all --json > /tmp/beads-snapshot-$(date +%Y%m%d-%H%M%S).json
```

If snapshot fails: **STOP**.

### 1.4 Load Repo Context (MUST READ)

Before reviewing issues, read these to understand what correct issues should reference:

- `CLAUDE.md` — architecture, commands, tech stack, implementation order
- `docs/high-level-design.md` — domain model, use cases, ports, layer assignments (read relevant sections)
- `docs/testing-strategy.md` — test level expectations (skim for reference)

---

## Phase 2 — Load Issues & Build Manifest (MANDATORY)

### 2.1 Load list(s)
```bash
bd list --json
bd ready --json
```

Filter according to scope. For epic scope, use:
```bash
bd show <epic-id> --children --json
```

### 2.2 Hydrate details for each issue in scope
```bash
bd show <id> --json
```

Capture: `id, title, status, priority, type, description, acceptance_criteria, notes, dependencies, labels, spec_id`

### 2.3 Print Review Manifest
```text
📦 REVIEW MANIFEST
────────────────────────
□ bd-...  <type>  P<prio>  [labels]  <title>
□ bd-...  <type>  P<prio>  [labels]  <title>
...
────────────────────────
Total: <N>
```

If zero issues match scope:
```text
⚠️ No issues found for scope: $ARGUMENTS
Try: /review-beads open  or  /review-beads all
```

---

## Phase 3 — Review Pass Loop (up to 5)

Repeat passes until clean or 5 passes reached.

```text
🔁 REVIEW PASS X/5
════════════════════════════════════════
```

---

### 3.A Audit Checklist (per issue)

#### A1) Clarity
- Title is specific and action-oriented (avoid "Fix bug", "Update code")
- Description states **what** + **why**
- Terms are defined (especially domain model, ports, compaction, DAG, explorer specifics)

#### A2) Fit to this repo (Clean Architecture alignment)
- References correct layers when relevant:
  - Domain: `packages/domain/` (entities, VOs, services, events, errors — zero deps)
  - Application: `packages/application/` (use cases, port interfaces, DTOs, strategies)
  - Adapters: `packages/adapters/` (port implementations — storage, LLM, tool, explorer)
  - Infrastructure: `packages/infrastructure/` (SQL, crypto, config, migrations)
  - SDK: `packages/sdk/` (public API surface)
- Respects dependency rule (no outward imports from inner layers)
- Notes forbidden imports if touching domain/application layers
- References correct spec artifacts (`specs/<id>/`) if derived from spec-kit
- Labels include layer tag (e.g., `layer:domain`, `layer:application`) when applicable

#### A3) Acceptance Criteria
- Has checkboxes
- Includes verification signal (unit test / golden test / conformance test)
- Calls out required gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
- References relevant testing patterns from `docs/testing-strategy.md` where applicable

#### A4) Scope & sizing
- Task is implementable without hidden requirements
- Big items are split (epic with child tasks via hierarchical IDs)
- Single task should target one layer where possible

#### A5) Dependencies
- Dependencies match actual blocking order (inner layers before outer)
- No "depends on child" anti-pattern
- >8 deps usually over-constrained
- Domain tasks should block application tasks, which should block adapter tasks (natural layer order)

#### A6) Spec-kit traceability
- If issue was derived from spec-kit, `spec_id` field should reference the spec folder
- Issue description should embed or reference relevant spec artifacts
- Acceptance criteria should trace back to spec user stories / functional requirements

---

### 3.B Apply Safe Fixes (mechanical only)

#### B1) Title normalization
- Epic: `Epic: <feature area>`
- Task: `T###: <verb> <component> in <layer> (so that <result>)`
- Bug: `Bug: <symptom> in <package> (<trigger>)`
- Feature: `Feature: <capability> in <layer>`
- Decision: `ADR: <decision topic>`

```bash
bd update <id> --title "T014: Implement ContextId value object in domain (so that contexts are content-addressed)" --json
```

#### B2) Add/append description scaffolding (don't overwrite)

If sparse, append using `--append-notes`:

```text
## Summary
<TODO: 1–2 sentences>

## Context
<TODO: why it matters>

## Proposed Approach
- <TODO: brief steps>

## Target Layer & Code Areas
- Layer: <domain|application|adapters|infrastructure|sdk>
- packages/<layer>/src/<...>.ts
- tests/<...>.test.ts (if cross-package test)

## Architecture Notes
- Dependency rule: <what this module may/must not import>
- Ports involved: <port interfaces consumed or implemented>
- Forbidden imports: <list if domain/application layer>

## Spec Reference
- Spec: specs/<id>/spec.md (if applicable)
- Derived from: <spec artifacts used>

## Testing / Verification
- <TODO: vitest path, golden fixture, conformance test>
- Gates: pnpm typecheck && pnpm lint && pnpm test && pnpm build

## Acceptance Criteria
- [ ] <TODO>
```

```bash
bd update <id> --append-notes "<scaffolding above>" --json
```

#### B3) Acceptance criteria patch (minimal defaults)

If `acceptance_criteria` field is empty, update it:

```bash
bd update <id> --acceptance "- [ ] Behavior matches description
- [ ] Clean Architecture dependency rule respected (no outward imports)
- [ ] Typecheck passes (pnpm typecheck)
- [ ] Lint passes (pnpm lint)
- [ ] Tests updated/added (pnpm test)
- [ ] Build passes (pnpm build)" --json
```

#### B4) Labels (add layer tags if missing)

If issue clearly targets a layer but lacks a label:
```bash
bd update <id> --add-label "layer:domain" --json
```

#### B5) Spec ID (link if discoverable)

If issue references a spec folder but `spec_id` is empty:
```bash
bd update <id> --spec-id "001-domain-value-objects" --json
```

#### B6) Clarification handling (don't guess)

If intent is unclear, append a **Clarify** section via notes:

```bash
bd update <id> --append-notes "
## Clarify (needs human input)
- [ ] Which Clean Architecture layer does this belong in?
- [ ] What port interfaces are consumed or implemented?
- [ ] Are there forbidden import constraints to document?
- [ ] What test level is appropriate (unit/golden/conformance/property)?
- [ ] Does this trace back to a spec-kit artifact?
" --json
```

---

### 3.C Dependency Hygiene

#### C1) Remove redundant edges
```bash
bd dep remove <blocked-id> <blocker-id> --json
```

#### C2) Add missing blockers (only if ordering is truly required)

Typical blocking order for this repo:
- Domain entities/VOs → Application use cases/ports
- Application ports → Adapter implementations
- Adapters → Infrastructure wiring
- All layers → SDK integration

```bash
bd dep add <blocked-id> <blocker-id> --json
```

#### C3) Validate for cycles
```bash
bd dep cycles --json
```

If a cycle is found, propose the **smallest** edge removal and **ask for confirmation** before executing.

#### C4) Dependency tree visualization

For complex epics, visualize the tree:
```bash
bd dep tree <epic-id> --direction both
```

#### C5) Sanity check "ready" set
```bash
bd ready --json
```
Should have at least some ready tasks unless intentionally fully blocked.

---

### 3.D Pass Summary

```text
🧾 PASS X SUMMARY
────────────────────────
Titles updated:         <n>
Descriptions scaffolded:<n>
AC improved:            <n>
Labels added:           <n>
Spec IDs linked:        <n>
Deps added/removed:     +<n> / -<n>
Clarify flags added:    <n>
Remaining issues:       <n>
────────────────────────
```

Stop early if remaining issues = 0.

---

## Phase 4 — Final Report (MANDATORY)

```text
✅ BEADS REVIEW COMPLETE
════════════════════════════════════════

Scope:           $ARGUMENTS
Passes used:     X/5
Issues reviewed: <N>

Quality outcomes
────────────────────────
- Clear titles:             <n>/<N>
- Has Summary/Context:      <n>/<N>
- Has Acceptance Criteria:  <n>/<N>
- Layer correctly assigned: <n>/<N>
- Spec traceability:        <n>/<N>

Dependency health
────────────────────────
Cycles:      <0|found>
Ready tasks: <count>
Layer order: <correct|issues found>

Needs human clarification
────────────────────────
- bd-... <title> — <one-line why>
- bd-... <title> — <one-line why>

Next
────────────────────────
Run: bd ready --json
Then: /implement-beads <id>
════════════════════════════════════════
```

### 4.1 Push Beads State (if any edits were made)

```bash
bd dolt push
```

---

## Notes on Spec-Kit Compatibility

- If an issue is an **epic** lacking a plan, recommend:
  - `/speckit.plan` to generate the implementation plan
  - `/speckit.tasks` to generate/refresh tasks
  - Ensure Beads issue AC aligns with spec artifacts
- If `specs/` contains a relevant spec folder, ensure the issue's `spec_id` links to it
- If `.specify/memory/constitution.md` principles are not reflected in acceptance criteria, flag for improvement
- Beads issues in this repo typically embed full spec content in their description — verify this content matches the spec folder artifacts

---

## Quick Reference

```bash
# Sync state
bd dolt pull

# Snapshot
bd list --all --json > /tmp/beads-snapshot-$(date +%Y%m%d-%H%M%S).json

# Load
bd list --json
bd ready --json
bd show <id> --json
bd show <id> --children --json

# Update
bd update <id> --title "..." --json
bd update <id> --append-notes "..." --json
bd update <id> --acceptance "..." --json
bd update <id> --priority 2 --json
bd update <id> --add-label "layer:domain" --json
bd update <id> --spec-id "001-feature-name" --json

# Dependencies
bd dep add <blocked> <blocker> --json
bd dep remove <blocked> <blocker> --json
bd dep cycles --json
bd dep tree <id> --direction both

# Push changes
bd dolt push

# After review
bd ready --json
/implement-beads <id>
```
