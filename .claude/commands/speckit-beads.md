---
description: Create Beads issues directly from Speckit spec artifacts for LedgerMind (Clean Architecture monorepo)
argument-hint: <specs/feature-dir> [--dry-run] [--update]
---

# Speckit → Beads Import (LedgerMind)

You are creating Beads issues directly from a Speckit feature specification located at `specs/NNN-feature-name/`.

**Key principle**: Beads issues ARE the task list — no `tasks.md` needed. Derive tasks directly from spec.md, plan.md, data-model.md, and contracts/.

**LedgerMind requirement**: Every created Beads issue (epics + tasks) MUST embed the full contents (verbatim) of ALL relevant Speckit artifacts in the issue body via `--body-file`:
- `spec.md`
- `plan.md`
- `data-model.md` (if present)
- `research.md` (if present)
- `quickstart.md` (if present)
- `contracts/*` (if present)
- `checklists/*` (if present)

---

## Hard Rules

1. **VERIFY BEADS CLI** — Stop if `bd` is not installed
2. **LEDGERMIND ARCHITECTURE** — Generate tasks for a Clean Architecture TypeScript monorepo (`packages/*`), NOT a Remix/Next.js app
3. **EMBED ALL SPECKIT ARTIFACTS** — Every issue body must include full file contents of all relevant speckit docs
4. **USE `--body-file`** — Always write issue bodies to a temp file and use `--body-file` (never inline long `--description`)
5. **USE `--parent` FOR HIERARCHY** — Use `--parent` to create child issues (gives hierarchical IDs like `lm-a3f8.1`)
6. **MINIMAL DEPS** — Only add phase-level dependency edges (epic-to-epic via `bd dep add`), not task-to-task
7. **RESPECT `--dry-run`** — Add `--dry-run` flag to every `bd create` command if user passed `--dry-run`
8. **VERIFICATION GATES** — Use `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`

---

## Phase 0 — Preconditions & Intake (MANDATORY)

### 0.1 Parse Arguments

From `$ARGUMENTS` extract:
- **Required**: `FEATURE_DIR` (e.g., `specs/001-domain-value-objects`)
- **Optional**:
  - `--dry-run` — Plan only, add `--dry-run` to all `bd create` commands
  - `--update` — Update existing issues instead of creating new ones

If `FEATURE_DIR` is missing, stop and show usage:
```text
/speckit.beads specs/<feature-dir> [--dry-run] [--update]
```

Derive a stable spec identifier:
- `SPEC_ID` = basename of `FEATURE_DIR` (e.g., `001-domain-value-objects`)

### 0.2 Verify Beads CLI + DB

```bash
bd --version
```

If `bd` is not available: **STOP** and instruct:
```text
⛔ BEADS CLI NOT FOUND
Install beads: https://github.com/steveyegge/beads
```

Verify database exists (Beads uses Dolt, not SQLite):
```bash
ls -la .beads/dolt/
```

If `.beads/dolt/` does not exist: **STOP** and instruct to run `bd init`.

### 0.3 Validate Feature Directory

```bash
ls -la "$FEATURE_DIR"
```

**Required files**:
- `spec.md` — User stories and requirements
- `plan.md` — Technical plan and structure

**Optional files** (enhance task generation):
- `data-model.md` — Entity definitions → domain layer tasks
- `research.md` — Technical decisions → setup tasks
- `quickstart.md` — Validation scenarios → test tasks
- `contracts/` — Port/API specifications → adapter tasks
- `checklists/` — Quality gates → verification tasks

If `spec.md` or `plan.md` is **missing**, stop and instruct:
```text
⛔ REQUIRED FILES MISSING

Ensure these exist:
  $FEATURE_DIR/spec.md
  $FEATURE_DIR/plan.md

Run /speckit.specify and /speckit.plan first if needed.
```

---

## Phase 1 — Load Spec Artifacts (MANDATORY)

Read files in this order to build context:

### 1.1 Read Core Files

