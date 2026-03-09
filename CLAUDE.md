# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and Amp when working with code in this repository.

## Repository status

LedgerMind is in **early implementation** — design documentation is complete, monorepo structure is scaffolded, implementation is starting from Step 0.

## Engineering constitution

The repository constitution is defined at `.specify/memory/constitution.md`.
All planning and implementation work must satisfy its five non-negotiable principles:
code quality, testing standards, user experience consistency, performance requirements,
and simplicity/change safety.

## Design Documentation

- @docs/high-level-design.md — full architecture blueprint (~1800 lines): Clean Architecture layers, domain model, all use cases, all port interfaces, adapter specs, PostgreSQL schema, compaction algorithm, explorer plugins, token budget, error taxonomy, package structure, implementation roadmap
- @docs/design-decisions-addendum.md — resolves pre-implementation gaps: ID canonicalization, LedgerEvent schema, context versioning, 8 DAG integrity checks, compaction block definition, deterministic fallback, test stubs, tech stack
- @docs/testing-strategy.md — testing plan: golden tests, property-based (fast-check), conformance suites, LLM-as-judge, probe evaluation, regression catalog, CI/CD pipeline
- @docs/claude-code-integration.md — MCP server, hooks, Agent SDK, plugin integration
- @docs/lcm-framework-research.md — research, market analysis, Volt reference analysis
- @docs/LCM.pdf — underlying LCM paper

## Common commands

When implementation code is added, update this section:

- Build: `pnpm build` (via Turborepo)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Test (all): `pnpm test`
- Test (domain only): `pnpm test:domain`
- Test (single file): `pnpm vitest run path/to/test.ts`
- Format: `pnpm format`

## Code Search & Refactor Tools (ast-grep + ripgrep)

| Need | `rg` (ripgrep) | `sg` (ast-grep) |
|---|---|---|
| Find where a string/token appears | ✅ Best | ⚠️ Overkill |
| Search config, docs, logs, templates | ✅ Best | ❌ N/A |
| Avoid false positives from comments/strings | ⚠️ Hard | ✅ AST-aware |
| Match a code *shape* (e.g., `console.log($A)`) | ❌ | ✅ Best |
| Refactor with high confidence (`--rewrite`) | ❌ Unsafe | ✅ Purpose-built |

**Rule of thumb:** correctness/refactors → `sg`, raw speed/text hunting → `rg`. Combine: `rg` to shortlist files, `sg` to match/modify.

### Config files

- **`.ripgreprc`** — smart-case, line numbers, excludes `node_modules/`, `build/`, `.venv/`, lock files. Set `RIPGREP_CONFIG_PATH` to use.
- **`sgconfig.yml`** — `ruleDirs: [sg-rules]`
- **`sg-rules/`** — custom lint rules (e.g., `ts/no-console-log.yml`, `py/fastapi-get-routes.yml`)

### Common patterns

```bash
# AST-aware search
sg run -l ts -p 'console.log($$$A)' src/
sg run -l ts -p 'fetch($URL, $OPTS)' src/lib/apis/

# Safe rewrite
sg run -l ts -p 'console.log($A)' -r 'logger.debug($A)' src/

# Text search
rg -tts "TODO" src/
rg -tpy "get_current_user" backend/

# Combine: shortlist with rg, then structurally match with sg
rg -l -tts 'console\.log' src/ | xargs sg run -l ts -p 'console.log($$$A)' --json
```

### Workflow

1. **Discover** — `rg` to find candidates
2. **Match** — `sg` to precisely match AST patterns (no false positives)
3. **Refactor** — `sg --rewrite` for safe structural changes
4. **Verify** — `rg` to confirm no leftovers

## Architecture: Clean Architecture (strict dependency rule)

All source code dependencies point INWARD. Inner layers define abstractions; outer layers implement them.

```
packages/domain/          → zero deps (entities, value objects, services, events, errors)
packages/application/     → depends on domain (use cases, port interfaces, DTOs, strategies)
packages/adapters/        → depends on application + domain (storage, LLM, tool, explorer adapters)
packages/infrastructure/  → depends on adapters + application + domain (SQL, crypto, config)
packages/sdk/             → depends on all (public API: createMemoryEngine())
apps/mcp-server/          → Phase 2+ (standalone MCP server)
tests/                    → cross-package golden/property/conformance/regression tests
```

**Forbidden imports**: No SQL/pg/crypto/fs/zod/framework SDKs in domain or application layers. See @.claude/skills/clean-architecture-guardrails/SKILL.md for full rules.

## Tech Stack

pnpm 9.x workspaces, Turborepo, Node.js 22 LTS, TypeScript 5.x strict, Vitest 3.x, tsup, pg (node-postgres), node-pg-migrate, ESLint + eslint-plugin-boundaries, Prettier

## Key Design Decisions

- **Content-addressed IDs**: SHA-256 of sorted-key JSON (content fields only, no timestamps). See @.claude/skills/ids-and-hashing/SKILL.md
- **Compaction**: 3-level escalation (normal → aggressive → deterministic fallback ≤512 tokens). See @.claude/skills/compaction-rules/SKILL.md
- **DAG Integrity**: 8 checks enumerated. See @.claude/skills/dag-integrity/SKILL.md
- **Context concurrency**: Optimistic locking via `context_versions.version`
- **Ports**: Segregated by ISP — no God interfaces. See @.claude/skills/ports-and-adapters/SKILL.md

