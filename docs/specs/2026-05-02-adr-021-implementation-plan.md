# ADR-021 Implementation Plan — Phases 2–9

**Date:** 2026-05-02
**Status:** Pre-implementation — settles per-phase scope before PR work begins
**Scope:** Detailed plan for migrating each producer to emit `Finding[]` per ADR-021
**ADRs:** [ADR-021](../adr/ADR-021-findings-and-fix-strategy-ssot.md) (this plan); [ADR-022](../adr/ADR-022-fix-strategy-and-cycle.md) (companion)
**Tracking:** [#867](https://github.com/nathapp-io/nax/issues/867)
**Phase 1 PR:** [#868](https://github.com/nathapp-io/nax/pull/868)

---

## 1. Overview

Phase 1 (the wire-format types) shipped on PR #868. This plan covers phases 2–9 — the producer migrations and final cleanup.

**Migration model: fold-per-producer.** Each phase is a single PR that migrates one producer AND its direct consumers in lock-step. No additive-emission interval; no `Finding[]` arrays floating unused.

**Order (lowest risk first):**

| Phase | Producer | Risk | Flag? |
|:---|:---|:---|:---|
| 2 | Plugin reviewer adapter | low | none |
| 3 | Lint (Biome JSON, ESLint JSON, text) | medium | none |
| 4 | Typecheck (tsc) | medium | none |
| 5 | TDD verifier / AC parser | low | none |
| 6 | Adversarial review | high | none (rename absorbed by `normalizeSeverity`) |
| 7 | Semantic review | high | none |
| 8 | Acceptance diagnose | medium-high | `acceptance.fix.findingsV2` (default off, soak 1 release) |
| 9 | Cleanup | zero | n/a |

Phases 2–7 are unblocked from each other. Phase 8 depends on phase 5 (AC sentinel reuse). Phase 9 requires all preceding phases done plus ADR-022 consumer migrations done.

## 2. Cross-phase concerns

### 2.1 Severity rename strategy (`"warn"` → `"warning"`)

**Producer side (3 prompt schemas to edit):**
- [src/prompts/builders/adversarial-review-builder.ts:206](../../src/prompts/builders/adversarial-review-builder.ts#L206) — `OUTPUT_SCHEMA` block
- Same file, severity guide text describing `"warn"` semantics
- [src/prompts/builders/review-builder.ts](../../src/prompts/builders/review-builder.ts) — `SEMANTIC_OUTPUT_SCHEMA` block

**Read side (already handled — no change needed):**
- [src/review/adversarial-helpers.ts:56-62](../../src/review/adversarial-helpers.ts#L56) `normalizeSeverity()` — `"warn"` → `"warning"`
- [src/review/semantic-helpers.ts:55](../../src/review/semantic-helpers.ts#L55) — same
- [src/review/dialogue.ts](../../src/review/dialogue.ts) — same

The `normalizeSeverity` adapters already accept legacy `"warn"` and emit `"warning"`. Rename in prompt schema is forward-only — LLMs producing legacy `"warn"` continue to parse correctly via the adapter. No flag required; the rename is safe across all releases.

Lands during phases 6 (adversarial) and 7 (semantic), in the same PR as the producer migration.

### 2.2 File path normalisation

Per ADR-021 §3, every `Finding.file` is **relative to nax's workdir**. Each producer adapter does the rebasing at its boundary:

| Producer | Native format | Rebase rule |
|:---|:---|:---|
| Biome JSON | `cwd`-relative | `path.relative(workdir, path.resolve(cwd, file))` |
| `tsc --pretty=false` | absolute | `path.relative(workdir, file)` |
| `LlmReviewFinding` | LLM-emitted | already workdir-relative per prompt instruction; no rebase needed; validate at parse |
| `ReviewFinding` (plugin) | workdir-relative | direct (already conformant) |
| `acceptanceDiagnoseOp` | LLM-emitted | already workdir-relative per prompt instruction |

Helper to add in phase 2 (used by every adapter from phase 3 onward):

```typescript
// src/findings/path-utils.ts
export function rebaseToWorkdir(rawPath: string, cwd: string, workdir: string): string {
  if (rawPath.startsWith("/")) return path.relative(workdir, rawPath);
  return path.relative(workdir, path.resolve(cwd, rawPath));
}
```

### 2.3 Audit trail for soak phases

Phase 8 ships behind a flag with shadow-mode comparison. The audit format:

```typescript
// .nax/findings-shadow/<storyId>/<timestamp>.json
{
  "phase": "acceptance.fix.findingsV2",
  "legacyResult": { testIssues: string[], sourceIssues: string[], verdict: ... },
  "newResult":    { findings: Finding[], verdict: ... },
  "divergence":   { /* field-by-field diff */ }
}
```

Audit lives under `.nax/findings-shadow/` so it's gitignored alongside other run artefacts. Disable via `acceptance.fix.findingsAuditEnabled: false` after one release of green soak.

### 2.4 Test data plumbing

Each phase that touches LLM ops needs fixture updates:

- `test/fixtures/llm-output/` if it exists, else create.
- Each phase's PR includes both the legacy LLM output (still accepted by the adapter) and a sample new-shape output asserting parse correctness.

### 2.5 Helper imports

All phases import from the existing barrel:

```typescript
import type { Finding, FindingSeverity, FindingSource, FixTarget } from "src/findings";
import { compareSeverity, findingKey, SEVERITY_ORDER } from "src/findings";
```

No internal-path imports per [.claude/rules/project-conventions.md](../../.claude/rules/project-conventions.md).

---

## 3. Phase 2 — Plugin reviewer adapter

**Goal:** Internal nax converts `ReviewFinding[]` (plugin contract) → `Finding[]` at the IReviewPlugin call site. Plugin contract stays stable.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/path-utils.ts` (new) | Add `rebaseToWorkdir()` helper (used by phases 3+) |
| `src/findings/adapters/plugin.ts` (new) | `pluginToFinding(rf: ReviewFinding, workdir: string): Finding` |
| `src/findings/index.ts` | Re-export `pluginToFinding`, `rebaseToWorkdir` |
| [src/review/orchestrator.ts:378-420](../../src/review/orchestrator.ts#L378) | Convert plugin output via `pluginToFinding()`; store as `Finding[]` internally |
| [src/review/types.ts:98](../../src/review/types.ts#L98) | `PluginReviewerResult.findings?` becomes `Finding[]` (was `ReviewFinding[]`) |
| `src/pipeline/stages/review.ts` | Update audit serialiser to emit `Finding[]` shape |
| `test/integration/review/review-plugin-integration.test.ts:74-140` | Assert plugin findings convert correctly |

### Adapter shape

```typescript
// src/findings/adapters/plugin.ts
export function pluginToFinding(rf: ReviewFinding, workdir: string): Finding {
  return {
    source: "plugin",
    tool: rf.source,            // plugin's tool name (semgrep, eslint, snyk, ...)
    severity: rf.severity,      // "critical" | "error" | "warning" | "info" | "low" — already aligned
    category: rf.category ?? "general",
    rule: rf.ruleId,
    file: rf.file,              // plugin contract is workdir-relative — no rebasing
    line: rf.line,
    column: rf.column,
    endLine: rf.endLine,
    endColumn: rf.endColumn,
    message: rf.message,
    meta: rf.url ? { url: rf.url } : undefined,
  };
}
```

### Tests

- New: `test/unit/findings/adapters/plugin.test.ts` — round-trip conversion, optional fields, severity passthrough.
- Update: `review-plugin-integration.test.ts` — assert `pluginCalled` still works AND `result.pluginReviewers[*].findings` is now `Finding[]`.

### Validation gate

- `bun run typecheck` passes
- `bun run test test/unit/findings/ test/integration/review/` passes
- `bun run build` succeeds
- Hand-run: plugin reviewer fixture from existing tests; verify audit output is valid JSON

### Rollback

`git revert` of the PR. Plugin contract was never exposed — no external consumers.

### PR commit message template

```
feat(findings): plugin reviewer adapter (ADR-021 phase 2)

Convert ReviewFinding -> Finding at the IReviewPlugin call site.
Plugin contract unchanged.

Refs: #867
```

---

## 4. Phase 3 — Lint

**Goal:** Lint output (Biome JSON, ESLint JSON, text) emits `Finding[]`. Scope-split routing reads `Finding[]`.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/adapters/lint.ts` (new) | `lintDiagnosticToFinding(d: LintDiagnostic, workdir, cwd, tool): Finding` |
| `src/findings/index.ts` | Re-export `lintDiagnosticToFinding` |
| [src/review/lint-parsing/parse.ts:14-23](../../src/review/lint-parsing/parse.ts#L14) | `parseLintOutput()` returns `LintParseResult` extended with `findings: Finding[]` |
| [src/pipeline/stages/autofix-scope-split.ts:82-130](../../src/pipeline/stages/autofix-scope-split.ts#L82) | `splitByOutputParsing()` for lint reads `Finding[]` and partitions by `fixTarget` |
| `src/review/lint-parsing/strategies/{eslint,biome,text}.ts` | Each strategy emits `Finding[]` directly |
| New: `test/unit/findings/adapters/lint.test.ts` | Per-strategy conversion tests |

### Adapter shape

```typescript
// src/findings/adapters/lint.ts
export function lintDiagnosticToFinding(
  d: LintDiagnostic,
  workdir: string,
  cwd: string,
  tool: "biome" | "eslint" | "text"
): Finding {
  return {
    source: "lint",
    tool,
    severity: d.severity,
    category: d.category ?? "lint",
    rule: d.ruleId,
    file: rebaseToWorkdir(d.file, cwd, workdir),
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    suggestion: d.fix ?? undefined,
    fixTarget: undefined, // derived by cycle layer from file vs testFilePatterns
  };
}
```

### `splitByOutputParsing` rewrite

Old behaviour: parse output → bucket diagnostics by file path against `testFilePatterns` → rebuild `ReviewCheckResult` per scope.

New behaviour: parse output → `Finding[]` → partition by `(fixTarget ?? deriveFixTarget(finding.file, testFilePatterns))` → group into `{testFindings, sourceFindings}: Finding[][]`.

```typescript
function splitFindingsByFixTarget(
  findings: Finding[],
  testFilePatterns: TestFilePattern[]
): { testFindings: Finding[]; sourceFindings: Finding[] } {
  const test: Finding[] = [];
  const source: Finding[] = [];
  for (const f of findings) {
    const target = f.fixTarget ?? (f.file && isTestFile(f.file, testFilePatterns) ? "test" : "source");
    (target === "test" ? test : source).push(f);
  }
  return { testFindings: test, sourceFindings: source };
}
```

### Tests

- Per strategy: parse fixture → assert `Finding[]` shape (file paths workdir-relative, severity normalised, rule preserved).
- `splitByOutputParsing` partitioning: mixed source+test findings → both buckets non-empty; all-source → testFindings empty; all-test → sourceFindings empty.
- Existing autofix integration tests pass without modification (return shape preserved at the `ReviewCheckResult` boundary; `findings: Finding[]` is the only internal change).

### Validation gate

- `bun run typecheck` passes
- All lint-parsing unit tests pass
- All autofix integration tests pass
- Hand-run: real Biome lint failure on a fixture; verify scope-split correctness

### Risk mitigation

The scope-split routing is hot — every lint failure goes through it. Mitigation:
- Unit tests cover all three lint strategies (Biome, ESLint, text).
- Integration test in `test/integration/autofix/` exercising end-to-end: lint failure → scope-split → implementer / test-writer routing.

### Rollback

`git revert`. The internal `findings: Finding[]` field is the only addition; old `output: string` remains for backward compatibility during this phase.

---

## 5. Phase 4 — Typecheck

**Goal:** tsc output emits `Finding[]`. Same shape change as lint.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/adapters/typecheck.ts` (new) | `tscDiagnosticToFinding(d: TypecheckDiagnostic, workdir): Finding` |
| `src/findings/index.ts` | Re-export `tscDiagnosticToFinding` |
| [src/review/typecheck-parsing/parse.ts:12-24](../../src/review/typecheck-parsing/parse.ts#L12) | `parseTypecheckOutput()` returns `TypecheckParseResult` extended with `findings: Finding[]` |
| [src/pipeline/stages/autofix-scope-split.ts:132-150](../../src/pipeline/stages/autofix-scope-split.ts#L132) | `splitByTypecheckOutputParsing()` reads `Finding[]` |
| `src/review/typecheck-parsing/strategies/tsc.ts` | Emits `Finding[]` |
| New: `test/unit/findings/adapters/typecheck.test.ts` | Conversion tests |

### Adapter shape

```typescript
// src/findings/adapters/typecheck.ts
export function tscDiagnosticToFinding(d: TypecheckDiagnostic, workdir: string): Finding {
  return {
    source: "typecheck",
    tool: "tsc",
    severity: "error",  // tsc errors are always blocking
    category: "type-error",
    rule: `TS${d.code}`,
    file: path.relative(workdir, d.file), // tsc emits absolute paths
    line: d.line,
    column: d.column,
    message: d.message,
    fixTarget: undefined,
  };
}
```

### Tests

- `tscDiagnosticToFinding`: absolute path → workdir-relative; `TS2304` rule preserved; severity always "error".
- `splitByTypecheckOutputParsing` partitions correctly.

### Validation gate

Same as phase 3.

### Rollback

`git revert`.

---

## 6. Phase 5 — TDD verifier / AC parser

**Goal:** Test runner output (AC parsing) emits `Finding[]`. AC sentinels (`AC-HOOK`, `AC-ERROR`) become first-class findings.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/adapters/test-runner.ts` (new) | `acFailureToFinding(failedAcId, testFile, output): Finding` and `acSentinelToFinding(sentinel, output): Finding` |
| [src/test-runners/ac-parser.ts](../../src/test-runners/ac-parser.ts) | `parseAcResults()` extended to emit `Finding[]` alongside legacy AC-id strings |
| [src/pipeline/stages/acceptance.ts](../../src/pipeline/stages/acceptance.ts) | Where `"AC-ERROR"` is pushed: build a `Finding` instead and add to a parallel `findings: Finding[]` field on `ctx.acceptanceFailures` |
| `src/pipeline/types.ts` | `AcceptanceFailures` interface adds `findings: Finding[]` |
| New: `test/unit/findings/adapters/test-runner.test.ts` | Sentinel + failure conversion |

### Sentinel mapping

| Sentinel | New Finding |
|:---|:---|
| `AC-N` (a real AC failed) | `{ source: "test-runner", category: "assertion-failure", rule: "AC-N", message: <test output excerpt>, fixTarget: "source", file: <test-file>, line: <test-line if parseable> }` |
| `AC-HOOK` (lifecycle timeout) | `{ source: "test-runner", category: "hook-failure", message: "beforeAll/afterAll hook timed out", fixTarget: "test" }` |
| `AC-ERROR` (runner crashed) | `{ source: "test-runner", category: "test-runner-error", severity: "critical", message: "Test runner crashed before test bodies ran", fixTarget: "test" }` |

### Tests

- Each sentinel → correct `Finding` shape and `category`.
- Real AC failure → `rule: "AC-N"` correctly extracted.

### Validation gate

- All acceptance unit tests pass.
- Hand-run: dogfood `nax-dogfood/fixtures/hello-lint`; verify `ctx.acceptanceFailures.findings` matches `failedACs` 1:1 plus any sentinels.

### Rollback

`git revert`. Both legacy `failedACs: string[]` and new `findings: Finding[]` coexist during this phase.

---

## 7. Phase 6 — Adversarial review

**Goal:** Adversarial review emits `Finding[]`. Carry-forward cache uses `Finding[]`. Severity rename in OUTPUT_SCHEMA prompt block.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/adapters/llm-review.ts` (new) | `llmReviewFindingToFinding(lf: LlmReviewFinding, source, workdir): Finding` |
| `src/findings/index.ts` | Re-export adapter |
| [src/operations/adversarial-review.ts:67-105](../../src/operations/adversarial-review.ts#L67) | `parse()` returns `Finding[]` (was `LlmReviewFinding[]`) |
| [src/operations/adversarial-review.ts:28](../../src/operations/adversarial-review.ts#L28) | `priorAdversarialFindings?: AdversarialFindingsCache` — cache shape upgraded to `{ round: number; findings: Finding[] }` |
| [src/review/types.ts:171-182](../../src/review/types.ts#L171) | `AdversarialFindingsCache.findings: Finding[]` |
| [src/prompts/builders/adversarial-review-builder.ts:202-225](../../src/prompts/builders/adversarial-review-builder.ts#L202) | `buildPriorFindingsBlock()` reads `Finding[]` |
| [src/prompts/builders/adversarial-review-builder.ts:206](../../src/prompts/builders/adversarial-review-builder.ts#L206) | `OUTPUT_SCHEMA` rename `"warn"` → `"warning"` |
| Same file, severity guide text | rename `"warn"` → `"warning"` |
| `src/review/runner.ts`, `src/review/orchestrator.ts`, `src/review/adversarial.ts`, `src/pipeline/types.ts` | Update import sites and field types where `AdversarialFindingsCache` flows |
| New: `test/unit/findings/adapters/llm-review.test.ts` | Conversion tests including legacy `"warn"` parse path |
| Update: existing adversarial review unit/integration tests | Assert `Finding[]` shape |

### Adapter shape

```typescript
// src/findings/adapters/llm-review.ts
export function llmReviewFindingToFinding(
  lf: LlmReviewFinding,
  source: "semantic-review" | "adversarial-review",
  workdir: string  // used to validate file is workdir-relative
): Finding {
  const meta: Record<string, unknown> = {};
  if (lf.verifiedBy) meta.verifiedBy = lf.verifiedBy;
  return {
    source,
    severity: normalizeSeverity(lf.severity), // "warn" → "warning" already handled
    category: lf.category ?? (source === "semantic-review" ? "ac-coverage" : "general"),
    rule: lf.acId,                            // semantic uses AC ID; adversarial leaves undefined
    file: lf.file,
    line: lf.line,
    message: lf.issue,
    suggestion: lf.suggestion,
    fixTarget: source === "adversarial-review" && lf.category === "test-gap" ? "test" : undefined,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  };
}
```

### Severity rename impact (verified count)

[Per Explore report:](#critical-review-items) 25 `"warn"` literal occurrences. The non-prompt sites are all already `normalizeSeverity()`-handled — no behaviour change. Only the 3 prompt-builder sites (2 in adversarial-review-builder, 1 in review-builder) actively change.

### Tests

- `llmReviewFindingToFinding`: legacy `"warn"` input → `"warning"` output.
- New shape `{severity: "warning"}` → preserved.
- `verifiedBy` lands in `meta.verifiedBy`.
- `acId` lands in `rule` for semantic, `undefined` for adversarial.
- Adversarial `category: "test-gap"` → `fixTarget: "test"`.
- Carry-forward: round 2 prompt contains the verdict-first table from round 1's findings.

### Validation gate

- `bun run typecheck` passes
- All adversarial unit + integration tests pass
- Hand-run: trigger adversarial review on a fixture; observe round-2 prompt contains `Prior Adversarial Findings` block populated from `Finding[]`.

### Risk mitigation

This is the highest-risk phase pre-acceptance. Mitigations:
- The `normalizeSeverity` adapter handles legacy `"warn"` outputs — even if an LLM produces old-shape findings, parsing succeeds.
- 25-site severity-literal audit confirmed no test asserts on `"warn"` directly.
- Existing integration tests for adversarial cache carry-forward stay green.

### Rollback

`git revert`. Cache shape change is contained to one cache type; no on-disk persistence (cache lives in `PipelineContext`).

---

## 8. Phase 7 — Semantic review

**Goal:** Semantic review emits `Finding[]`. Persisted `SemanticVerdict` uses `Finding[]`. `verifiedBy` evidence preserved via `meta`.

### Files modified

| File | Change |
|:---|:---|
| [src/operations/semantic-review.ts:70-104](../../src/operations/semantic-review.ts#L70) | `parse()` returns `Finding[]` |
| [src/prompts/builders/review-builder.ts](../../src/prompts/builders/review-builder.ts) `SEMANTIC_OUTPUT_SCHEMA` | Severity rename `"warn"` → `"warning"` |
| [src/prompts/builders/review-builder.ts:186-211](../../src/prompts/builders/review-builder.ts#L186) | `buildAttemptContextBlock()` reads `Finding[]` |
| [src/acceptance/types.ts:139-150](../../src/acceptance/types.ts#L139) | `SemanticVerdict.findings: Finding[]` (was `ReviewFinding[]`) |
| [src/acceptance/semantic-verdict.ts:48-90](../../src/acceptance/semantic-verdict.ts#L48) | `persistSemanticVerdict()` and `loadSemanticVerdicts()` work with `Finding[]` shape (compatible per explore report — `Finding` is a superset of `ReviewFinding`) |
| [src/review/semantic-evidence.ts](../../src/review/semantic-evidence.ts) | `substantiateSemanticEvidence()` operates on `Finding[]`; downgrade-to-unverifiable preserved |
| Update: `test/unit/acceptance/semantic-verdict.test.ts` | Round-trip persist/load with `Finding[]` |

### Persistence compatibility

Existing semantic-verdict JSON files on disk look like:

```json
{
  "storyId": "US-001",
  "passed": false,
  "findings": [{ "ruleId": "AC-2", "severity": "error", "file": "src/foo.ts", "line": 10, "message": "..." }]
}
```

After phase 7, they look like:

```json
{
  "storyId": "US-001",
  "passed": false,
  "findings": [{ "source": "semantic-review", "rule": "AC-2", "severity": "error", "file": "src/foo.ts", "line": 10, "message": "...", "category": "ac-coverage" }]
}
```

**Backward-compat loader**: `loadSemanticVerdicts()` detects legacy shape (no `source` field on findings) and applies the `pluginToFinding`-equivalent migration in-memory. Forward writes use the new shape only. Stale-file readback works for one release.

### Tests

- `loadSemanticVerdicts()` accepts both legacy and new shapes.
- `persistSemanticVerdict()` writes new shape only.
- Round-trip: persist → load → equal `Finding[]`.
- `substantiateSemanticEvidence()`: unverified `severity: "error"` → `severity: "unverifiable"` (existing behaviour preserved).

### Validation gate

- `bun run typecheck` passes
- All semantic-related unit tests pass
- Integration test: write legacy-shape semantic verdict to disk, load via new code, verify migration

### Rollback

`git revert`. The backward-compat loader stays — no need to revert disk format.

---

## 9. Phase 8 — Acceptance diagnose

**Goal:** Acceptance diagnose op emits structured `findings: Finding[]` with `fixTarget` per item. Behind feature flag for soak.

### Files modified

| File | Change |
|:---|:---|
| `src/findings/adapters/acceptance-diagnose.ts` (new) | `acceptanceLegacyToFindings({testIssues, sourceIssues}): Finding[]` for fallback parsing |
| [src/operations/acceptance-diagnose.ts:30-68](../../src/operations/acceptance-diagnose.ts#L30) | `parse()` returns `findings: Finding[]`; legacy `string[]` shape parsed via fallback adapter |
| [src/prompts/builders/acceptance-builder.ts:171-195](../../src/prompts/builders/acceptance-builder.ts#L171) | New OUTPUT_SCHEMA when flag enabled — asks LLM for structured `findings: Finding[]` |
| [src/acceptance/types.ts:153-165](../../src/acceptance/types.ts#L153) | `DiagnosisResult.findings: Finding[]` (additive); `testIssues`/`sourceIssues` deprecated but preserved |
| [src/execution/lifecycle/acceptance-fix.ts:129-180](../../src/execution/lifecycle/acceptance-fix.ts#L129) | `applyFix()` reads `findings: Finding[]` filtered by `fixTarget` (verdict still routes when findings empty — preserves fast-paths per ADR-022) |
| [src/config/schemas.ts](../../src/config/schemas.ts) | New schema field `acceptance.fix.findingsV2: boolean` (default `false`) |
| [src/config/selectors.ts](../../src/config/selectors.ts) | Expose flag to op via `acceptanceConfigSelector` |
| New: `test/unit/findings/adapters/acceptance-diagnose.test.ts` | Legacy shape → `Finding[]` migration |
| New: `test/integration/acceptance/findings-v2.test.ts` | End-to-end flag on/off both work |

### Prompt schema diff

Legacy:

```json
{
  "verdict": "...",
  "reasoning": "...",
  "confidence": 0.0-1.0,
  "testIssues": ["...", "..."],
  "sourceIssues": ["...", "..."]
}
```

New (when flag enabled):

```json
{
  "verdict": "...",
  "reasoning": "...",
  "confidence": 0.0-1.0,
  "findings": [
    {
      "fixTarget": "source" | "test",
      "category": "stdout-capture" | "ac-mismatch" | "framework-misuse" | "missing-impl" | "import-path" | "hook-failure" | "test-runner-error" | "stub-test" | "other",
      "file": "src/greeting.ts",
      "line": 12,
      "message": "...",
      "suggestion": "..."
    }
  ]
}
```

### Fallback parser

When LLM emits the legacy shape (or partial), `parse()` calls `acceptanceLegacyToFindings()`:

```typescript
function acceptanceLegacyToFindings(
  testIssues: string[] | undefined,
  sourceIssues: string[] | undefined
): Finding[] {
  const findings: Finding[] = [];
  for (const msg of testIssues ?? []) {
    findings.push({
      source: "acceptance-diagnose",
      severity: "error",
      category: "legacy",
      message: msg,
      fixTarget: "test",
    });
  }
  for (const msg of sourceIssues ?? []) {
    findings.push({
      source: "acceptance-diagnose",
      severity: "error",
      category: "legacy",
      message: msg,
      fixTarget: "source",
    });
  }
  return findings;
}
```

### Shadow audit

When flag is enabled, the op writes a comparison artefact under `.nax/findings-shadow/<storyId>/<timestamp>.json` showing legacy vs new parse output (per §2.3). One release of green soak before flipping default.

### Verdict fast-path preservation

The diagnose fast-paths in [acceptance-fix.ts:78-116](../../src/execution/lifecycle/acceptance-fix.ts#L78) (`implement-only`, `semanticVerdicts.every(passed)`, `isTestLevelFailure`) produce `verdict` without invoking the LLM. They emit `findings: []` and `applyFix` falls through to verdict-based routing. ADR-022 phase 4 will formalise this as `appliesToVerdict` on FixStrategy. For phase 8 we just preserve current behaviour — `applyFix` checks `findings.length > 0` first, falls back to verdict.

### Tests

- `acceptanceLegacyToFindings()`: empty arrays → empty findings; mixed → correct `fixTarget` partition.
- Flag off: prompt asks for legacy schema; parse returns legacy shape; behaviour unchanged.
- Flag on, LLM returns new shape: parsed correctly.
- Flag on, LLM returns legacy shape: fallback parser invoked; same result.
- Fast-path verdicts (`implement-only`, etc.): findings empty, verdict drives routing.
- AC-HOOK / AC-ERROR sentinels appear as `Finding` entries (depends on phase 5).

### Validation gate

- `bun run typecheck` passes
- All acceptance unit + integration tests pass
- Dogfood `nax-dogfood/fixtures/hello-lint` with flag on: verify diagnose prompt audit contains structured findings; verify `applyFix` routes correctly.
- Shadow audit: one release of green soak before flag flip.

### Risk mitigation

- Feature flag default off — zero behavioural change in production.
- Legacy fallback parser handles all old LLM outputs.
- Verdict fast-paths preserved verbatim.
- Shadow comparison artefact catches divergence in CI dogfood.

### Rollback

Flag flip back to off. No code revert needed.

### Flag flip plan

Two PRs after phase 8 lands:
1. After 1 release green soak: change default to `true`.
2. After 1 more release: delete the flag and the legacy parser; old fallback adapter goes to ADR-022 phase 4 cleanup.

---

## 10. Phase 9 — Cleanup

**Goal:** Delete legacy types now that no consumers reference them.

### Prerequisites

- All ADR-021 phases 2–8 merged
- All ADR-022 consumer migrations merged (cycle, prior-iterations builder, acceptance migration)
- `acceptance.fix.findingsV2` flag flipped to default `true` and stable for one release

### Files modified

| File | Change |
|:---|:---|
| [src/operations/types.ts:171-191](../../src/operations/types.ts#L171) | Delete `LlmReviewFinding` interface |
| [src/operations/types.ts:204-210](../../src/operations/types.ts#L204) | Update `parseLlmReviewShape()` signature to return `Finding` |
| [src/review/types.ts:171-182](../../src/review/types.ts#L171) | Delete `AdversarialFindingsCache` shape; replace with `type AdversarialFindingsCache = { round: number; findings: Finding[] }` (or fold into `Iteration` per ADR-022) |
| [src/acceptance/types.ts:153-165](../../src/acceptance/types.ts#L153) | Delete `DiagnosisResult.testIssues / sourceIssues` fields |
| [src/operations/index.ts](../../src/operations/index.ts) | Remove `LlmReviewFinding` export |
| Various consumer files | Update import statements; remove fallback adapters; remove `acceptance.fix.findingsV2` flag plumbing |
| [src/prompts/builders/acceptance-builder.ts](../../src/prompts/builders/acceptance-builder.ts) | Remove legacy OUTPUT_SCHEMA branch |
| `test/**/*.test.ts` | Delete tests asserting on legacy field shapes |

### Validation gate

- `bun run typecheck` passes (all references resolve to `Finding` / `Finding[]`)
- Full test suite passes
- `git grep "LlmReviewFinding\|testIssues\|sourceIssues" -- 'src/'` returns nothing
- Build artefact size unchanged or smaller

### Rollback

`git revert`. Cleanup is purely deletion + import cleanup — no semantic change.

---

## 11. Cross-cutting checklist

Before merging each PR:

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Pre-commit hooks pass (process.cwd, adapter-wrap, dispatch-context)
- [ ] All new code has `storyId` as first key in logger calls (per [.claude/rules/project-conventions.md](../../.claude/rules/project-conventions.md))
- [ ] No `process.cwd()` outside CLI entry points
- [ ] File path SSOT: `Finding.file` workdir-relative everywhere
- [ ] Severity normalised via `normalizeSeverity()` at parse boundary
- [ ] No internal-path imports — barrel only
- [ ] PR refs `#867`
- [ ] Adapter has unit tests under `test/unit/findings/adapters/`

## 12. Tracking

| Phase | PR | Status | Notes |
|:---|:---|:---|:---|
| 1 | #868 | open | Wire-format types + helpers |
| 2 | tbd | not started | Plugin adapter |
| 3 | tbd | not started | Lint |
| 4 | tbd | not started | Typecheck |
| 5 | tbd | not started | TDD verifier / AC parser |
| 6 | tbd | not started | Adversarial + severity rename |
| 7 | tbd | not started | Semantic + persistence migration |
| 8 | tbd | not started | Acceptance diagnose (flagged) |
| 9 | tbd | not started | Cleanup (gated on ADR-022) |

## 13. References

- [ADR-021](../adr/ADR-021-findings-and-fix-strategy-ssot.md) — Finding type SSOT (this plan implements its phase 2+)
- [ADR-022](../adr/ADR-022-fix-strategy-and-cycle.md) — Fix Strategy + Cycle Orchestration (companion; phases 4 onward of ADR-022 consume `Finding[]` from this plan)
- [Issue #867](https://github.com/nathapp-io/nax/issues/867) — umbrella tracker
- Phase-1 PR [#868](https://github.com/nathapp-io/nax/pull/868) — wire-format types
- [src/findings/](../../src/findings/) — types module
- [.claude/rules/monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md) — workdir / packageDir conventions
- [.claude/rules/forbidden-patterns.md](../../.claude/rules/forbidden-patterns.md) — Prompt builder convention