```bash
cat "$FEATURE_DIR/spec.md"
cat "$FEATURE_DIR/plan.md"
```

**Extract from spec.md:**
- Feature name and branch
- User Stories (US1, US2, US3...) with priorities and titles
- Acceptance scenarios for each story
- Functional Requirements (FR-*)
- Success Criteria (SC-*)
- Edge cases

**Extract from plan.md:**
- Technical stack and constraints
- Project structure paths (packages/domain, packages/application, etc.)
- Phase breakdown
- Key dependencies/libraries

### 1.2 Read Optional Files (if present)

```bash
cat "$FEATURE_DIR/data-model.md" 2>/dev/null
cat "$FEATURE_DIR/research.md" 2>/dev/null
cat "$FEATURE_DIR/quickstart.md" 2>/dev/null
ls "$FEATURE_DIR/contracts/" 2>/dev/null && cat "$FEATURE_DIR/contracts/"* 2>/dev/null
ls "$FEATURE_DIR/checklists/" 2>/dev/null && cat "$FEATURE_DIR/checklists/"* 2>/dev/null
```

**Extract from data-model.md:**
- Entities and their attributes
- Value objects and invariants
- Relationships between entities
- Validation rules

**Extract from contracts/:**
- Port interfaces (TypeScript interfaces)
- Domain service contracts
- Public API surface definitions

**Extract from research.md:**
- Technology decisions and rationale

**Extract from quickstart.md:**
- Validation scenarios and acceptance checks

### 1.3 Print Load Summary

```text
📁 SPEC ARTIFACTS LOADED
════════════════════════════════
Feature: [name from spec.md]
Branch: [branch from spec.md]
Spec ID: [SPEC_ID]

Loaded:
  ✓ spec.md — [X] user stories, [Y] FRs
  ✓ plan.md — tech stack captured
  ◦ data-model.md — [X] entities / not found
  ◦ research.md — [found/not found]
  ◦ quickstart.md — [found/not found]
  ◦ contracts/ — [X] files / not found
  ◦ checklists/ — [X] files / not found
════════════════════════════════
```

---

## Phase 2 — Derive Task Structure (Clean Architecture)

Generate tasks organized by **architecture layer** and **user story**:

### 2.1 Foundation Tasks (from plan.md + research.md)

Generate tasks for:
- Project structure setup / scaffolding
- Dependencies installation
- Configuration files
- Base infrastructure (if applicable for this feature)

### 2.2 Domain Layer Tasks (from data-model.md + spec.md + contracts/)

Generate tasks for:
- Entities and aggregate roots
- Value objects (branded IDs, scalars, enums)
- Domain services (pure business logic)
- Domain events
- Domain errors / error taxonomy
- Invariant enforcement

### 2.3 Application Layer Tasks (from spec.md + contracts/)

Generate tasks for:
- Use cases / orchestration logic
- Port interfaces (abstractions)
- DTOs and mapping
- Application-level strategies

### 2.4 Adapters Layer Tasks (from contracts/ + plan.md)

Generate tasks for:
- Port implementations (storage, LLM, tool adapters)
- In-memory fakes for testing

### 2.5 Infrastructure Layer Tasks (from plan.md)

Generate tasks for:
- Concrete infrastructure (PostgreSQL, crypto, config)
- Migrations (if applicable)
- Wiring / composition root

### 2.6 SDK Tasks (from contracts/ + plan.md)

Generate tasks for:
- Public API surface
- Framework integration points

### 2.7 Test Tasks (from quickstart.md + checklists/ + spec.md)

Generate tasks for:
- Unit tests for invariants and domain logic
- Deterministic / golden tests
- Acceptance scenario verification from quickstart.md
- Quality gate verification from checklists/

### 2.8 Polish Tasks (from checklists/)

Generate tasks for:
- Documentation updates
- Final validation against success criteria

### 2.9 Print Derived Structure