## Implementation Order

Step 0: Monorepo scaffold → Step 1: Domain types + ports → Step 2: In-memory adapters + stubs → Step 3: Core use cases → Step 4: PostgreSQL schema + adapters → Step 5: Explorers + registry → Step 6: SDK + Vercel adapter → Step 7: Golden tests + integrity suite

## Sub-Agents (`.claude/agents/`)

| Agent                         | Use For                                               |
| ----------------------------- | ----------------------------------------------------- |
| `clean-architecture-guardian` | Enforcing layer boundaries and forbidden imports      |
| `domain-modeler`              | Implementing domain entities, value objects, services |
| `compaction-engine`           | Compaction algorithms, DAG operations, escalation     |
| `persistence-engineer`        | In-memory fakes and PostgreSQL adapters               |
| `test-engineer`               | Golden tests, conformance, property tests, regression |
| `explorer-engineer`           | File type explorer plugins and registry               |
| `sdk-engineer`                | Public SDK surface and framework tool adapters        |

## Skills (`.claude/skills/`)

| Skill                           | Purpose |
| ------------------------------- | ------- |
| `clean-architecture-guardrails` | LedgerMind dependency rule enforcement; checks layer boundaries and forbidden imports |
| `compaction-rules`              | Compaction loop algorithm, L1/L2/L3 escalation, candidate selection, pin rules, deterministic fallback |
| `dag-integrity`                 | 8 DAG integrity checks, error types, and `IntegrityReport` structure |
| `explorer-template`             | Template and conventions for implementing new `ExplorerPort` plugins and registry registration |
| `golden-tests`                  | Golden fixture format and deterministic stubs (`SimpleTokenizer` + `DeterministicSummarizer`) |
| `ids-and-hashing`               | Content-addressed ID canonicalization rules and SHA-256 hashing semantics |
| `monorepo-scaffold`             | Monorepo setup with pnpm/Turborepo, TypeScript references, and lint/test/build conventions |
| `pg-schema`                     | PostgreSQL schema, constraints/indexes, migration conventions, and transaction safety rules |
| `ports-and-adapters`            | Port interface definitions, UnitOfWork pattern, and adapter implementation guidelines |

## Active Technologies
- TypeScript 5.x (strict), Node.js 22 LTS targe + Domain runtime dependencies: none. Toolchain: TypeScript project references, Vitest 3.x, ESLint, pnpm/Turborepo (001-domain-value-objects)
- N/A for domain package (no persistence implementation in this feature) (001-domain-value-objects)
- TypeScript 5.x (strict), Node.js 22 LTS targe + `@ledgermind/domain` (workspace dependency), TypeScript project references, ESLint + boundaries, Vitest, pnpm/Turborepo (001-port-interfaces)
- N/A for this feature (contract definition only; no adapter implementation) (001-port-interfaces)
- TypeScript 5.x (strict), Node.js >=22.0.0 + `@ledgermind/domain`, `@ledgermind/application` contracts, Vitest 3.x, ESLint + `eslint-plugin-boundaries`, TypeScript project references, Turborepo, `pg` + SQL migrations for PostgreSQL adapter (001-core-use-cases)
- In-memory + PostgreSQL (Phase 1 validation scope only; SQLite out of scope) (001-core-use-cases)
- TypeScript 5.x (strict), Node.js >=22.0.0 + `@ledgermind/domain`, `@ledgermind/application`, `pg`, `node-pg-migrate`, Vitest 3.x, ESLint + `eslint-plugin-boundaries`, pnpm/Turborepo (001-postgres-adapter)
- PostgreSQL (Phase 1 persistence backend in scope) (001-postgres-adapter)
- TypeScript 5.x (strict), Node.js >=22.0.0 + `@ledgermind/application`, `@ledgermind/domain`, `@ledgermind/adapters`, Vitest 3.x, ESLint + `eslint-plugin-boundaries`, Turborepo, tiktoken package for model-aligned counting (001-basic-tokenizer)
- N/A for tokenizer implementation (consumed by existing in-memory/PostgreSQL flows) (001-basic-tokenizer)
- Existing artifact persistence (`ArtifactStorePort`) over in-memory and PostgreSQL adapters; no new storage backend (001-core-explorers)
- TypeScript 5.x (strict), Node.js >=22.0.0 + `@ledgermind/domain`, `@ledgermind/application`, `@ledgermind/adapters`, `@ledgermind/infrastructure`, Vitest 3.x, ESLint + `eslint-plugin-boundaries`, Turborepo, Vercel AI SDK package (`ai`) for adapter binding (adapter layer only) (001-sdk-vercel-adapter)
- Existing in-memory and PostgreSQL engine creation paths (no new storage backend) (001-sdk-vercel-adapter)

## Recent Changes
- 001-domain-value-objects: Added TypeScript 5.x (strict), Node.js 22 LTS targe + Domain runtime dependencies: none. Toolchain: TypeScript project references, Vitest 3.x, ESLint, pnpm/Turborepo
