# Task: Fix 7 Phase 1 Core Use Case Gaps in LedgerMind

You are working on the LedgerMind project — a clean architecture memory engine for LLM agents. Phase 1 "Core use cases" have been verified against the HLD (`docs/high-level-design.md`) and addendum (`docs/design-decisions-addendum.md`). 7 gaps were found. Implement all 7 fixes below.

**IMPORTANT:** Read each file mentioned before modifying. Follow existing code conventions (branded types, `Object.freeze`, domain constructors, port injection via deps). Run `npx turbo run test --filter=@ledgermind/application` and `npx turbo run test --filter=@ledgermind/domain` after changes to ensure all existing 41+ tests still pass. Add new tests for new behavior.

---

## Gap 1 (HIGH): Domain events never emitted

Domain events are defined in `packages/domain/src/events/domain-events.ts` (6 event types: `LedgerEventAppended`, `CompactionTriggered`, `SummaryNodeCreated`, `CompactionCompleted`, `ArtifactStored`, `ContextMaterialized`) but no use case emits them.

### Implementation plan

1. Create a new driven port `packages/application/src/ports/driven/events/event-publisher.port.ts`:

   ```typescript
   import type { DomainEvent } from '@ledgermind/domain';
   export interface EventPublisherPort {
     publish(event: DomainEvent): void;
   }
   ```

2. Add `readonly eventPublisher?: EventPublisherPort` to the deps interface of each use case that should emit events.

3. Emit events (fire-and-forget, never block the use case):
   - `AppendLedgerEventsUseCase`: emit `LedgerEventAppended` for each appended event (after UoW commit)
   - `MaterializeContextUseCase`: emit `ContextMaterialized` after successful materialization
   - `RunCompactionUseCase`: emit `SummaryNodeCreated` per round, `CompactionCompleted` at the end
   - `StoreArtifactUseCase`: emit `ArtifactStored` after successful store

4. Make `eventPublisher` optional so existing tests don't break. Use pattern: `this.deps.eventPublisher?.publish(event)`.

5. Export the new port from `packages/application/src/index.ts`.

6. Add at least 1 test per use case verifying events are published when publisher is provided.

---

## Gap 2 (HIGH): MaterializeContext missing HLD §7.2 steps

File: `packages/application/src/use-cases/materialize-context.ts`

Three sub-gaps:

### 2a: Summary-ID header injection (§7.2 step 4)

When a context item is a summary, inject a header line into its content so the LLM knows the summary ID for tool calls. In `resolveContextItem`, when building the `modelMessage` for a summary, prepend:

```
[Summary ID: ${summaryNode.id}]\n
```

to the content string.

### 2b: systemPreamble population

Currently hardcoded to `''`. Build a system preamble that lists available summary and artifact references so the LLM can use `memory.grep`, `memory.expand`, `memory.describe`. Something like:

```
You have access to memory tools. Available summaries: [list IDs]. Available artifacts: [list IDs].
```

Populate this from the resolved context data. If no summaries/artifacts exist, keep it empty.

### 2c: pinRules and retrievalHints support

- `pinRules`: When resolving and ordering context items, ensure pinned items are always included even if context exceeds budget. Apply pin logic similar to `CompactionPolicyService.isPinned` — check position pins, message ID pins, and summary ID pins. Pinned items should be prioritized first in the output.
- `retrievalHints`: Use `summaryDag.searchSummaries()` to find relevant summaries and include them if budget allows. This can be a simple "append relevant summaries from hints if under budget" approach for Phase 1.

Add tests for header injection and pin rules at minimum.

---

## Gap 3 (HIGH): SDK `createMemoryEngine()` not wired

File: `packages/sdk/src/index.ts` (currently empty)

### Implementation plan

1. Read the existing packages to understand exports: `packages/domain/src/index.ts`, `packages/application/src/index.ts`, `packages/adapters/src/index.ts`, `packages/infrastructure/src/index.ts`.

2. Implement `createMemoryEngine(config)` factory function that:
   - Accepts a configuration object (storage type, connection details, summarizer config, etc.)
   - Instantiates the appropriate adapter implementations
   - Wires all 9 use cases into a `MemoryEngine` facade object
   - Returns the `MemoryEngine` interface from `packages/application/src/ports/driving/memory-engine.port.ts`

3. The factory should be the composition root — only place where concrete adapters are instantiated.