```text
📋 DERIVED TASK STRUCTURE
════════════════════════════════
Foundation:   [X] tasks
Domain:       [Y] tasks
Application:  [Z] tasks
Adapters:     [W] tasks
Infrastructure: [V] tasks
SDK:          [U] tasks
Tests:        [T] tasks
Polish:       [S] tasks
────────────────────────────────
Total: [N] tasks to create
════════════════════════════════
```

**NOTE**: Not all layers are relevant for every feature. Only create epics/tasks for layers that the spec/plan actually touches. For example, a domain-only feature (like `001-domain-value-objects`) would skip Application, Adapters, Infrastructure, and SDK.

---

## Phase 3 — Build Issue Body Files (MANDATORY)

### 3.1 Build the Artifacts Appendix

For EVERY issue, create a temporary markdown file containing the issue-specific content AND all speckit artifacts verbatim.

**Body file template** (write to `/tmp/bd-issue-XXXX.md`):

```markdown
## Summary
[Short summary specific to THIS issue]

## Implementation Notes
- Target package(s): [packages/domain, packages/application, etc. as applicable]
- Files to create/modify: [specific file paths]

## Acceptance Criteria
[Focused acceptance criteria for THIS specific task, derived from spec.md scenarios]

## Verification
```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

---

# Speckit Artifacts (Full Reference)

## spec.md
[PASTE FULL VERBATIM CONTENTS OF $FEATURE_DIR/spec.md]

## plan.md
[PASTE FULL VERBATIM CONTENTS OF $FEATURE_DIR/plan.md]

## data-model.md
[PASTE FULL VERBATIM CONTENTS IF FILE EXISTS, otherwise omit section]

## research.md
[PASTE FULL VERBATIM CONTENTS IF FILE EXISTS, otherwise omit section]

## quickstart.md
[PASTE FULL VERBATIM CONTENTS IF FILE EXISTS, otherwise omit section]

## contracts/[filename]
[PASTE FULL VERBATIM CONTENTS OF EACH FILE IN contracts/, with filename as heading]

## checklists/[filename]
[PASTE FULL VERBATIM CONTENTS OF EACH FILE IN checklists/, with filename as heading]
```

Save the path to the generated body file as `$BODY_FILE`.

---

## Phase 4 — Create Beads Issues

### 4.1 Create Feature Epic

```bash
bd create "Epic: [Feature Name]" \
  --type epic \
  --priority 1 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID" \
  --body-file "$BODY_FILE" \
  --json
```

Save the returned ID as `$FEATURE_EPIC_ID`.

### 4.2 Create Phase/Layer Epics (as children of Feature Epic)

Use `--parent` to create hierarchical child issues:

**Foundation Epic** (if needed):

```bash
bd create "Foundation: Setup + Scaffolding" \
  --type epic \
  --priority 0 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID,phase:foundation" \
  --parent "$FEATURE_EPIC_ID" \
  --body-file "$BODY_FILE" \
  --json
```

**Domain Epic** (if needed):

```bash
bd create "Domain: Entities, VOs, Services, Events, Errors" \
  --type epic \
  --priority 1 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID,layer:domain" \
  --parent "$FEATURE_EPIC_ID" \
  --body-file "$BODY_FILE" \
  --json
```

Repeat for other layer epics as needed: Application, Adapters, Infrastructure, SDK, Tests, Polish.

Save each returned ID (e.g., `$FOUNDATION_EPIC_ID`, `$DOMAIN_EPIC_ID`, `$TESTS_EPIC_ID`, etc.).

### 4.3 Create Tasks (as children of the appropriate epic)

Use `--parent` (NOT `--deps`) to attach tasks to their epic and get hierarchical IDs.

**Domain task example:**

```bash
bd create "Implement [Entity/ValueObject] with invariants" \
  --type task \
  --priority 2 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID,layer:domain" \
  --parent "$DOMAIN_EPIC_ID" \
  --design "Brief design notes derived from plan.md/research.md" \
  --acceptance "Focused acceptance criteria for this task" \
  --notes "Target: packages/domain/src/entities/[name].ts" \
  --body-file "$BODY_FILE" \
  --json
