# Contract: Phase 1 Core Explorers

This contract defines required behavior for implementing the five Phase 1 explorer categories (TypeScript, Python, JSON, Markdown, Fallback) with deterministic resolver selection, standardized metadata, token-budget compliance, and structured failure handling.

## 1) Boundary Contracts (Unchanged)

### Explorer interface
```ts
interface ExplorerPort {
  readonly name: string;
  canHandle(mimeType: MimeType, path: string, hints?: ExplorerHints): number;
  explore(input: ExplorerInput): Promise<ExplorerOutput>;
}
```

### Registry interface
```ts
interface ExplorerRegistryPort {
  register(explorer: ExplorerPort): void;
  resolve(mimeType: MimeType, path: string, hints?: ExplorerHints): ExplorerPort;
}
```

### Output interface
```ts
interface ExplorerOutput {
  summary: string;
  metadata: Readonly<Record<string, unknown>>;
  tokenCount: TokenCount;
}
```

### Contract rules
- Interface signatures above must remain stable for this feature.
- Resolver must still return exactly one explorer for each request.
- Specialized behavior is implemented via explorer/registry internals, not port shape changes.

---

## 2) Resolver Scoring Contract

### Required scoring signals
Resolver selection MUST use weighted contributions from all of:
1. file extension
2. declared/detected MIME/content type
3. content sniffing

### Required weights
- extension contribution: **60**
- MIME/content-type contribution: **25**
- sniffing contribution: **15**
- total score: **0..100**

### Candidate eligibility
- Explorer candidate is eligible iff `totalScore > 0`.

### Deterministic tie-break
When candidates share equal total score, resolver MUST break ties in this order:
1. higher extension contribution
2. higher MIME/content-type contribution
3. higher sniffing contribution
4. earlier registration order

### Determinism requirement
- Same input (path, mime, content/hints) must always produce identical explorer selection.

---

## 3) Explorer Category Coverage Contract

### Required Phase 1 categories
The system MUST provide valid exploration behavior for:
1. TypeScript source
2. Python source
3. JSON
4. Markdown
5. Fallback (unsupported inputs)

### Category intent
- TypeScript/Python: navigational source structure (major declarations + dependency references)
- JSON: structural shape (hierarchy + container/value patterns)
- Markdown: document outline (heading hierarchy + section structure)
- Fallback: usable summary for unsupported readable inputs and structured failure guidance for unreadable/malformed classes

---

## 4) Metadata Contract (FR-009a / FR-009b)

### Minimum metadata for all outcomes
Every explorer output must include these keys in `metadata`:
- `artifactReference`
- `selectedExplorer`
- `inputClassification`
- `score`
- `confidence`
- `truncated`

### Structured failure metadata extension
When output represents known failure class, metadata must additionally include:
- `failureClassification`
- `failureReason`
- `actionableGuidance`

### Consistency rules
- Key names are canonical and consistent across all explorer families.
- Explorer-specific metadata may add fields but must not remove required base keys.

---

## 5) Input Classification Contract

### Canonical classes
`inputClassification` must be one of:
- `typescript-source`
- `python-source`
- `json-structured`
- `markdown-document`
- `unsupported-readable`
- `unsupported-unreadable`
- `malformed-structured`

### Failure class restriction
`failureClassification` must use coarse standardized values only:
- `unsupported-readable`
- `unsupported-unreadable`
- `malformed-structured`

No finer-grained class names are allowed in this phase.

---

## 6) Token Budget + Truncation Contract

### Required behavior
- If `maxTokens` is provided, returned `tokenCount.value` must be `<= maxTokens`.
- If reduction/truncation occurs, `metadata.truncated` must be `true`.
- If no reduction occurs, `metadata.truncated` must be `false`.

### Large artifact baseline
For very large artifacts, exploration must apply stratified sampling before summary generation:
- beginning segment
- middle segment
- end segment

Metadata must disclose that stratified sampling was applied.

---

## 7) Structured Failure vs Exception Contract

### Structured failure outcomes (known cases)
For known unreadable/malformed cases, explorer flows return normal `ExplorerOutput` with failure metadata, not operation-level exception.

### Operation-level exceptions (unexpected faults)
Unexpected internal failures (e.g., parser/runtime faults) must surface as typed operation errors through existing use-case error mapping path.

### Required application-layer behavior
- Resolver failures map to `ExplorerResolutionError`.
- Unexpected explorer execution faults map to `ArtifactExplorationFailedError`.
- Known unreadable/malformed cases should not trigger these exceptions.

---

## 8) Fallback Explorer Contract

### Required behavior
- Fallback explorer must remain resolvable for any unsupported input.
- For readable unsupported input, fallback returns non-empty usable summary.
- For known unreadable/malformed cases, fallback (or selected path) returns structured failure metadata.

### Determinism
- Fallback output shape and metadata keys are deterministic for identical inputs.

---

## 9) Registration and SDK Wiring Contract

### Required behavior
- Default registry wiring must include all five Phase 1 explorer families.
- Fallback remains registered to guarantee terminal handling path.
- Registration order is stable and participates in deterministic tie-break stage.

---

## 10) Test Conformance Contract

### Required test groups
1. **Resolver determinism tests**
   - weighted scoring across extension/MIME/sniffing
   - tie-break stability on equal-score candidates
   - repeated-run same input => same selected explorer

2. **Explorer family output tests**
   - TypeScript/Python/JSON/Markdown structural outputs
   - fallback readable unsupported outputs

3. **Metadata contract tests**
   - required base metadata keys always present
   - structured failure metadata keys present when applicable

4. **Failure handling tests**
   - known unreadable/malformed => structured failure payload
   - unexpected internal faults => typed operation-level exception path

5. **Token budget + sampling tests**
   - output always within `maxTokens`
   - truncation disclosure correctness
   - stratified sampling disclosure for large artifacts

### Acceptance expectations
- 100% deterministic selection for repeated identical inputs.
- 100% token-limit compliance where `maxTokens` is specified.
- Non-empty result payloads for all five Phase 1 categories.

---

## 11) Out-of-Scope Guardrails

This contract excludes:
- new public port method signatures,
- persistence schema changes,
- non-Phase 1 explorer categories,
- framework-specific integration expansion beyond existing SDK composition path.