4. Re-export key types consumers need: `MemoryEngine`, `AppendLedgerEventsInput/Output`, `MaterializeContextInput/Output`, etc.

5. Check what adapters/infrastructure implementations exist before wiring. If some are stubs/not yet implemented, wire what exists and document what's missing with TODO comments.

---

## Gap 4 (MEDIUM): Describe missing `parentIds`

Files:

- `packages/application/src/use-cases/describe.ts`
- `packages/application/src/ports/driven/persistence/summary-dag.port.ts`

### Implementation plan

1. Add a new method to `SummaryDagPort`:

   ```typescript
   getParentSummaryIds(summaryId: SummaryNodeId): Promise<readonly SummaryNodeId[]>;
   ```

2. In `DescribeUseCase`, when the found entity is a summary, call `getParentSummaryIds` and include the result in the output's `parentIds` field.

3. Update existing in-memory test doubles (check `packages/application/src/use-cases/__tests__/retrieval-test-doubles.ts` or similar) to implement the new method.

4. Add a test verifying `parentIds` is populated correctly for condensed summaries.

---

## Gap 5 (MEDIUM): Inconsistent error types for missing conversation

Files:

- `packages/application/src/use-cases/append-ledger-events.ts` (line ~148-149)
- `packages/application/src/use-cases/materialize-context.ts` (line ~146-147)
- `packages/application/src/use-cases/run-compaction.ts` (line ~265-267)

### Fix

Replace `throw new InvariantViolationError('Conversation not found: ...')` with `throw new ConversationNotFoundError(input.conversationId)` in all three files. Import `ConversationNotFoundError` from `../errors/application-errors`. This matches the pattern already used in `check-integrity.ts` and `store-artifact.ts`.

---

## Gap 6 (MEDIUM): Append sequence assignment race condition

File: `packages/application/src/use-cases/append-ledger-events.ts`

### Problem

Line ~158: `const existingEvents = await this.deps.ledgerRead.getEvents(input.conversationId)` reads events via a non-transactional port, then computes `nextSequence = existingEvents.length + 1`. Under concurrent appends this can produce duplicate sequences.

### Fix

1. Add a method to `LedgerAppendPort` (`packages/application/src/ports/driven/persistence/ledger-append.port.ts`):

   ```typescript
   getNextSequence(conversationId: ConversationId): Promise<SequenceNumber>;
   ```

   This should be called within the UoW transaction to get the next sequence atomically.

2. In `AppendLedgerEventsUseCase`, replace the `existingEvents.length + 1` pattern:
   - Move `getNextSequence` call inside the UoW transaction via `uow.ledger.getNextSequence(conversationId)`
   - Use the returned sequence as the base for the batch

3. Keep the idempotency check using `this.deps.ledgerRead.getEvents()` outside or inside the UoW as needed, but sequence allocation must be transactional.

4. Update test doubles to implement `getNextSequence`.

---

## Gap 7 (LOW): StoreArtifact path source not content-addressed

File: `packages/application/src/use-cases/store-artifact.ts`

### Problem

Line ~70: For `kind: 'path'` sources, it hashes `"path:${source.path}"` instead of actual file content. This means the same file at different paths gets different IDs, and different content at the same path gets the same ID.

### Fix

This is an architectural decision — true content-addressing for path sources requires reading file bytes, which belongs in the adapter/infrastructure layer, not the use case.

1. Add a new driven port `packages/application/src/ports/driven/filesystem/file-reader.port.ts`:

   ```typescript
   export interface FileReaderPort {
     readBytes(path: string): Promise<Uint8Array>;
   }
   ```

2. Add `readonly fileReader?: FileReaderPort` to `StoreArtifactUseCaseDeps`.

3. In `prepareArtifactSource` for `kind: 'path'`:
   - If `fileReader` is available, read file bytes, compute `sha256(fileBytes)`, and use as `contentHashHex`. Store the bytes as content.
   - If `fileReader` is not available (backward compat), fall back to current `"path:${source.path}"` hashing with a logged warning.

4. Export port from application index. Add test for both paths (with/without fileReader).

---

## Verification checklist

After implementing all 7 gaps:

- [ ] `npx turbo run test` — all tests pass (existing + new)
- [ ] `npx turbo run build` — no type errors
- [ ] No new imports from outer layers into domain (dependency rule)
- [ ] All new ports exported from `packages/application/src/index.ts`