```

**Application task example:**

```bash
bd create "Add use case: [UseCaseName]" \
  --type task \
  --priority 2 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID,layer:application" \
  --parent "$APPLICATION_EPIC_ID" \
  --design "Ports, DTOs, orchestration details from contracts/" \
  --acceptance "What tests/scenarios must pass" \
  --notes "Target: packages/application/src/use-cases/[name].ts" \
  --body-file "$BODY_FILE" \
  --json
```

**Adapter/Infrastructure task example:**

```bash
bd create "Implement [PortName] adapter: [AdapterName]" \
  --type task \
  --priority 3 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID,layer:adapters" \
  --parent "$ADAPTERS_EPIC_ID" \
  --design "Port interface from contracts/, implementation approach from plan.md" \
  --acceptance "Adapter passes conformance tests" \
  --notes "Target: packages/adapters/src/[name].ts" \
  --body-file "$BODY_FILE" \
  --json
```

**Test task example:**

```bash
bd create "Add invariant + deterministic tests for [Component]" \
  --type task \
  --priority 2 \
  --spec-id "$SPEC_ID" \
  --labels "speckit,feature:$SPEC_ID,phase:tests" \
  --parent "$TESTS_EPIC_ID" \
  --acceptance "SC-002/SC-003 criteria from spec.md verified" \
  --notes "Validation: pnpm test" \
  --body-file "$BODY_FILE" \
  --json
```

### 4.4 Parent Assignment Rules

- Foundation tasks → `$FOUNDATION_EPIC_ID`
- Domain tasks → `$DOMAIN_EPIC_ID`
- Application tasks → `$APPLICATION_EPIC_ID`
- Adapter tasks → `$ADAPTERS_EPIC_ID`
- Infrastructure tasks → `$INFRASTRUCTURE_EPIC_ID`
- SDK tasks → `$SDK_EPIC_ID`
- Test tasks → `$TESTS_EPIC_ID`
- Polish tasks → `$POLISH_EPIC_ID`

---

## Phase 5 — Wire Dependencies (MINIMAL: epic-to-epic only)

### 5.1 Phase Gating

Use `bd dep add <blocked-issue> <blocker-issue>` to set dependency edges.

Typical gating (adapt to what epics exist):

```bash
# Domain epic depends on Foundation (if Foundation epic exists)
bd dep add "$DOMAIN_EPIC_ID" "$FOUNDATION_EPIC_ID" --type blocks --json

# Application depends on Domain
bd dep add "$APPLICATION_EPIC_ID" "$DOMAIN_EPIC_ID" --type blocks --json

# Adapters depends on Application
bd dep add "$ADAPTERS_EPIC_ID" "$APPLICATION_EPIC_ID" --type blocks --json

# Tests depends on Domain (at minimum)
bd dep add "$TESTS_EPIC_ID" "$DOMAIN_EPIC_ID" --type blocks --json
```

### 5.2 Skip Task-Level Dependencies

**DO NOT** create task-to-task dependencies. Let the developer determine execution order within each epic.

### 5.3 Verify No Cycles

```bash
bd dep cycles --json
```

---

## Phase 6 — Verification (MANDATORY)

### 6.1 Structural Check

```bash
bd list --json | head -50
```

Verify:
- [ ] Feature Epic exists
- [ ] Layer Epics exist for each relevant layer
- [ ] Tasks cover all entities from data-model.md
- [ ] Tasks cover all contracts from contracts/
- [ ] Tasks cover acceptance scenarios from spec.md

### 6.2 Ready Work Check

```bash
bd ready --json
```

Verify:
- [ ] Foundation/Domain tasks are ready (no blockers)
- [ ] Downstream layer tasks are blocked until their dependencies complete

### 6.3 Print Summary

```text
✅ SPECKIT → BEADS IMPORT COMPLETE
════════════════════════════════════════

📁 Source: $FEATURE_DIR
📎 Spec ID: $SPEC_ID

