# Research: SDK Entrypoint and Vercel Memory Adapter

## Decision 1: Keep one public SDK factory with generic create plus named presets

- **Decision**: Preserve `createMemoryEngine(config)` as the generic entrypoint and add named presets for common setups (in-memory and PostgreSQL) as small wrappers over the same composition root.
- **Rationale**:
  - `packages/sdk/src/index.ts` already provides a working generic composition root.
  - Spec clarification requires “one generic create function plus named presets” (FR-001, clarification session).
  - Wrapping the existing factory avoids duplicate wiring logic and keeps behavior consistent across generic and preset paths.
- **Alternatives considered**:
  - Separate independent constructors per backend.
    - Rejected because it duplicates composition logic and increases drift risk.

## Decision 2: Keep storage scope at in-memory + PostgreSQL only for this feature

- **Decision**: SDK presets in this feature should cover only the currently supported Phase 1 storage backends: in-memory and PostgreSQL.
- **Rationale**:
  - Spec clarification explicitly requires support for both PostgreSQL and in-memory engine creation.
  - Existing `MemoryEngineConfig` already supports these exact two storage options.
  - Expanding to additional backends is out of feature scope.
- **Alternatives considered**:
  - Add SQLite or other presets now.
    - Rejected as scope expansion without requirement support.

## Decision 3: Implement Vercel adapter as a framework adapter in `packages/adapters`

- **Decision**: Add a Vercel AI SDK tool adapter under `packages/adapters/src/tools/vercel-ai-tools.adapter.ts` implementing `ToolProviderPort` and exporting a helper such as `createVercelMemoryTools(engine, options?)`.
- **Rationale**:
  - `ToolProviderPort` is the existing application boundary for framework tool definitions.
  - Clean Architecture allows framework-specific dependencies in adapters, not application/domain.
  - This aligns with design docs and keeps SDK package focused on composition/public entrypoint.
- **Alternatives considered**:
  - Implement Vercel adapter in SDK package.
    - Rejected because framework coupling belongs in adapter boundary.

## Decision 4: Expose memory search/describe/expand as first-class Vercel tools

- **Decision**: The initial Vercel tool bundle must include callable tools for `grep`, `describe`, and `expand`, with `expand` treated as restricted at runtime.
- **Rationale**:
  - FR-006 requires runtime execution of memory search, memory metadata lookup, and controlled context expansion.
  - These operations are already stable on `MemoryEngine` and backed by tested use-cases.
  - Using them directly minimizes translation complexity.
- **Alternatives considered**:
  - Expose only grep/describe and defer expand.
    - Rejected because restricted expansion is in-scope and explicitly required.

## Decision 5: Enforce restricted expand authorization using existing caller context policy

- **Decision**: Require adapter-level context input for tool execution and map restricted operations to `callerContext` with `isSubAgent` enforcement passed to `engine.expand`.
- **Rationale**:
  - `ExpandUseCase` already enforces authorization via `AuthorizationPort.canExpand` and throws `UnauthorizedExpandError` when denied.
  - `SubAgentAuthorizationAdapter` already defines Phase 1 policy (`caller.isSubAgent`).
  - Reusing existing application authorization behavior prevents inconsistent policy forks.
- **Alternatives considered**:
  - Implement separate adapter-only authorization logic.
    - Rejected because it duplicates and risks diverging from core authorization semantics.

## Decision 6: Standardize one structured adapter error envelope across all tool failures

- **Decision**: All Vercel adapter tool failures must map to one consistent envelope shape (e.g., `{ ok: false, error: { code, message, details? } }`) and never crash the runtime.
- **Rationale**:
  - FR-009 requires one consistent structured error envelope.
  - Existing typed `ApplicationError` codes provide stable mapping sources (`INVALID_REFERENCE`, `UNAUTHORIZED_EXPAND`, `ARTIFACT_NOT_FOUND`, etc.).
  - A single envelope is simpler for runtime handling and contract tests.
- **Alternatives considered**:
  - Per-tool custom error shapes.
    - Rejected due to inconsistent downstream integration behavior.

## Decision 7: Standardize one structured success envelope with follow-up references

- **Decision**: All Vercel tools must return a common success envelope shape (e.g., `{ ok: true, data, references }`) where references include IDs needed for subsequent describe/expand calls.
- **Rationale**:
  - FR-008 requires preserving relevant memory references for follow-up retrieval and inspection.
  - A unified envelope simplifies tool-consumer logic and contract verification.
- **Alternatives considered**:
  - Return raw per-use-case payloads directly.
    - Rejected because it weakens cross-tool consistency and follow-up affordance guarantees.

## Decision 8: Keep adapter outputs deterministic and non-throwing at tool boundary

- **Decision**: Tool execute handlers should catch internal errors, map them into structured envelopes, and return controlled outputs in both success and failure paths.
- **Rationale**:
  - Acceptance scenarios require controlled non-crashing behavior for unauthorized and error paths.
  - Existing use-cases may throw typed errors by design; adapter boundary must normalize these for framework runtime contracts.
- **Alternatives considered**:
  - Let tool execute throw and rely on framework defaults.
    - Rejected because envelope consistency and non-crashing behavior are explicit requirements.

## Decision 9: Place contract and negative-path test coverage as first-class acceptance gates

- **Decision**: Add adapter-focused tests that validate:
  1. tool registration contract,
  2. success envelope shapes,
  3. restricted expand denial envelope,
  4. invalid reference envelope mapping,
  5. generic unexpected failure envelope mapping.
- **Rationale**:
  - FR-011 and FR-012 require automated validation including 100% defined negative-path scenarios.
  - Existing use-case tests already cover many core failure semantics; adapter tests must verify boundary mapping/contract stability.
- **Alternatives considered**:
  - Rely only on use-case tests.
    - Rejected because adapter-specific contract mapping would remain unverified.

## Decision 10: Keep public type surface framework-safe and avoid leaking framework types inward

- **Decision**: Vercel-specific types remain in adapter implementation boundary; application/domain contracts stay framework-agnostic.
- **Rationale**:
  - Matches clean-architecture guardrails and FR-010 contract stability goals.
  - Prevents framework coupling from propagating into core engine types.
- **Alternatives considered**:
  - Extend `MemoryEngine`/application port signatures with framework-specific objects.
    - Rejected because it violates dependency inversion and feature scope.
