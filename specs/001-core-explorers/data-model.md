# Data Model: Phase 1 Core Explorers

This feature extends artifact exploration behavior for five Phase 1 categories while preserving existing `ExplorerPort` and `ExplorerRegistryPort` contracts.

## 1) Explorer Candidate Signal Model

### Description
Represents per-explorer suitability evidence for one exploration request before final resolver selection.

### Fields
- `explorerName: string`
- `extensionScore: number` (0..60)
- `mimeScore: number` (0..25)
- `sniffingScore: number` (0..15)
- `totalScore: number` (0..100)
- `registrationIndex: number` (stable insertion order)

### Validation Rules
- Scores are integers and non-negative.
- `totalScore = extensionScore + mimeScore + sniffingScore`.
- Candidate is eligible only when `totalScore > 0`.

### Behavioral Rules
- Resolver ranks candidates deterministically by score/tie-break sequence.
- Candidate computation uses only request-derived signals + static explorer capability logic.

---

## 2) Explorer Resolution Decision Model

### Description
Deterministic single-selection result produced by registry resolution.

### Fields
- `selectedExplorer: string`
- `selectedScore: number`
- `selectedConfidence: number` (normalized 0..1 from score)
- `selectedClassification: InputClassification`
- `decisionTrace: {
    extensionScore: number;
    mimeScore: number;
    sniffingScore: number;
    tieBreakStage: string;
  }`

### Validation Rules
- Exactly one explorer is selected for each request.
- Confidence value is bounded to `[0, 1]`.

### Behavioral Rules
- Tie-break order:
  1. highest `totalScore`
  2. highest `extensionScore`
  3. highest `mimeScore`
  4. highest `sniffingScore`
  5. earliest `registrationIndex`

---

## 3) Input Classification Model

### Description
Canonical classification assigned before/with exploration for metadata and failure mapping.

### Enum
- `typescript-source`
- `python-source`
- `json-structured`
- `markdown-document`
- `unsupported-readable`
- `unsupported-unreadable`
- `malformed-structured`

### Validation Rules
- Exactly one classification is emitted per exploration result.
- Failure classifications must use coarse standardized classes only.

### Behavioral Rules
- Classification drives explorer-specific summary shape expectations.
- Failure classes are used for structured failure payloads and operator guidance.

---

## 4) Exploration Outcome Model

### Description
Unified result payload contract returned from exploration flows (success and structured failure outcomes).

### Base Fields (all outcomes)
- `summary: string`
- `metadata: Record<string, unknown>`
- `tokenCount: TokenCount`
- `explorerUsed: string`

### Minimum Metadata Contract (required for all outcomes)
- `artifactReference: { id: string; path: string; mimeType: string }`
- `selectedExplorer: string`
- `inputClassification: InputClassification`
- `score: number`
- `confidence: number`
- `truncated: boolean`

### Structured Failure Metadata Extension
- `failureClassification: 'unsupported-readable' | 'unsupported-unreadable' | 'malformed-structured'`
- `failureReason: string`
- `actionableGuidance: string[]`

### Validation Rules
- `summary` must be non-empty for successful outcomes and for readable fallback outcomes.
- `tokenCount` must satisfy requested token limit when max tokens are provided.
- Structured failure outcomes must include failure classification + guidance.

### Behavioral Rules
- Known unreadable/malformed inputs return structured failure outcome metadata.
- Unexpected internal faults are not encoded as structured failure; they surface as typed operation errors.

---

## 5) Stratified Sampling Descriptor Model

### Description
Metadata attached when large artifacts are summarized via beginning/middle/end sampling.

### Fields
- `samplingApplied: boolean`
- `samplingStrategy: 'stratified-begin-middle-end' | 'none'`
- `segmentCount: number`
- `segmentRanges: Array<{ startOffset: number; endOffset: number }>`
- `sampledBytesOrChars: number`

### Validation Rules
- `segmentCount = 3` when stratified sampling is applied.
- Segment ranges are ordered and non-overlapping.

### Behavioral Rules
- Large-artifact baseline uses stratified sampling before summarization.
- Sampling usage is disclosed whenever applied.

---

## 6) Explorer Family Output Models

### 6.1 TypeScript Exploration Shape
- `declarations`: major classes/functions/interfaces/types
- `imports`: top-level module dependencies
- `exports`: exported symbols

### 6.2 Python Exploration Shape
- `declarations`: classes/functions
- `imports`: module imports and from-imports
- `entrypoints`: common execution markers (if present)

### 6.3 JSON Exploration Shape
- `rootType`: object/array/value
- `keyHierarchy`: nested key paths
- `containerPatterns`: array/object patterns and depth

### 6.4 Markdown Exploration Shape
- `headingHierarchy`: ordered heading tree
- `sections`: section summaries/outlines
- `documentStats`: heading count/section count

### 6.5 Fallback Exploration Shape
- `contentKind`: text/binary/readability hints
- `preview`: deterministic preview extraction
- `guidance`: recommended next step when unsupported/malformed

### Validation Rules
- Family-specific metadata may extend base metadata but must not remove required base keys.

---

## 7) Failure Handling Model

### Description
Maps exploration problems into structured failure outcomes vs operation-level exceptions.

### Known Structured Failure Classes
- `unsupported-readable`
- `unsupported-unreadable`
- `malformed-structured`

### Unexpected Fault Class
- Internal execution faults (parser crash, unexpected adapter/runtime exception)

### Behavioral Rules
- Known classes => structured outcome in normal response shape.
- Unexpected faults => typed application error (`ArtifactExplorationFailedError` path).

---

## 8) Relationship Map

- One exploration request -> many `ExplorerCandidateSignal` records -> one `ExplorerResolutionDecision`.
- `ExplorerResolutionDecision` + artifact content -> one `ExplorationOutcome`.
- `InputClassification` is present in every `ExplorationOutcome` metadata.
- For large artifacts, `StratifiedSamplingDescriptor` augments outcome metadata.
- `FailureHandlingModel` determines whether result is structured payload or exception path.

---

## 9) Requirement Mapping Matrix

- FR-001, FR-002, FR-003 -> Sections 2, 4, 6
- FR-004, FR-004a -> Sections 1, 2
- FR-005, FR-006, FR-007 -> Section 6
- FR-008 -> Sections 4, 6.5
- FR-009, FR-009a, FR-009b -> Section 4
- FR-010 -> Sections 4, 5
- FR-010a -> Section 5
- FR-011 -> Sections 2, 4, 7
- FR-012, FR-012a, FR-012b, FR-012c -> Sections 3, 4, 7
- FR-013 -> Sections 1, 2, 8

---

## 10) Out-of-Scope Guardrails

- No port signature changes in `ExplorerPort` / `ExplorerRegistryPort` / `ExploreArtifactOutput`.
- No persistence schema changes for this feature.
- No framework-specific runtime integration changes beyond existing SDK wiring.
