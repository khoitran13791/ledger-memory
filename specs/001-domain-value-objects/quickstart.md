# Quickstart: Implement Domain Package Foundations

This quickstart describes how to implement and validate the Phase 1 domain foundation in `packages/domain`.

## Prerequisites

- Node.js 22+
- pnpm 9.x
- repository bootstrap complete (`pnpm install`)

## 1) Confirm starting state

```bash
pnpm --filter @ledgermind/domain typecheck
pnpm --filter @ledgermind/domain test
```

Expected: package currently compiles with minimal scaffold (`src/index.ts` only), tests may pass with no tests.

## 2) Create domain module structure

Under `packages/domain/src/`, add:

- `entities/`
  - `conversation.ts`
  - `ledger-event.ts`
  - `summary-node.ts`
  - `dag-edge.ts`
  - `context-item.ts`
  - `artifact.ts`
- `value-objects/`
  - IDs and branded scalar types
  - token/value types (`token-count`, `token-budget`, `compaction-thresholds`)
  - role/mime/timestamp/context-version objects
- `services/`
  - `token-budget.service.ts`
  - `compaction-policy.service.ts`
  - `id.service.ts`
- `events/`
  - `domain-events.ts`
- `errors/`
  - `domain-errors.ts`
- update `index.ts` to export the full public contract.

## 3) Implement invariant factories and pure domain logic

Implement constructor/factory-style creation paths that enforce:

- non-negative token counts,
- valid threshold ordering (`soft < hard`),
- path-storage artifact constraints,
- immutable domain entity/value behavior.

Implement deterministic ID generation with canonical JSON and fixed hash-field sets from addendum.

## 4) Add deterministic domain tests

Create tests under `packages/domain/src/**/__tests__/` covering:

- valid/invalid cases per invariant group,
- deterministic ID stability across repeated runs,
- ID changes when hashed fields change,
- ID stability when excluded fields change,
- token budget and compaction-policy service decisions.

## 5) Validate package and workspace quality gates

```bash
pnpm --filter @ledgermind/domain lint
pnpm --filter @ledgermind/domain typecheck
pnpm --filter @ledgermind/domain test
pnpm lint
pnpm typecheck
pnpm test
```

## 6) Verify acceptance criteria mapping

- **SC-001**: All required entities/value objects/services/events/errors are exported from `@ledgermind/domain`.
- **SC-002**: Each invariant group has at least one valid and one invalid test.
- **SC-003**: Deterministic identity tests pass for repeatability and hash-field sensitivity.
- **SC-004**: Domain package has zero runtime dependencies in `packages/domain/package.json`.
- **SC-005**: Domain events and errors are available as stable exported types/classes for downstream layers.

## 7) Common pitfalls to avoid

- Do not import Node `crypto`, `fs`, `path`, `pg`, `zod`, or framework SDKs in `packages/domain`.
- Do not move validation responsibilities to adapters for domain invariants.
- Do not include timestamps or excluded fields in canonical hashing payloads.
- Do not broaden implementation into application/adapters/infrastructure in this feature.
