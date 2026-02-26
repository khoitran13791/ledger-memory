---
name: clean-architecture-guardrails
description: LedgerMind dependency rule enforcement. Checks imports against layer boundaries and forbidden dependency rules. Use when creating files, adding imports, or reviewing changes.
---

# Clean Architecture Guardrails

## Dependency Rule

All dependencies point INWARD. Never import from an outer layer.

```
domain ← application ← adapters ← infrastructure ← sdk
(inner)                                          (outer)
```

## Quick Reference: What Each Layer Can Import

| Layer | Can import from | CANNOT import from |
|-------|----------------|-------------------|
| `packages/domain/` | Nothing (zero deps) | Everything else |
| `packages/application/` | `domain` | `adapters`, `infrastructure`, `sdk` |
| `packages/adapters/` | `application`, `domain` | `infrastructure`, `sdk` |
| `packages/infrastructure/` | `adapters`, `application`, `domain` | `sdk` |
| `packages/sdk/` | All packages | — |

## Forbidden Imports by Layer

### domain/ — ZERO external deps
❌ `import ... from 'crypto'`
❌ `import ... from 'fs'`
❌ `import ... from 'path'`
❌ `import ... from 'zod'`
❌ `import ... from 'pg'`
❌ `import ... from 'ai'` (Vercel)
❌ Any npm package

### application/ — domain only
❌ `import ... from 'pg'`
❌ `import ... from 'zod'`
❌ `import ... from 'crypto'`
❌ `import ... from 'ai'`
❌ `import ... from '@langchain/*'`
❌ `import ... from 'openai'`
❌ Any SQL strings

### adapters/ — application + domain
❌ Raw SQL strings (that's infrastructure)
❌ `import ... from 'pg'` (that's infrastructure)
❌ `import ... from 'node-pg-migrate'`
✅ `import ... from 'zod'` (validation at boundary)
✅ `import ... from 'ai'` (framework tool adapters)

## ESLint Boundary Rules

```jsonc
// eslint-plugin-boundaries configuration
{
  "rules": {
    "boundaries/element-types": ["error", {
      "default": "disallow",
      "rules": [
        { "from": "domain", "allow": [] },
        { "from": "application", "allow": ["domain"] },
        { "from": "adapters", "allow": ["application", "domain"] },
        { "from": "infrastructure", "allow": ["adapters", "application", "domain"] },
        { "from": "sdk", "allow": ["infrastructure", "adapters", "application", "domain"] }
      ]
    }]
  }
}
```

## Conventions

- Ports are defined in `packages/application/src/ports/`
- DTOs are defined in `packages/application/src/dto/`
- Zod schemas live at adapter boundaries ONLY
- No ambient singletons — all dependencies injected via constructors
- Domain uses branded types for type safety (not Zod runtime validation)
