# ADR-021: Finding Type SSOT

**Status:** Proposed
**Date:** 2026-05-02
**Author:** William Khoo, Claude
**Supersedes:** —
**Related:** ADR-022 (Fix Strategy + Cycle Orchestration — companion ADR built on this type)

---

## Context

Five subsystems each carry their own "thing that's wrong" type:

| Subsystem | Type | Defined at |
|:---|:---|:---|
| Plugin reviewers | `ReviewFinding` | [src/plugins/extensions.ts:20](../../src/plugins/extensions.ts#L20) |
| LLM reviewers (semantic, adversarial) | `LlmReviewFinding` | [src/operations/types.ts:171](../../src/operations/types.ts#L171) |
| Adversarial review carry-forward | `AdversarialFindingsCache.findings[]` | [src/review/types.ts:171](../../src/review/types.ts#L171) |
| Semantic review verdict | `SemanticVerdict.findings: ReviewFinding[]` | [src/acceptance/types.ts:139](../../src/acceptance/types.ts#L139) |
| Acceptance diagnosis | `DiagnosisResult.{testIssues, sourceIssues}: string[]` | [src/acceptance/types.ts:153](../../src/acceptance/types.ts#L153) |

The shapes are siblings — same fields with different names — and the unstructured `string[]` in acceptance carries no category, no file/line, no fixTarget. This blocks structured prior-attempt history (the falsified-hypothesis pattern that adversarial review already uses) and prevents cross-stage finding aggregation.

ADR-021's scope is **types only**. The orchestration questions (cycle, strategies, validator coupling, verdict fast-paths) are deliberately deferred to ADR-022 because they require design decisions that can be made independently of the wire format.

## Decision

### 1. Single `Finding` type

```typescript
type FindingSource =
  | "lint"
  | "typecheck"
  | "test-runner"
  | "semantic-review"
  | "adversarial-review"
  | "acceptance-diagnose"
  | "tdd-verifier"
  | "plugin";

type FindingSeverity = "critical" | "error" | "warning" | "info" | "low" | "unverifiable";

type FixTarget = "source" | "test";

type DiagnosisCategory =
  | "stdout-capture"
  | "ac-mismatch"
  | "framework-misuse"
  | "missing-impl"
  | "import-path"
  | "hook-failure"          // AC-HOOK sentinel — beforeAll / afterAll timeout
  | "test-runner-error"     // AC-ERROR sentinel — runner crashed before test bodies ran
  | "stub-test"             // detected stub via isStubTestFile heuristic
  | "other";

interface Finding {
  source: FindingSource;
  tool?: string;                       // "biome" | "tsc" | "semgrep" | …
  severity: FindingSeverity;
  category: string;                    // free-form; per-source enum documented at producer
  rule?: string;                       // biome rule id, TS code, AC id, etc.
  file?: string;                       // ALWAYS repoRoot-relative — see §3
  line?: number; column?: number; endLine?: number; endColumn?: number;
  message: string;
  suggestion?: string;
  confidence?: number;                 // LLM producers only
  fixTarget?: "source" | "test";       // optional; consumers derive from file when unset
  meta?: Record<string, unknown>;      // producer-specific extras
}
```

### 2. Severity standardises on `"warning"`

Adversarial review's prompt schema currently emits `"warn"`. Migration is one schema change in [adversarial-review-builder.ts:128](../../src/prompts/builders/adversarial-review-builder.ts#L128). The read path is already covered by `normalizeSeverity()` adapters in [src/review/semantic-helpers.ts:55](../../src/review/semantic-helpers.ts#L55), [src/review/adversarial-helpers.ts](../../src/review/adversarial-helpers.ts), and [src/review/dialogue.ts](../../src/review/dialogue.ts) which already accept `"warn"` and emit `"warning"`. The downgrade-to-unverifiable path in [src/review/semantic-evidence.ts:101](../../src/review/semantic-evidence.ts#L101) is unaffected.

`"unverifiable"` is preserved (adversarial-only today). `"low"` is preserved for plugin compatibility.

### 3. File path SSOT — repoRoot-relative

Every `Finding.file` is **relative to the repo root** (the directory containing `.nax/`). Not workdir-relative, not packageDir-relative, not absolute.

Rationale:
- The autofix routing layer in [splitFindingsByScope](../../src/pipeline/stages/autofix-scope-split.ts#L158) and [isTestFile](../../src/test-runners/) already operates on repoRoot-relative paths.
- Cross-package finding aggregation (the long-term goal) requires a single repo-anchored coordinate system.
- Tools that natively emit workdir-relative paths (biome, tsc, plugin reviewers) get one rebasing step at their adapter boundary — not scattered across consumers.

Producer adapters are responsible for normalisation:

| Producer | Native format | Adapter rebases to |
|:---|:---|:---|
| Biome JSON output | `cwd`-relative | `path.relative(repoRoot, resolve(cwd, file))` |
| `tsc` `--pretty=false` | absolute | `path.relative(repoRoot, file)` |
| `LlmReviewFinding` | LLM-emitted, often packageDir-relative | adapter resolves against story's `packageDir`, then rebases |
| `ReviewFinding` (plugin) | workdir-relative per contract | `path.relative(repoRoot, resolve(workdir, file))` |
| Acceptance diagnose | LLM-emitted; new prompt schema instructs repoRoot-relative explicitly | direct |

The plugin contract (`ReviewFinding.file: workdir-relative`) is unchanged — only the internal `Finding` representation is normalised. Plugin authors are unaffected.

### 4. Absorption table — existing types map cleanly

| Source field | Target | Adapter rule |
|:---|:---|:---|
| `LlmReviewFinding.issue` | `Finding.message` | rename |
| `LlmReviewFinding.acId` | `Finding.rule` | rename (semantic only) |
| `LlmReviewFinding.verifiedBy` | `Finding.meta.verifiedBy` | demote |
| `LlmReviewFinding.severity: "warn"` | `Finding.severity: "warning"` | rename via `normalizeSeverity` (already exists) |
| `AdversarialFindingsCache.findings[].issue` | `Finding.message` | rename |
| `AdversarialFindingsCache.findings[].severity: "warn"` | `Finding.severity: "warning"` | rename |
| `ReviewFinding.ruleId` | `Finding.rule` | rename |
| `ReviewFinding.source` (tool name) | `Finding.tool` | rename; top-level `source` becomes `"plugin"` |
| `ReviewFinding.url` | `Finding.meta.url` | demote |
| `DiagnosisResult.testIssues: string[]` | `Finding[]` with `fixTarget: "test"` | LLM prompt schema change (see §6) |
| `DiagnosisResult.sourceIssues: string[]` | `Finding[]` with `fixTarget: "source"` | LLM prompt schema change |

### 5. Acceptance sentinels become first-class findings

`AC-HOOK` and `AC-ERROR` sentinels in [acceptance-loop.ts:90](../../src/execution/lifecycle/acceptance-loop.ts#L90) are currently special-cased in `failedACs: string[]`. They become `Finding[]` entries:

```typescript
{ source: "acceptance-diagnose", category: "hook-failure", severity: "error", message: "beforeAll timed out (8000ms)", file: <test-file>, fixTarget: "test" }
{ source: "acceptance-diagnose", category: "test-runner-error", severity: "critical", message: "Bun test runner crashed before test bodies ran", fixTarget: "test" }
```

The orchestration layer (ADR-022) decides how to route these — that's deferred. Phase 2 of this ADR only requires producers to emit them as findings.

### 6. Acceptance diagnose prompt schema change

`acceptanceDiagnoseOp` ([src/operations/acceptance-diagnose.ts](../../src/operations/acceptance-diagnose.ts)) currently asks the LLM for `testIssues: string[]` and `sourceIssues: string[]`. The new schema asks for `findings: Finding[]` with `fixTarget` per item:

```json
{
  "verdict": "source_bug" | "test_bug" | "both",
  "reasoning": "...",
  "confidence": 0.0–1.0,
  "findings": [
    {
      "fixTarget": "source" | "test",
      "category": "stdout-capture" | "ac-mismatch" | …,
      "file": "src/greeting.ts",
      "line": 12,
      "message": "...",
      "suggestion": "..."
    }
  ]
}
```

The legacy `testIssues` / `sourceIssues` fields stay parseable for one release as a fallback (parser checks `findings` first; if absent, wraps each string as `Finding{ category: "legacy", message: <string> }` with `fixTarget` from which array it came from). `verdict` stays in the schema — see ADR-022 for why (fast-paths can produce a verdict without findings).

Schema change ships behind `acceptance.fix.findingsV2` config flag, default off, for one release. Bench against `nax-dogfood/fixtures/hello-lint` audit fixtures with both modes.

## Phased implementation

| Phase | Files | Scope | Risk |
|:---|:---|:---|:---|
| **1. Types** | new `src/findings/{types,index}.ts` | `Finding`, enums, no consumers | zero |
| **2. Producer adapters — mechanical** | `src/quality/lint-output-parser.ts`, typecheck parser | Emit `Finding[]` alongside existing return shape (additive, non-breaking) | low |
| **3. Producer adapters — LLM** | `src/operations/{semantic-review,adversarial-review,acceptance-diagnose}.ts` | Same — additive emission | medium (acceptance prompt schema, behind flag) |
| **4. Severity rename** | adversarial prompt schema | One-line rename in OUTPUT_SCHEMA block | low |
| **5. File-path normalisation** | each producer adapter | `path.relative(repoRoot, …)` at the boundary | low |
| **6. Cleanup** | delete `LlmReviewFinding`, `AdversarialFindingsCache`, `DiagnosisResult.{testIssues,sourceIssues}` | After ADR-022's consumers migrate | zero |

Phases 1–5 ship without ADR-022. Phase 6 is gated on ADR-022 phase completion.

## Consequences

### Positive

- Producers emit a single shape; cross-stage aggregation becomes trivial.
- Acceptance sentinels (`AC-HOOK`, `AC-ERROR`) become structured — orchestration in ADR-022 can route them like any other finding.
- The severity rename (`"warn"` → `"warning"`) is much smaller than initially estimated thanks to existing `normalizeSeverity` adapters.
- File-path SSOT decision unblocks cross-package finding aggregation (issue-level reporting, dashboards).

### Negative

- Producers each gain a thin adapter at their boundary. ~6 adapters total, ~30 lines each.
- The acceptance diagnose prompt schema change requires a soak period and a feature flag.

### Neutral

- Plugin contract (`ReviewFinding`) is preserved as-is. Internal normalisation happens at the adapter boundary.

## What this ADR explicitly does not decide

- How findings are consumed by fix orchestration (cycle / strategies / validator coupling) — see ADR-022.
- Whether `verdict` stays on `DiagnosisResult` or is derived — see ADR-022.
- How prior attempts are carried forward in prompts (`buildPriorIterationsBlock`) — see ADR-022.
- How `stubRegenCount` and acceptance fast-paths integrate with strategies — see ADR-022.

This split lets the type migration ship and bake while orchestration design iterates.

## References

- [src/plugins/extensions.ts:20](../../src/plugins/extensions.ts#L20) — `ReviewFinding` (plugin contract; preserved as-is)
- [src/operations/types.ts:171](../../src/operations/types.ts#L171) — `LlmReviewFinding` (deprecated by phase 6)
- [src/review/types.ts:171](../../src/review/types.ts#L171) — `AdversarialFindingsCache` (deprecated by phase 6)
- [src/acceptance/types.ts:153](../../src/acceptance/types.ts#L153) — `DiagnosisResult` (legacy fields deprecated by phase 6)
- [src/review/semantic-helpers.ts:55](../../src/review/semantic-helpers.ts#L55) — `normalizeSeverity` (read-path adapter for severity rename)
- ADR-022 — Fix Strategy + Cycle Orchestration (companion ADR)
