# Quickstart: Port Interface Contracts

This quickstart describes how to implement and validate the Phase 1 application-layer port contract surface in `packages/application`.

## Prerequisites

- Node.js 22+
- pnpm 9.x
- repository bootstrap complete (`pnpm install`)
- `@ledgermind/domain` foundation available as the source type package for shared entities/value objects

## 1) Confirm starting state

```bash
pnpm --filter @ledgermind/application typecheck
pnpm --filter @ledgermind/application test
```

Expected: the application package currently contains only minimal scaffold and no meaningful port definitions yet.

## 2) Create the application port directory structure

Under `packages/application/src/`, add:

- `ports/driving/`
  - `memory-engine.port.ts`
  - `tool-provider.port.ts`
  - `event-subscriber.port.ts`
- `ports/driven/persistence/`
  - `ledger-append.port.ts`
  - `ledger-read.port.ts`
  - `context-projection.port.ts`
  - `summary-dag.port.ts`
  - `artifact-store.port.ts`
  - `conversation.port.ts`
  - `unit-of-work.port.ts`
- `ports/driven/llm/`
  - `summarizer.port.ts`
  - `tokenizer.port.ts`
- `ports/driven/explorer/`
  - `explorer.port.ts`
  - `explorer-registry.port.ts`
- `ports/driven/jobs/`
  - `job-queue.port.ts`
- `ports/driven/auth/`
  - `authorization.port.ts`
- `ports/driven/clock/`
  - `clock.port.ts`
- `ports/driven/crypto/`
  - `hash.port.ts`
- update `packages/application/src/index.ts` to export the public contract surface.

## 3) Encode clarified Phase 1 behavior into the contracts

Ensure the interface definitions reflect the agreed rules:

- no standalone `getNextSequence` operation,
- append contracts own sequence assignment semantics,
- context replacement requires `expectedVersion`,
- stale-version conflicts are explicit (no silent overwrite),
- retrieval/search remain conversation-scoped,
- only keyword/full-text and regex search are required in Phase 1,
- artifact metadata/content access remains open in Phase 1,
- binary payload contracts use `Uint8Array`,
- `HashPort` remains an abstract driven capability.

## 4) Validate contract organization against Clean Architecture

Review the created files and ensure:

- contracts live only in `packages/application/src/ports/**`,
- imports point inward only (`@ledgermind/domain` allowed; adapters/infrastructure/framework imports forbidden),
- each interface owns one cohesive responsibility,
- transaction boundary concerns remain in `UnitOfWorkPort` / `UnitOfWork` only.

## 5) Validate package and workspace quality gates

```bash
pnpm --filter @ledgermind/application lint
pnpm --filter @ledgermind/application typecheck
pnpm --filter @ledgermind/application test
pnpm lint
pnpm typecheck
pnpm test
```

Expected: static quality gates pass and application contract surface is exported cleanly.

## 6) Verify acceptance criteria mapping

- **SC-001**: All required driving and driven port families are represented in `packages/application/src/ports/**`.
- **SC-002**: Contract files document explicit behavior for ordering, version conflicts, authorization, and atomicity.
- **SC-003**: Core use cases can map their dependencies to existing port definitions without inventing new interfaces.
- **SC-004**: No contract-level dependency boundary violations are introduced.
- **SC-005**: Conformance test planning inputs can be derived directly from the contract files.

## 7) Common pitfalls to avoid

- Do not reintroduce a separate `getNextSequence` interface.
- Do not place framework-specific tool types, SQL details, or runtime bindings in `packages/application`.
- Do not merge persistence concerns into a single god interface.
- Do not require semantic/vector search in Phase 1 contracts.
- Do not use `Buffer` in core binary content/hash contracts; use `Uint8Array`.
- Do not make artifact content access authorization-dependent in this feature after the accepted clarification.
