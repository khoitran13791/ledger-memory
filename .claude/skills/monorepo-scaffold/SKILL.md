---
name: monorepo-scaffold
description: LedgerMind monorepo setup — pnpm workspaces, Turborepo, TypeScript project references, ESLint with boundary rules, Vitest, tsup. Use when setting up or configuring the build system.
disable-model-invocation: true
---

# Monorepo Scaffold (Step 0)

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| pnpm | 9.x | Package manager with strict workspaces |
| Turborepo | latest | Task orchestration + caching |
| Node.js | 22 LTS | Runtime |
| TypeScript | 5.x strict | Language |
| Vitest | 3.x | Test framework |
| tsup | latest | Library bundling (ESM/CJS dual) |
| ESLint | latest | Linting + boundary rules |
| Prettier | latest | Formatting |
| pg | latest | PostgreSQL driver (infrastructure only) |
| node-pg-migrate | latest | Migrations (infrastructure only) |

## Directory Structure

```
ledger-memory/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml       # workspace definition
├── turbo.json                # task pipeline
├── tsconfig.base.json        # shared TS config
├── .eslintrc.cjs             # boundary rules
├── .prettierrc               # formatting config
├── vitest.workspace.ts       # vitest workspace config
├── packages/
│   ├── domain/               # zero deps
│   │   ├── package.json
│   │   ├── tsconfig.json     # references: none
│   │   ├── tsup.config.ts
│   │   └── src/
│   ├── application/          # depends: domain
│   │   ├── package.json
│   │   ├── tsconfig.json     # references: domain
│   │   └── src/
│   ├── adapters/             # depends: application, domain
│   │   ├── package.json
│   │   ├── tsconfig.json     # references: application, domain
│   │   └── src/
│   ├── infrastructure/       # depends: adapters, application, domain
│   │   ├── package.json
│   │   ├── tsconfig.json     # references: adapters, application, domain
│   │   └── src/
│   └── sdk/                  # depends: all
│       ├── package.json
│       ├── tsconfig.json     # references: all
│       └── src/
├── apps/
│   └── mcp-server/           # Phase 2+
├── tests/
│   ├── conformance/
│   ├── golden/fixtures/
│   ├── property/
│   ├── regression/
│   ├── probes/
│   └── quality/
└── docs/
```

## pnpm-workspace.yaml

```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "tests"
```

## turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] },
    "test:domain": {},
    "test:application": { "dependsOn": ["^build"] },
    "test:golden": { "dependsOn": ["^build"] },
    "test:property": { "dependsOn": ["^build"] },
    "test:conformance:memory": { "dependsOn": ["^build"] },
    "test:conformance:pg": { "dependsOn": ["^build"] }
  }
}
```

## TypeScript Config (tsconfig.base.json)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

## ESLint Boundary Rules

Use `eslint-plugin-boundaries` to enforce the dependency rule at lint time:
- domain → nothing
- application → domain only
- adapters → application + domain
- infrastructure → adapters + application + domain
- sdk → all

## Package Naming

All packages use `@ledgermind/` scope:
- `@ledgermind/domain`
- `@ledgermind/application`
- `@ledgermind/adapters`
- `@ledgermind/infrastructure`
- `@ledgermind/sdk`
