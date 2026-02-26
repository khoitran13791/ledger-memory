# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and Amp when working with code in this repository.

## Repository status

LedgerMind is in **early implementation** — design documentation is complete, monorepo structure is scaffolded, implementation is starting from Step 0.

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
