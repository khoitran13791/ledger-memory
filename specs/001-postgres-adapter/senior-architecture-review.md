# Senior Architecture Review: PostgreSQL Adapter for Phase 1 Core Engine

## Scope & Critical Paths

- **Primary user journeys**:
  1. persist conversation + ledger events and recover on restart
  2. persist/retrieve context projection with optimistic concurrency
  3. persist/expand summary DAG and validate integrity
  4. persist/retrieve artifacts and exploration metadata
  5. execute multi-record writes atomically through `UnitOfWorkPort`
- **Latency-sensitive operations**:
  - `appendEvents`, `getCurrentContext`, `expandToMessages`, regex/full-text retrieval
- **Data sensitivity classification**:
  - conversation content and artifact payloads are sensitive application data; logs/metrics should avoid raw payload leakage

## Architecture Decision

### Components (SRP Analysis)

| Component | Responsibility | Non-Responsibilities |
|---|---|---|
| `LedgerAppendPort` / `LedgerReadPort` | define append/read/search persistence contracts | SQL execution details, connection lifecycle |
| `PgLedgerStore` | implement PostgreSQL append/read/search behavior | compaction orchestration, framework tool mapping |
| `ContextProjectionPort` | define projection versioning and stale-write semantics | transaction orchestration across stores |
| `PgContextProjection` | implement versioned projection persistence | summary generation policy |
| `SummaryDagPort` | define DAG persistence/expansion/integrity contract | storage transport concerns |
| `PgSummaryDag` | implement DAG SQL behavior + integrity report | conversation creation, job orchestration |
| `ArtifactStorePort` | define artifact metadata/content contract | filesystem exploration strategy |
| `PgArtifactStore` | persist artifact rows and payload shape rules | retrieval ranking/semantic scoring |
| `UnitOfWorkPort` | define atomic mutation boundary | domain-level business rules |
| `PgUnitOfWork` + `withPgTransaction` | compose tx-scoped stores and execute begin/commit/rollback | domain entity modeling |

### Clean Architecture Layers

- **Entities (`packages/domain`)**: IDs, value objects, entity invariants, typed domain errors
- **Use cases + ports (`packages/application`)**: persistence interfaces and orchestration boundaries
- **Adapters (`packages/adapters`)**: integration/wiring boundaries (outside current feature core)
- **Infrastructure (`packages/infrastructure`)**: PostgreSQL stores, SQL mappings, migrations, transaction/error mapping

### Dependency Rule Verification

- [x] Domain has zero infrastructure imports
- [x] Application persistence contracts are defined in application layer
- [x] PostgreSQL SQL/driver concerns stay in infrastructure
- [x] `UnitOfWorkPort` abstraction owned by application, implemented in infrastructure
- [ ] Outstanding implementation gap: bounded retry + retryability typing still need to be completed in infrastructure transaction/error path

## SOLID Evaluation

### SRP — **Pass (with implementation follow-up)**
- Port interfaces are segregated by persistence concern.
- PostgreSQL stores each own one persistence concern.
- Follow-up: transaction retry policy must remain in transaction orchestrator (not spread across stores).

### OCP — **Pass**
- Ports allow backend extension without modifying application use-case contracts.
- PostgreSQL behavior changes can be delivered by adapter implementation updates while keeping port signatures stable.

### LSP — **Conditional Pass**
- Current PG implementation broadly satisfies port contracts.
- Contract parity risk remains for idempotency semantics until append path writes and conflict behavior are fully aligned.

### ISP — **Pass**
- Persistence contracts are split into ledger/context/dag/artifact/conversation/unit-of-work.
- No god-interface growth observed in current design artifacts.

### DIP — **Pass**
- High-level policy remains in application ports/use cases.
- Low-level SQL mechanics implement those ports in infrastructure.

## Performance Plan

### Critical operation complexity