📊 Created:
   1 Feature Epic
   [N] Layer/Phase Epics
   [T] Task Issues

🔗 Dependencies:
   Phase gating: [X] edges
   No task-level deps (by design)
   No cycles detected

📋 Coverage:
   User Stories: [X]/[X] covered
   Entities: [Y]/[Y] covered
   Contracts: [Z]/[Z] covered

📄 Artifacts Embedded:
   All speckit docs included in every issue body

🚀 Ready to Start:
   [List first 3 ready tasks]

════════════════════════════════════════
Next: bd ready
```

### 6.4 Clean Up

Remove temporary body files:
```bash
rm -f /tmp/bd-issue-*.md
```

---

## `--update` Mode (Re-import)

When `--update` flag is provided:

1. Search for existing issues by spec ID:
   ```bash
   bd list --spec "$SPEC_ID" --json
   ```

2. Compare derived tasks with existing issues:
   - If issue exists for a task → update body (re-embed updated artifacts) via `bd update <id> --body-file "$BODY_FILE"`
   - If no match → create new issue

3. Do NOT delete issues (they may have work in progress)

4. Print update summary:
   ```text
   📝 UPDATE SUMMARY
   ════════════════════════════════
   Updated: [X] issues (re-embedded artifacts)
   Created: [Y] new issues
   Skipped: [Z] unchanged
   ════════════════════════════════
   ```

---

## `--dry-run` Mode

When `--dry-run` is provided:
- Execute Phase 0–2 (loading and deriving)
- Add `--dry-run` flag to all `bd create` commands (Beads will preview without persisting)
- Do NOT execute any `bd dep add` commands
- Do NOT run `bd dolt push`

Print:
```text
🧪 DRY RUN — No changes persisted

Would create:
- Epic: [Feature Name]
- Foundation Epic ([X] tasks)
- Domain Epic ([Y] tasks)
- Application Epic ([Z] tasks)
- Tests Epic ([W] tasks)
- Polish Epic ([V] tasks)

Total: [T] issues

Would add dependencies:
- Foundation blocks Domain
- Domain blocks Application
- [etc.]

All issue bodies would include full speckit artifacts
```

---

## Error Handling

### Missing Required Files
Stop and instruct to run `/speckit.specify` and `/speckit.plan` first.

### Beads CLI Not Found
Stop and provide installation link: https://github.com/steveyegge/beads

### No Database
Stop and instruct to run `bd init`.

### Empty Spec Sections
If spec.md has no user stories or requirements:
```bash
bd create "Clarify: spec.md missing user stories" \
  --type task \
  --priority 1 \
  --spec-id "$SPEC_ID" \
  --json
```

### No Entities/Contracts
If data-model.md and contracts/ are both missing, generate only story-level tasks from spec.md acceptance scenarios.

---

## Quick Reference

```bash
# Create issues from a spec
/speckit.beads specs/001-my-feature/

# Dry run first
/speckit.beads specs/001-my-feature/ --dry-run

# Re-import after spec changes
/speckit.beads specs/001-my-feature/ --update

# After import
bd ready           # See actionable work
bd show <id>       # View issue details
bd update <id> --status in_progress

# Implement a task
/implement-beads <id>

# Close when done
bd close <id> --reason "Implemented and verified"
```

---

## Architecture Quick Reference (LedgerMind)

```
packages/
├── domain/           # entities, value objects, domain services, events, errors (zero deps)
├── application/      # use cases, port interfaces, DTOs, strategies (depends on domain)
├── adapters/         # port implementations: storage, LLM, tool, explorer (depends on application + domain)
├── infrastructure/   # concrete infra: pg, crypto, config, migrations (depends on adapters + application + domain)
└── sdk/              # public API: createMemoryEngine() (depends on all)

tests/                # cross-package: golden, property, conformance, regression

Dependency Rule: All source code dependencies point INWARD.
Forbidden in domain/application: SQL, pg, crypto, fs, zod, framework SDKs.

Verification Gates
──────────────────
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```