| Operation | Expected Input Size | Time Complexity | Space Complexity | Acceptable? |
|---|---:|---:|---:|---|
| `appendEvents` | burst appends per conversation | O(n) in events appended | O(1) per row + payload | Yes (with indexed uniqueness checks) |
| `getEvents` range read | up to 10k events | O(k) result rows | O(k) | Yes |
| `searchEvents` FTS | conversation-scoped | index-assisted query + O(k) output | O(k) | Yes (GIN required) |
| `regexSearchEvents` scoped | conversation + optional subtree | query + regex evaluation on candidates | O(k) | Conditional (needs scale validation) |
| `expandToMessages` | DAG subtree depth varies | recursive CTE + O(k) output | O(k) | Conditional (validate at scale) |
| `replaceContextItems` | context window-sized projection | O(n) normalize/upsert/delete | O(n) | Yes for Phase 1 scale |

### Performance budget alignment

| Metric | Target | Measurement Method |
|---|---|---|
| P95 append/context/expand | <= 1s | PostgreSQL adapter integration workload tests |
| Correctness under scale | up to 10k events, 100 concurrent conversations | conformance + regression runs with workload fixtures |
| Atomicity failures | 0 partial writes | rollback scenario tests |

### Database optimization checks

- required indexes present for conversation-scoped retrieval (`idx_ledger_events_conv_seq`, `idx_ledger_events_tsv`, etc.)
- constraint-backed invariants for sequence uniqueness, context shape, and artifact storage-kind shape
- recursive CTE paths used for ancestor/expansion and must be validated at SC-008 scale

## Security Controls

### Top threats and controls

| Threat | Attack Vector | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| SQL injection through search inputs | unparameterized SQL in regex/FTS paths | High | Low | parameterized queries in all stores |
| partial-write corruption | failure mid multi-record mutation | Critical | Medium | enforce `UnitOfWorkPort` + transaction rollback |
| stale-write data loss | concurrent context replacements | High | Medium | optimistic concurrency with `expectedVersion` + typed stale error |
| integrity drift in DAG edges | invalid/manual DB mutations or faulty write paths | High | Low-Medium | runtime `checkIntegrity` + regression coverage |
| payload mutation leaks | returning mutable binary references | Medium | Medium | defensive copy on binary content retrieval |

### Control placement
- input boundary controls: adapter SQL parameterization and persistence constraints
- concurrency control: context version checks in projection adapter
- integrity control: DAG integrity report in summary adapter
- reliability control: bounded retry at transaction boundary (required completion item)

## Maintainability

### Error handling
- typed SQLSTATE mapping exists for invariant and sequence errors
- required extension: explicit retryable classification + typed exhausted-retry outcome

### Observability
- feature planning should preserve structured outcome visibility for:
  - transaction retries/rollback occurrences
  - stale context conflicts
  - integrity check failures by family

### Test strategy alignment

| Layer | Test Focus |
|---|---|
| application ports/contracts | behavior expectations and typed failures |
| infrastructure postgres store tests | SQL mapping, constraints, retrieval ordering, concurrency |
| conformance/golden/regression (PostgreSQL scope) | end-to-end persistence correctness and acceptance criteria |

## Decisions (ADRs)

- **ADR-001**: Keep PostgreSQL persistence implementation in infrastructure with application-owned ports.
- **ADR-002**: Keep `UnitOfWorkPort` as single atomic mutation boundary.
- **ADR-003**: Preserve optimistic context concurrency via expected-version compare-and-swap.
- **ADR-004**: Add bounded transient retry policy at transaction boundary, not domain/application layers.
- **ADR-005**: Keep PostgreSQL-only conformance/golden/regression validation in this feature.

## Review Outcome

**Status: Conditional Pass**

Architecture is consistent with clean-architecture and SOLID goals. Remaining gate items are implementation deltas already identified in design artifacts:

1. idempotency-key behavior alignment in append path
2. bounded transient retry in transaction orchestration
3. retryability typing completion at PostgreSQL error boundary
